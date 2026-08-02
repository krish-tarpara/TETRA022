/**
 * R2 - Accounting identities.
 *
 * These are arithmetic laws, not opinions. `revenue - cogs = gross_profit` is true in every
 * company in every jurisdiction in every currency. When a document states all three numbers
 * and they don't reconcile, that is a proof of error, and the finding can show its working:
 *
 *   revenue - cogs = gross_profit
 *   52,000,000 - 31,000,000 = 21,000,000   stated: 24,000,000   gap: 14.29%
 *
 * Two properties make this the most valuable rule in the pack:
 *
 *   1. It is undeniable. There is no "the AI thinks these don't match" - it is subtraction.
 *      A judge can verify it mentally.
 *   2. It fires on a SINGLE document. A deck that contradicts itself is caught with nothing
 *      else uploaded. Every "AI document comparison" tool needs two documents before it can
 *      say anything at all; this needs one.
 *
 * The identity table lives in rulepack.json as data, so this engine is generic - adding
 * `assets = liabilities + equity` is a config edit, not a code change.
 */

const rulepack = require('../rulepack.json');
const { makeFinding, deltaPct } = require('../finding');
const { formatAmount } = require('../canonicalize/currency');
const { unitOf } = require('../../services/normalization/taxonomyMap');

function run(graph) {
  const findings = [];

  for (const identity of rulepack.identities) {
    // Some identities exist only to derive a value for R6 to sanity-check, and should never
    // be reported as a failure themselves (revenue_per_employee is nobody's stated figure).
    if (identity.derive_only) continue;

    for (const periodKey of allPeriods(graph)) {
      for (const basisClass of ['actual', 'forward']) {
        findings.push(...checkIdentity(identity, graph, periodKey, basisClass));
      }
    }
  }

  return findings;
}

/**
 * Every period present in the graph, including ones only some metrics appear in.
 * Unresolved periods are skipped: checking an identity across numbers whose periods we could
 * not read would compare FY25 revenue against FY26 COGS and call the company a liar.
 */
function allPeriods(graph) {
  return [...new Set(graph.nodes.map(n => n.period_key))].filter(p => p && p !== 'UNKNOWN');
}

/**
 * Check one identity for one period and basis.
 *
 * Prefers to check the identity WITHIN a single document, and only falls back to comparing
 * across documents when no single document states all the terms.
 *
 * This distinction is not cosmetic. Suppose the financial statements internally reconcile
 * (revenue 3.2, COGS 2.0, gross profit 1.2) while the deck claims a gross profit of 1.5.
 * Blending the two into a consensus and testing that would report an arithmetic failure that
 * NEITHER document actually commits - the real problem there is a cross-document conflict,
 * which is R1's job. Checking per document keeps each rule reporting the thing it can prove.
 *
 * It also produces the stronger finding: "this document contradicts itself" is a far better
 * headline than "these numbers don't reconcile once blended".
 *
 * @returns {Array} zero or more findings - one per document that states all the terms
 */
function checkIdentity(identity, graph, periodKey, basisClass) {
  const resolve = metricKey => graph.index.one(metricKey, periodKey, basisClass);

  const resultNode = resolve(identity.result);
  if (!resultNode || resultNode.consensus_value === null) return [];

  const parts = gatherOperands(identity, resolve);
  if (!parts) return [];

  const allNodes = [...parts.map(p => p.node), resultNode];
  const selfContained = documentsWithAllTerms(allNodes);

  if (selfContained.length > 0) {
    return selfContained
      .map(documentId => evaluateFor(identity, graph, periodKey, basisClass, parts, resultNode, documentId))
      .filter(Boolean);
  }

  // No single document has every term, so the identity can only be tested by combining
  // documents. Still worth doing - a P&L split across a deck and a statement pack is common -
  // but flagged so the narrative says so rather than accusing one document of self-contradiction.
  const finding = evaluateFor(identity, graph, periodKey, basisClass, parts, resultNode, null);
  return finding ? [finding] : [];
}

/** Documents that state every term of the identity, so it can be checked without blending. */
function documentsWithAllTerms(nodes) {
  if (nodes.length === 0) return [];

  const docSets = nodes.map(n => new Set(n.observations.map(o => o.document_id)));
  const [first, ...rest] = docSets;

  return [...first].filter(docId => rest.every(set => set.has(docId)));
}

