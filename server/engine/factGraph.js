/**
 * The fact graph. Observations in, comparable nodes out.
 *
 * A node is one cell of claimed reality: "revenue, FY2025-26, actual". Every observation
 * that lands on the same node is a statement about the same thing, so the rules can compare
 * them by arithmetic alone. Getting the grouping right is what makes the rules simple - and
 * getting it wrong is what produces false mismatches, so the key composition below is the
 * most safety-critical decision in the engine.
 *
 * node_key = metric_key | period_key | basis_class | currency_scope | subject
 *
 * Why each component is there:
 *   metric_key      obvious - revenue and EBITDA are not the same claim
 *   period_key      FY25 revenue vs FY26 revenue is growth, not a discrepancy
 *   basis_class     audited actuals vs projections is a forecast, not a conflict. R4 handles
 *                   that boundary deliberately; R1 must never see across it.
 *   currency_scope  'ANCHOR' when every currency on the node can be converted, so USD and
 *                   INR observations meet and get compared. The raw currency code when a
 *                   rate is missing, which keeps them apart and lets the rule report
 *                   `currency_mismatch` instead of comparing 5.2 to 3.2 as if both were INR.
 *   subject         who the number is about, for metrics that repeat per entity. Only
 *                   ownership uses it today. Without it, every row of a cap table becomes a
 *                   competing claim about one number and R1 reports the founder's 60%
 *                   conflicting with an investor's 25%.
 */

const rulepack = require('./rulepack.json');
const { buildFxTable, resolveNodeCurrency, BASE_CURRENCY } = require('./canonicalize/currency');
const { isComparable, sortKey, canonicalizePeriod } = require('./canonicalize/period');
const { unitOf, labelOf } = require('../services/normalization/taxonomyMap');

/**
 * @param {Array} observations  canonical observations from canonicalize/
 * @param {object} options      { fxRates, documents }
 * @returns {object} fact graph
 */
function buildFactGraph(observations, options = {}) {
  const fxTable = buildFxTable(options.fxRates || {});
  const nodes = new Map();

  for (const obs of observations) {
    const key = nodeKeyFor(obs, fxTable);
    obs.node_key = key;

    if (!nodes.has(key)) {
      nodes.set(key, {
        node_key: key,
        metric_key: obs.metric_key,
        metric_label: labelOf(obs.metric_key),
        unit: obs.unit || unitOf(obs.metric_key),
        period_key: obs.period_key,
        period_granularity: obs.period_granularity,
        basis_class: obs.basis_class,
        subject: obs.subject || null,
        observations: []
      });
    }
    nodes.get(key).observations.push(obs);
  }

  // Derive per-node comparison data.
  for (const node of nodes.values()) {
    Object.assign(node, deriveNode(node, fxTable));
  }

  const nodeList = [...nodes.values()];

  return {
    nodes: nodeList,
    byKey: nodes,
    fx_table: fxTable,
    scale_anchor: computeScaleAnchor(nodeList),
    index: buildIndex(nodeList),
    stats: {
      observation_count: observations.length,
      node_count: nodeList.length,
      multi_source_nodes: nodeList.filter(n => n.distinct_source_docs >= 2).length,
      blocked_nodes: nodeList.filter(n => n.blocked_reason).length
    }
  };
}

function nodeKeyFor(obs, fxTable) {
  const currencyScope = currencyScopeFor(obs, fxTable);
  return [
    obs.metric_key,
    obs.period_key,
    obs.basis_class,
    currencyScope,
    obs.subject || '-'
  ].join('|');
}

/**
 * 'ANCHOR' if this observation can be converted into the base currency, otherwise its own
 * currency code - which isolates it and blocks comparison rather than guessing a rate.
 */
function currencyScopeFor(obs, fxTable) {
  if (obs.unit !== 'currency') return 'NA';
  const cur = (obs.currency || BASE_CURRENCY).toUpperCase();
  if (cur === BASE_CURRENCY) return 'ANCHOR';
  return fxTable.rates[`${cur}_${BASE_CURRENCY}`] ? 'ANCHOR' : cur;
}

/**
 * Compute everything the rules need to know about a node without touching observations again.
 */
