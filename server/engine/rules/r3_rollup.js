/**
 * R3 - Aggregation roll-up.
 *
 * Twelve monthly revenue figures should add up to the annual figure. Four quarters should add
 * up to the year. When they don't, someone edited one number and forgot the other - the most
 * common real error in a founder-maintained MIS.
 *
 * This rule is easy to get catastrophically wrong, and the guards below are most of the file:
 *
 *   1. STOCK vs FLOW. Revenue accumulates over a period, so twelve months of it sum to a
 *      year. A cash balance does NOT - it is a snapshot. Summing twelve monthly closing cash
 *      balances produces a number twelve times too large and a guaranteed false accusation.
 *      Only metrics listed in rulepack.rollups are ever summed.
 *
 *   2. COMPLETENESS. Eight of twelve months present means the sum is missing a third of the
 *      year. Comparing that against the annual total would fail every single time. If any
 *      component is absent, the rule does not fire at all - a coverage gap is R5's business,
 *      not a fake arithmetic error.
 *
 *   3. DOUBLE REPORTING. If monthly, quarterly and annual figures all exist, one underlying
 *      error would be reported three times. The rule picks the most informative single level
 *      per target period.
 *
 * Reporting the wrong thing loudly is worse than reporting nothing, so every guard fails
 * closed: when in doubt, stay silent.
 */

const rulepack = require('../rulepack.json');
const { makeFinding } = require('../finding');
const { formatAmount } = require('../canonicalize/currency');
const {
  canonicalizePeriod, monthsOfFy, quartersOfFy, monthsOfQuarter, fyLabel
} = require('../canonicalize/period');

function run(graph) {
  const candidates = [];

  for (const spec of rulepack.rollups) {
    for (const metricKey of spec.metrics) {
      for (const basisClass of ['actual', 'forward']) {
        candidates.push(...checkSpec(spec, metricKey, basisClass, graph));
      }
    }
  }

  return dedupe(candidates);
}

function checkSpec(spec, metricKey, basisClass, graph) {
  const findings = [];

  if (spec.granularity_to === 'fy') {
    for (const fyStartYear of fiscalYearsIn(graph)) {
      const target = graph.index.one(metricKey, fyLabel(fyStartYear), basisClass);
      if (!target) continue;

      const componentKeys = spec.granularity_from === 'month'
        ? monthsOfFy(fyStartYear)
        : quartersOfFy(fyStartYear);

      const finding = compare(spec, metricKey, basisClass, target, componentKeys, graph);
      if (finding) findings.push(finding);
    }
    return findings;
  }

  if (spec.granularity_to === 'quarter') {
    for (const fyStartYear of fiscalYearsIn(graph)) {
      for (let quarter = 1; quarter <= 4; quarter++) {
        const target = graph.index.one(metricKey, `Q${quarter}-${fyLabel(fyStartYear)}`, basisClass);
        if (!target) continue;

        const finding = compare(
          spec, metricKey, basisClass, target,
          monthsOfQuarter(fyStartYear, quarter), graph
        );
        if (finding) findings.push(finding);
      }
    }
  }

  return findings;
}

/**
 * Sum the components and compare against the stated total.
 *
 * Returns null - silently - whenever the comparison would be untrustworthy. That is the
 * normal outcome for most metric/period combinations, and it is deliberate.
 */
function compare(spec, metricKey, basisClass, target, componentKeys, graph) {
  const components = [];

  for (const periodKey of componentKeys) {
    const node = graph.index.one(metricKey, periodKey, basisClass);

    // Guard 2: any missing component makes the sum meaningless. Bail entirely.
    if (!node || node.consensus_value === null) return null;

    // A blocked node (usually an un-convertible currency) cannot be added to anything.
    if (node.blocked_reason) return null;

    components.push(node);
  }

  if (components.length === 0) return null;
  if (target.consensus_value === null || target.blocked_reason) return null;

  // Mixed currencies across the components would sum rupees onto dollars.
  const currencies = new Set(
    [...components, target].flatMap(n => n.observations.map(o => o.currency).filter(Boolean))
  );
  if (currencies.size > 1) {
    return blockedFinding(spec, metricKey, basisClass, target, components, graph, 'currency_mismatch');
  }

  const sum = components.reduce((total, n) => total + n.consensus_value, 0);
  const stated = target.consensus_value;
  const deltaAbs = stated - sum;
  const denom = Math.max(Math.abs(stated), Math.abs(sum));
  const deltaPct = denom === 0 ? 0 : (Math.abs(deltaAbs) / denom) * 100;

  const within = deltaPct <= spec.tolerance_pct;
  const currency = target.observations[0] ? target.observations[0].currency : 'INR';

  const observations = [...components.flatMap(n => n.observations), ...target.observations];

  return makeFinding({
    rule_id: `R3.${spec.id}.${metricKey}`,
    rule_class: 'R3',
    metric_key: metricKey,
    period_key: target.period_key,
    node: target,
    graph,
    observations,
    computation: {
      expression: `sum of ${components.length} ${spec.granularity_from}ly ${metricKey} = ${spec.granularity_to === 'fy' ? 'annual' : 'quarterly'} ${metricKey}`,
      substituted: `${components.length} components sum to ${fmt(sum, target.unit, currency)}   [document states ${fmt(stated, target.unit, currency)}]`,
      stated,
      computed: sum,
      delta_abs: deltaAbs,
      delta_pct: deltaPct,
      tolerance_pct: spec.tolerance_pct,
      result: within ? 'PASS' : 'FAIL',
      blocked_reason: null
    },
    extra: {
      rollup_id: spec.id,
      basis_class: basisClass,
      granularity_from: spec.granularity_from,
      granularity_to: spec.granularity_to,
      component_count: components.length,
      target_period: target.period_key,
      components: components.map(n => ({
        period_key: n.period_key,
        value: n.consensus_value,
        sources: n.distinct_source_docs
      })),
      likely_culprit: likelyCulprit(components, deltaAbs)
    }
  });
}