/**
 * Value a specific document gives for a node, or the cross-document consensus when documentId
 * is null. Median when one document states the same figure more than once.
 */
function valueFor(node, documentId) {
  if (documentId === null) return node.consensus_value;

  const values = node.observations
    .filter(o => o.document_id === documentId && o.value_base !== null)
    .map(o => o.value_base)
    .sort((a, b) => a - b);

  if (values.length === 0) return null;
  return values[Math.floor((values.length - 1) / 2)];
}

/** Observations belonging to one document, or all of them for the cross-document case. */
function observationsFor(node, documentId) {
  if (documentId === null) return node.observations;
  return node.observations.filter(o => o.document_id === documentId);
}

function evaluateFor(identity, graph, periodKey, basisClass, parts, resultNode, documentId) {
  const scopedParts = parts.map(p => ({ ...p, value: valueFor(p.node, documentId) }));
  if (scopedParts.some(p => p.value === null)) return null;

  const stated = valueFor(resultNode, documentId);
  if (stated === null) return null;

  const computed = evaluate(identity, scopedParts);
  if (computed === null || !Number.isFinite(computed)) return null;

  const deltaAbs = stated - computed;

  // Percentage-unit identities (margins) are tested in percentage points; currency ones
  // relatively. A 0.2pp margin tolerance and a 0.2% margin tolerance are different tests.
  const usePp = identity.tolerance_abs !== undefined;
  const dPct = deltaPct(stated, computed);
  const dAbs = Math.abs(deltaAbs);

  const withinTolerance = usePp
    ? dAbs <= identity.tolerance_abs
    : dPct <= identity.tolerance_pct;

  const observations = [
    ...scopedParts.flatMap(p => observationsFor(p.node, documentId)),
    ...observationsFor(resultNode, documentId)
  ];

  if (observations.length === 0) return null;

  const unit = identity.unit === 'currency' ? 'currency' : identity.unit;
  const currency = observations[0].currency || 'INR';

  const computation = {
    expression: identity.expression,
    substituted: buildSubstitution(identity, scopedParts, computed, stated, unit, currency),
    stated,
    computed,
    delta_abs: deltaAbs,
    delta_pct: dPct,
    result: withinTolerance ? 'PASS' : 'FAIL',
    blocked_reason: blockedReason(scopedParts, resultNode, documentId),
    // True when every term came from one document, which makes the finding a proof of internal
    // self-contradiction rather than a disagreement between sources.
    single_document: documentId !== null
  };

  if (usePp) {
    computation.tolerance_abs = identity.tolerance_abs;
  } else {
    computation.tolerance_pct = identity.tolerance_pct;
  }

  const filenames = [...new Set(observations.map(o => o.filename))];

  return makeFinding({
    // Distinct rule_id per document, so two documents each failing the same identity produce
    // two findings rather than colliding in the duplicate filter.
    rule_id: documentId === null ? `R2.${identity.id}.combined` : `R2.${identity.id}`,
    rule_class: 'R2',
    metric_key: identity.result,
    period_key: periodKey,
    node: resultNode,
    graph,
    observations,
    computation,
    extra: {
      identity_id: identity.id,
      basis_class: basisClass,
      scope: documentId === null ? 'across_documents' : 'within_document',
      // Which operand is the most likely culprit: the one whose own value is closest to
      // explaining the whole gap if it were wrong. Turns "the P&L doesn't add up" into
      // "COGS looks like the problem".
      likely_culprit: likelyCulprit(identity, scopedParts, deltaAbs),
      operands: scopedParts.map(p => ({
        metric_key: p.metric_key,
        sign: p.sign,
        value: p.value,
        sources: p.node.distinct_source_docs
      })),
      documents_involved: filenames
    }
  });
}

/** Collect every operand the identity needs. Returns null if any is absent. */
function gatherOperands(identity, resolve) {
  const wanted = operandKeys(identity);
  const parts = [];

  for (const { metric_key, sign } of wanted) {
    const node = resolve(metric_key);
    if (!node || node.consensus_value === null) return null;
    parts.push({ metric_key, sign, node });
  }

  return parts;
}