function deriveNode(node, fxTable) {
  const resolved = resolveNodeCurrency(node.observations, fxTable);

  if (!resolved.ok) {
    return {
      values: [],
      consensus_value: null,
      min: null,
      max: null,
      spread_abs: null,
      spread_pct: null,
      outliers: [],
      distinct_source_docs: countDistinct(node.observations, o => o.document_id),
      distinct_categories: countDistinct(node.observations, o => o.document_category),
      crossed_currency: resolved.crossed_currency,
      fx_applied: [],
      currencies: resolved.currencies,
      blocked_reason: resolved.blocked_reason,
      node_confidence: minConfidence(node.observations),
      sort_key: sortKey(canonicalizePeriod(node.period_key))
    };
  }

  const enriched = node.observations.map(obs => {
    const match = resolved.values.find(v => v.observation_id === obs.observation_id);
    return { observation: obs, value_anchor: match ? match.value_anchor : null };
  }).filter(e => e.value_anchor !== null);

  const values = enriched.map(e => e.value_anchor);
  const consensus = weightedMedian(enriched);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spreadAbs = max - min;

  // Spread is measured against the consensus, not the min. Measuring against the min makes
  // the number explode toward infinity as the smaller value approaches zero, which would
  // hand a near-zero-value pair a catastrophic severity for a trivial absolute gap.
  const denom = Math.abs(consensus);
  const spreadPct = denom > 0 ? (spreadAbs / denom) * 100 : (spreadAbs === 0 ? 0 : null);

  return {
    values: enriched.map(e => ({
      observation_id: e.observation.observation_id,
      document_id: e.observation.document_id,
      filename: e.observation.filename,
      document_category: e.observation.document_category,
      value_base: e.observation.value_base,
      value_anchor: e.value_anchor,
      currency: e.observation.currency,
      page: e.observation.source.page,
      quote: e.observation.source.quote,
      confidence: combinedConfidence(e.observation)
    })),
    consensus_value: consensus,
    min,
    max,
    spread_abs: spreadAbs,
    spread_pct: spreadPct,
    outliers: findOutliers(enriched, consensus),
    distinct_source_docs: countDistinct(node.observations, o => o.document_id),
    distinct_categories: countDistinct(node.observations, o => o.document_category),
    crossed_currency: resolved.crossed_currency,
    fx_applied: resolved.fx_applied,
    currencies: resolved.currencies,
    blocked_reason: null,
    node_confidence: minConfidence(node.observations),
    sort_key: sortKey(canonicalizePeriod(node.period_key))
  };
}

/**
 * Confidence-weighted median.
 *
 * Median rather than mean because three documents agreeing on 3.2 and one claiming 52 should
 * produce a consensus of 3.2, not 15.4. A mean lets a single outlier - often a scale-parsing
 * error - drag the reference value that every severity calculation is measured against.
 */
function weightedMedian(enriched) {
  if (enriched.length === 0) return null;
  if (enriched.length === 1) return enriched[0].value_anchor;

  const sorted = [...enriched].sort((a, b) => a.value_anchor - b.value_anchor);
  const weights = sorted.map(e => Math.max(0.01, combinedConfidence(e.observation)));
  const total = weights.reduce((a, b) => a + b, 0);

  let cumulative = 0;
  for (let i = 0; i < sorted.length; i++) {
    cumulative += weights[i];
    if (cumulative >= total / 2) return sorted[i].value_anchor;
  }
  return sorted[sorted.length - 1].value_anchor;
}

/**
 * Which observations sit outside tolerance of the consensus.
 *
 * Used by the corroboration factor: one dissenter among four is a likely typo and gets a
 * severity discount, two against two is a real standoff and gets a premium.
 */
function findOutliers(enriched, consensus) {
  if (consensus === null || enriched.length < 2) return [];

  const metricKey = enriched[0].observation.metric_key;
  const tol = toleranceFor(metricKey, enriched[0].observation.unit);
  const denom = Math.abs(consensus);

  return enriched
    .filter(e => {
      if (tol.type === 'pp') return Math.abs(e.value_anchor - consensus) > tol.value;
      if (denom === 0) return e.value_anchor !== consensus;
      return (Math.abs(e.value_anchor - consensus) / denom) * 100 > tol.value;
    })
    .map(e => ({
      observation_id: e.observation.observation_id,
      filename: e.observation.filename,
      document_category: e.observation.document_category,
      value_anchor: e.value_anchor,
      deviation_pct: denom > 0 ? ((e.value_anchor - consensus) / denom) * 100 : null
    }));
}