function blockedFinding(spec, metricKey, basisClass, target, components, graph, reason) {
  const observations = [...components.flatMap(n => n.observations), ...target.observations];

  return makeFinding({
    rule_id: `R3.${spec.id}.${metricKey}.blocked`,
    rule_class: 'R3',
    metric_key: metricKey,
    period_key: target.period_key,
    node: target,
    graph,
    observations,
    computation: {
      expression: `sum of ${spec.granularity_from}ly ${metricKey} = ${metricKey} @ ${target.period_key}`,
      substituted: 'Components are stated in more than one currency, so they cannot be summed.',
      stated: target.consensus_value,
      computed: null,
      delta_abs: null,
      delta_pct: null,
      tolerance_pct: spec.tolerance_pct,
      result: 'BLOCKED',
      blocked_reason: reason
    },
    extra: { rollup_id: spec.id, basis_class: basisClass, target_period: target.period_key }
  });
}

/**
 * Which single component, if mis-stated, would explain the gap?
 *
 * Picks the one closest in magnitude to the gap itself - a Rs 5 lakh discrepancy is far more
 * likely to be a wrong Rs 6 lakh month than a wrong Rs 2 Cr month. A hint, never a verdict.
 */
function likelyCulprit(components, deltaAbs) {
  const gap = Math.abs(deltaAbs);
  if (gap === 0) return null;

  let best = null;
  for (const node of components) {
    const distance = Math.abs(Math.abs(node.consensus_value) - gap);
    if (best === null || distance < best.distance) {
      best = {
        period_key: node.period_key,
        value: node.consensus_value,
        distance,
        would_need_to_be: node.consensus_value + deltaAbs
      };
    }
  }

  if (!best) return null;
  return {
    period_key: best.period_key,
    value: best.value,
    would_need_to_be: best.would_need_to_be
  };
}

/**
 * Guard 3: one error, one finding.
 *
 * With monthly, quarterly and annual data all present, an annual total that is wrong shows up
 * as both a failed monthly-to-annual sum and a failed quarterly-to-annual sum. Same error,
 * reported twice, in the same pillar - which would also double its weight on the score.
 *
 * Keeps the quarterly route when both target a fiscal year, because "Q3 is the odd quarter"
 * is more useful to a reader than "one of twelve months is wrong". Monthly-to-quarterly
 * survives independently: it targets a different period and answers a different question.
 */
function dedupe(findings) {
  const byTarget = new Map();

  for (const finding of findings) {
    const key = `${finding.metric_key}|${finding.details.target_period}|${finding.details.basis_class}`;
    const existing = byTarget.get(key);

    if (!existing) {
      byTarget.set(key, finding);
      continue;
    }

    byTarget.set(key, preferred(existing, finding));
  }

  return [...byTarget.values()];
}

function preferred(a, b) {
  // A real failure always beats a pass - the pass came from a coarser view that happened to
  // net out, and hiding the failure would be the wrong way round.
  const aFailed = a.computation.result === 'FAIL';
  const bFailed = b.computation.result === 'FAIL';
  if (aFailed !== bFailed) return aFailed ? a : b;

  // Both failed or both passed: prefer the quarterly route, which localises the problem.
  const aQuarterly = a.details.granularity_from === 'quarter';
  const bQuarterly = b.details.granularity_from === 'quarter';
  if (aQuarterly !== bQuarterly) return aQuarterly ? a : b;

  return a;
}

/** Every fiscal year that appears anywhere in the graph, as start years. */
function fiscalYearsIn(graph) {
  const years = new Set();

  for (const node of graph.nodes) {
    const parsed = canonicalizePeriod(node.period_key);
    if (parsed.fy_start_year !== null) years.add(parsed.fy_start_year);
  }

  return [...years].sort((a, b) => a - b);
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

module.exports = { run, RULE_CLASS: 'R3' };