function operandKeys(identity) {
  if (identity.type === 'linear') {
    return identity.terms.map(([sign, metric_key]) => ({ metric_key, sign }));
  }
  if (identity.type === 'ratio') {
    return [
      { metric_key: identity.numerator, sign: '+' },
      { metric_key: identity.denominator, sign: '/' }
    ];
  }
  if (identity.type === 'product') {
    return [{ metric_key: identity.operand, sign: '*' }];
  }
  return [];
}

function evaluate(identity, parts) {
  if (identity.type === 'linear') {
    return parts.reduce((sum, p) => (p.sign === '-' ? sum - p.value : sum + p.value), 0);
  }

  if (identity.type === 'ratio') {
    const numerator = parts[0].value;
    const denominator = parts[1].value;
    if (denominator === 0) return null; // Undefined, not a failure. Skip silently.
    return (numerator / denominator) * (identity.scale || 1);
  }

  if (identity.type === 'product') {
    return parts[0].value * identity.factor;
  }

  return null;
}

/**
 * The substitution string. This is the single most important field in the entire report -
 * it is what turns a claim into a proof the reader can check without trusting us.
 */
function buildSubstitution(identity, parts, computed, stated, unit, currency) {
  const f = v => fmt(v, unit, currency);

  let lhs;
  if (identity.type === 'linear') {
    lhs = parts
      .map((p, i) => (i === 0 ? f(p.value) : `${p.sign} ${f(p.value)}`))
      .join(' ');
  } else if (identity.type === 'ratio') {
    const scale = identity.scale && identity.scale !== 1 ? ` x ${identity.scale}` : '';
    lhs = `${fmt(parts[0].value, operandUnit(identity.numerator), currency)} / ${fmt(parts[1].value, operandUnit(identity.denominator), currency)}${scale}`;
  } else {
    lhs = `${f(parts[0].value)} x ${identity.factor}`;
  }

  return `${lhs} = ${f(computed)}   [document states ${f(stated)}]`;
}

function operandUnit(metricKey) {
  return unitOf(metricKey) || 'currency';
}

/**
 * If exactly one operand were wrong, which one would it be?
 *
 * Reported as a hint, never as a verdict - the engine cannot know which number is the
 * mistaken one, only that the set is inconsistent. But naming the operand whose magnitude is
 * closest to the gap turns an unactionable finding into a specific question.
 */
function likelyCulprit(identity, parts, deltaAbs) {
  if (identity.type !== 'linear' || parts.length === 0) return null;

  const gap = Math.abs(deltaAbs);
  let best = null;

  for (const p of parts) {
    const magnitude = Math.abs(p.value);
    if (magnitude === 0) continue;
    const relativeImpact = gap / magnitude;
    if (best === null || relativeImpact < best.relative_impact) {
      best = {
        metric_key: p.metric_key,
        value: p.value,
        relative_impact: relativeImpact,
        would_need_to_be: p.sign === '-' ? p.value - deltaAbs : p.value + deltaAbs
      };
    }
  }

  return best;
}

/**
 * Ambiguity that makes the arithmetic untrustworthy.
 *
 * Mixed currencies inside one identity is the dangerous case: adding a USD COGS to an INR
 * revenue produces a guaranteed "failure" that says nothing about the company. Better to
 * report it as unresolved than to accuse.
 */
function blockedReason(parts, resultNode, documentId) {
  const allNodes = [...parts.map(p => p.node), resultNode];

  if (allNodes.some(n => n.blocked_reason)) return 'currency_mismatch';

  // Only the observations actually used in this evaluation matter. When checking within one
  // document, another document reporting the same metric in USD is irrelevant.
  const currencies = new Set(
    allNodes.flatMap(n => observationsFor(n, documentId).map(o => o.currency).filter(Boolean))
  );
  if (currencies.size > 1) return 'currency_mismatch';

  return null;
}

function fmt(value, unit, currency) {
  if (value === null || value === undefined) return '-';
  if (unit === 'pct') return `${round(value, 2)}%`;
  if (unit === 'count') return Math.round(value).toLocaleString('en-IN');
  if (unit === 'months') return `${round(value, 1)} months`;
  if (unit === 'ratio') return `${round(value, 2)}x`;
  return formatAmount(value, currency || 'INR');
}

function round(n, places) {
  if (!Number.isFinite(n)) return n;
  const f = Math.pow(10, places);
  return Math.round(n * f) / f;
}

module.exports = { run, RULE_CLASS: 'R2' };