/**
 * Tolerance for a metric.
 *
 * Percentage metrics are compared in percentage POINTS, not relative percent. A margin
 * moving 38% -> 40% is a 2pp change; calling that a "5% variance" and testing it against a
 * 2% relative tolerance would flag every rounding difference in every deck.
 */
function toleranceFor(metricKey, unit) {
  const pp = rulepack.tolerances.percentage_point_metrics[metricKey];
  if (pp !== undefined) return { type: 'pp', value: pp };

  const byMetric = rulepack.tolerances.by_metric[metricKey];
  if (byMetric !== undefined) return { type: 'pct', value: byMetric };

  if (unit === 'pct') return { type: 'pp', value: 0.5 };
  return { type: 'pct', value: rulepack.tolerances.default_pct };
}

function combinedConfidence(obs) {
  const c = obs.confidence;
  return c.value * c.label * c.period * c.parse;
}

function minConfidence(observations) {
  return observations.reduce((min, o) => Math.min(min, combinedConfidence(o)), 1);
}

function countDistinct(items, fn) {
  return new Set(items.map(fn).filter(Boolean)).size;
}

/**
 * The company's own scale, used by the materiality factor.
 *
 * Anchored on the largest actual revenue node, falling back to any revenue, then to the
 * largest currency figure present. Without an anchor, a Rs 30 lakh gap looks identical at a
 * seed-stage company and a listed one - it should be catastrophic at the first and rounding
 * error at the second.
 */
function computeScaleAnchor(nodes) {
  const revenueKeys = ['revenue', 'arr'];

  const actualRevenue = nodes.filter(n =>
    revenueKeys.includes(n.metric_key) && n.basis_class === 'actual' && n.consensus_value
  );
  if (actualRevenue.length > 0) {
    return {
      value: Math.max(...actualRevenue.map(n => Math.abs(n.consensus_value))),
      basis: 'actual_revenue'
    };
  }

  const anyRevenue = nodes.filter(n => revenueKeys.includes(n.metric_key) && n.consensus_value);
  if (anyRevenue.length > 0) {
    return {
      value: Math.max(...anyRevenue.map(n => Math.abs(n.consensus_value))),
      basis: 'projected_revenue'
    };
  }

  const anyCurrency = nodes.filter(n => n.unit === 'currency' && n.consensus_value);
  if (anyCurrency.length > 0) {
    return {
      value: Math.max(...anyCurrency.map(n => Math.abs(n.consensus_value))),
      basis: 'largest_currency_figure'
    };
  }

  return { value: null, basis: 'none' };
}

/** Lookup helpers the rules use constantly. */
function buildIndex(nodes) {
  const byMetric = new Map();
  const byMetricPeriodBasis = new Map();
  const byPeriod = new Map();

  for (const node of nodes) {
    push(byMetric, node.metric_key, node);
    push(byMetricPeriodBasis, `${node.metric_key}|${node.period_key}|${node.basis_class}`, node);
    push(byPeriod, node.period_key, node);
  }

  return {
    /** All nodes for a metric, any period. */
    metric: key => byMetric.get(key) || [],
    /**
     * The single node for a metric in one period and basis.
     *
     * Returns null when more than one exists. That happens for subject-bearing metrics like
     * ownership, where a period legitimately holds one node per shareholder - and an
     * accounting identity that silently picked "the first shareholder" would be nonsense.
     * Callers that want the whole set ask for `all()` instead.
     */
    one: (metricKey, periodKey, basisClass) => {
      const hits = byMetricPeriodBasis.get(`${metricKey}|${periodKey}|${basisClass}`) || [];
      return hits.length === 1 ? hits[0] : null;
    },
    /** Every node for a metric in one period and basis. One per subject, where subjects exist. */
    all: (metricKey, periodKey, basisClass) =>
      byMetricPeriodBasis.get(`${metricKey}|${periodKey}|${basisClass}`) || [],
    /** All nodes in a period. */
    period: key => byPeriod.get(key) || [],
    /** Every period key present, chronologically where resolvable. */
    periods: () => [...byPeriod.keys()]
      .filter(isComparable)
      .sort((a, b) => (sortKey(canonicalizePeriod(a)) || 0) - (sortKey(canonicalizePeriod(b)) || 0))
  };
}

function push(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

module.exports = {
  buildFactGraph,
  toleranceFor,
  combinedConfidence,
  weightedMedian,
  computeScaleAnchor,
  nodeKeyFor
};
