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
        const finding = checkIdentity(identity, graph, periodKey, basisClass);
        if (finding) findings.push(finding);
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

function checkIdentity(identity, graph, periodKey, basisClass) {
  const resolve = metricKey => graph.index.one(metricKey, periodKey, basisClass);

  const resultNode = resolve(identity.result);
  if (!resultNode || resultNode.consensus_value === null) return null;

  const parts = gatherOperands(identity, resolve);
  if (!parts) return null;

  const computed = evaluate(identity, parts);
  if (computed === null || !Number.isFinite(computed)) return null;

  const stated = resultNode.consensus_value;
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
    ...parts.flatMap(p => p.node.observations),
    ...resultNode.observations
  ];

  const unit = identity.unit === 'currency' ? 'currency' : identity.unit;
  const currency = resultNode.observations[0] ? resultNode.observations[0].currency : 'INR';

  const computation = {
    expression: identity.expression,
    substituted: buildSubstitution(identity, parts, computed, stated, unit, currency),
    stated,
    computed,
    delta_abs: deltaAbs,
    delta_pct: dPct,
    result: withinTolerance ? 'PASS' : 'FAIL',
    blocked_reason: blockedReason(parts, resultNode),
    single_document: isSingleDocument(observations)
  };

  if (usePp) {
    computation.tolerance_abs = identity.tolerance_abs;
  } else {
    computation.tolerance_pct = identity.tolerance_pct;
  }

  return makeFinding({
    rule_id: `R2.${identity.id}`,
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
      // Which operand is the most likely culprit: the one whose own value is closest to
      // explaining the whole gap if it were wrong. Turns "the P&L doesn't add up" into
      // "COGS looks like the problem".
      likely_culprit: likelyCulprit(identity, parts, deltaAbs),
      operands: parts.map(p => ({
        metric_key: p.metric_key,
        sign: p.sign,
        value: p.node.consensus_value,
        sources: p.node.distinct_source_docs
      })),
      documents_involved: [...new Set(observations.map(o => o.filename))]
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
    return parts.reduce((sum, p) =>
      p.sign === '-' ? sum - p.node.consensus_value : sum + p.node.consensus_value, 0);
  }

  if (identity.type === 'ratio') {
    const numerator = parts[0].node.consensus_value;
    const denominator = parts[1].node.consensus_value;
    if (denominator === 0) return null; // Undefined, not a failure. Skip silently.
    return (numerator / denominator) * (identity.scale || 1);
  }

  if (identity.type === 'product') {
    return parts[0].node.consensus_value * identity.factor;
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
      .map((p, i) => (i === 0 ? f(p.node.consensus_value) : `${p.sign} ${f(p.node.consensus_value)}`))
      .join(' ');
  } else if (identity.type === 'ratio') {
    const scale = identity.scale && identity.scale !== 1 ? ` x ${identity.scale}` : '';
    lhs = `${fmt(parts[0].node.consensus_value, operandUnit(identity.numerator), currency)} / ${fmt(parts[1].node.consensus_value, operandUnit(identity.denominator), currency)}${scale}`;
  } else {
    lhs = `${f(parts[0].node.consensus_value)} x ${identity.factor}`;
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
    const magnitude = Math.abs(p.node.consensus_value);
    if (magnitude === 0) continue;
    const relativeImpact = gap / magnitude;
    if (best === null || relativeImpact < best.relative_impact) {
      best = {
        metric_key: p.metric_key,
        value: p.node.consensus_value,
        relative_impact: relativeImpact,
        would_need_to_be: p.sign === '-'
          ? p.node.consensus_value - deltaAbs
          : p.node.consensus_value + deltaAbs
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
function blockedReason(parts, resultNode) {
  const allNodes = [...parts.map(p => p.node), resultNode];

  if (allNodes.some(n => n.blocked_reason)) return 'currency_mismatch';

  const currencies = new Set(
    allNodes.flatMap(n => n.observations.map(o => o.currency).filter(Boolean))
  );
  if (currencies.size > 1) return 'currency_mismatch';

  return null;
}

/** Did this identity fail inside a single document? That is the headline case. */
function isSingleDocument(observations) {
  return new Set(observations.map(o => o.document_id)).size === 1;
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
