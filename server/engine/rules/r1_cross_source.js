/**
 * R1 - Cross-source value conflict.
 *
 * Two or more documents describe the same metric, period and basis, and they disagree.
 * This is the rule everyone expects from a document-comparison tool, and the fact graph has
 * already done the hard part: any node with two source documents is by construction a set of
 * statements about the same thing, so the rule itself is a subtraction and a tolerance test.
 *
 * What R1 deliberately does NOT do:
 *   - compare across periods (that's growth)
 *   - compare actuals against projections (that's R4)
 *   - compare across currencies without a supplied rate (that's blocked, and reported as such)
 *
 * Nodes that agree produce VERIFIED_CONSISTENT findings rather than nothing. Positive
 * confirmations are half of what makes the report credible - a report that only lists problems
 * gives an investor no idea how much was actually checked.
 */

const { makeFinding } = require('../finding');
const { toleranceFor } = require('../factGraph');
const { formatAmount } = require('../canonicalize/currency');

function run(graph) {
  const findings = [];

  for (const node of graph.nodes) {
    // A single document cannot conflict with itself here. Self-contradiction within one
    // document is R2's job, via the accounting identities.
    if (node.distinct_source_docs < 2) continue;

    if (node.blocked_reason) {
      findings.push(blockedFinding(node, graph));
      continue;
    }

    findings.push(comparisonFinding(node, graph));
  }

  return findings;
}

/**
 * The comparison could not be performed. Almost always a missing FX rate.
 *
 * Reported as a finding rather than skipped silently: "we found two numbers for FY26 revenue
 * and could not compare them because one is in USD and you gave us no rate" is useful
 * information, and hiding it would let a real conflict disappear from the report entirely.
 */
function blockedFinding(node, graph) {
  const observations = node.observations;
  const values = observations
    .map(o => `${o.filename}: ${o.value_raw}${o.currency ? ` (${o.currency})` : ''}`)
    .join('  vs  ');

  return makeFinding({
    rule_id: `R1.blocked.${node.blocked_reason}`,
    rule_class: 'R1',
    metric_key: node.metric_key,
    period_key: node.period_key,
    node,
    graph,
    observations,
    crossed_currency: node.crossed_currency,
    computation: {
      expression: `${node.metric_key} @ ${node.period_key}: comparison blocked`,
      substituted: values,
      stated: null,
      computed: null,
      delta_abs: null,
      delta_pct: null,
      tolerance_pct: null,
      result: 'BLOCKED',
      blocked_reason: node.blocked_reason
    },
    extra: {
      currencies: node.currencies,
      source_count: node.distinct_source_docs,
      remedy: node.blocked_reason === 'currency_mismatch'
        ? `Supply an FX rate for ${node.currencies.filter(c => c !== 'INR').join(', ')} to enable this comparison.`
        : null
    }
  });
}

/** The normal path: subtract, test against tolerance, report either way. */
function comparisonFinding(node, graph) {
  const tol = toleranceFor(node.metric_key, node.unit);

  // Percentage metrics are compared in percentage points. A margin moving 38 -> 40 is a 2pp
  // change; expressing that as a 5% relative variance and testing it against a relative
  // tolerance is how tools end up either screaming at rounding or missing real drift.
  const usePp = tol.type === 'pp';
  const deltaAbs = node.spread_abs;
  const deltaPct = node.spread_pct;

  const sorted = [...node.values].sort((a, b) => b.value_anchor - a.value_anchor);
  const high = sorted[0];
  const low = sorted[sorted.length - 1];

  const substituted = usePp
    ? `${high.filename}: ${fmt(high.value_anchor, node.unit)} vs ${low.filename}: ${fmt(low.value_anchor, node.unit)}  ->  gap ${round(deltaAbs, 2)}pp`
    : `${high.filename}: ${fmt(high.value_anchor, node.unit, high.currency)} vs ${low.filename}: ${fmt(low.value_anchor, node.unit, low.currency)}  ->  gap ${round(deltaPct, 2)}%`;

  const computation = {
    expression: `${node.metric_key} @ ${node.period_key} agrees across ${node.distinct_source_docs} documents`,
    substituted: withFxNote(substituted, node),
    stated: high.value_anchor,
    computed: low.value_anchor,
    consensus: node.consensus_value,
    delta_abs: deltaAbs,
    delta_pct: deltaPct,
    result: null,
    blocked_reason: null,
    fx_applied: node.fx_applied.length > 0 ? node.fx_applied : undefined
  };

  if (usePp) {
    computation.tolerance_abs = tol.value;
  } else {
    computation.tolerance_pct = tol.value;
  }

  const withinTolerance = usePp ? deltaAbs <= tol.value : (deltaPct !== null && deltaPct <= tol.value);
  computation.result = withinTolerance ? 'PASS' : 'FAIL';

  return makeFinding({
    rule_id: `R1.cross_source.${node.metric_key}`,
    rule_class: 'R1',
    metric_key: node.metric_key,
    period_key: node.period_key,
    node,
    graph,
    observations: node.observations,
    crossed_currency: node.crossed_currency,
    computation,
    extra: {
      source_count: node.distinct_source_docs,
      category_count: node.distinct_categories,
      outliers: node.outliers,
      sources: node.values.map(v => ({
        filename: v.filename,
        category: v.document_category,
        page: v.page,
        value_raw: v.value_base,
        value_anchor: v.value_anchor
      }))
    }
  });
}

/**
 * Make the FX assumption visible inside the substitution string itself.
 *
 * If a mismatch only exists because of the rate we chose, the finding has to say so on its
 * face - not in a tooltip. We own that assumption; the company shouldn't be blamed for it.
 */
function withFxNote(substituted, node) {
  if (!node.fx_applied || node.fx_applied.length === 0) return substituted;
  const rates = [...new Set(node.fx_applied.map(f => `${f.pair} @ ${f.rate}`))].join(', ');
  return `${substituted}   [converted using ${rates}]`;
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

module.exports = { run, RULE_CLASS: 'R1' };
