/**
 * R4 - Temporal continuity / unusual assumption change.
 *
 * Looks at the seam between what happened and what is forecast. A company that grew 20% a
 * year for three years and then projects 300% has not made an arithmetic error - it has made
 * an assumption, and the assumption is doing the heavy lifting in the valuation. That is a
 * risk an investor must be told about, not a mistake to accuse anyone of. Everything this rule
 * produces is classified UNUSUAL_ASSUMPTION_CHANGE and carries the lowest base weight of any
 * rule (8) for exactly that reason.
 *
 * The maths here is where a naive implementation produces nonsense, so most of this file is
 * guards:
 *
 *   - Dividing by a base of zero or near-zero gives infinite growth. A company going from
 *     Rs 0 to Rs 1 Cr has not grown by infinity percent; it has started trading.
 *   - Sign flips break growth entirely. EBITDA moving from -Rs 1 Cr to +Rs 2 Cr is not
 *     "300% growth", it is a turnaround, and a growth ratio is meaningless across zero.
 *   - Compound growth needs two or more historical points. One point is a level, not a trend.
 *   - Non-adjacent periods must be annualised. FY24 actual to FY27 projected is three years of
 *     growth, and comparing it against a one-year rate would flag every company on earth.
 *   - Relative periods ("Year 1") cannot be placed on a timeline at all.
 *
 * Every guard fails closed: no comparison rather than a wrong one.
 */

const rulepack = require('../rulepack.json');
const { makeFinding } = require('../finding');
const { formatAmount } = require('../canonicalize/currency');
const { canonicalizePeriod, sortKey } = require('../canonicalize/period');

const CFG = rulepack.temporal;

/** Metrics where a growth-trend break is meaningful. */
const GROWTH_METRICS = ['revenue', 'arr', 'mrr', 'customer_base', 'ebitda', 'net_profit', 'gross_profit'];
/** Margins, checked for step changes rather than growth rates. */
const MARGIN_METRICS = ['gross_margin', 'ebitda_margin', 'net_margin'];

/**
 * Below this, a base value is too small for a percentage to mean anything. Growing from
 * Rs 50,000 to Rs 5 Cr is a 100,000% increase that says nothing about credibility.
 */
const MIN_MEANINGFUL_BASE = 100000;

function run(graph) {
  const findings = [];

  for (const metricKey of GROWTH_METRICS) {
    const finding = checkGrowthBreak(metricKey, graph);
    if (finding) findings.push(finding);
  }

  for (const metricKey of MARGIN_METRICS) {
    const finding = checkMarginStep(metricKey, graph);
    if (finding) findings.push(finding);
  }

  const burn = checkBurnDiscontinuity(graph);
  if (burn) findings.push(burn);

  return findings;
}

/**
 * Annual-only series for one metric and basis, chronologically ordered.
 *
 * Restricted to full fiscal years. Mixing a monthly figure into a growth series would compare
 * one month against twelve and manufacture a 1,200% collapse.
 */
function annualSeries(metricKey, basisClass, graph) {
  return graph.index
    .metric(metricKey)
    .filter(n =>
      n.basis_class === basisClass &&
      n.consensus_value !== null &&
      !n.blocked_reason &&
      n.subject === null &&
      isFullYear(n.period_key)
    )
    .map(n => ({ node: n, sort: sortKey(canonicalizePeriod(n.period_key)) }))
    .filter(e => e.sort !== null)
    .sort((a, b) => a.sort - b.sort)
    .map(e => e.node);
}

function isFullYear(periodKey) {
  const parsed = canonicalizePeriod(periodKey);
  return parsed.granularity === 'fy' && parsed.fy_start_year !== null;
}

function fyStartOf(node) {
  return canonicalizePeriod(node.period_key).fy_start_year;
}

/**
 * Does the first projected year break from the historical trend?
 */
function checkGrowthBreak(metricKey, graph) {
  const historicals = annualSeries(metricKey, 'actual', graph);
  const projections = annualSeries(metricKey, 'forward', graph);

  if (historicals.length === 0 || projections.length === 0) return null;

  const lastActual = historicals[historicals.length - 1];
  const lastActualYear = fyStartOf(lastActual);

  // Only projections that come after the last actual. A "projection" for a year already
  // closed is a restatement, and belongs to R1.
  const forward = projections.filter(n => fyStartOf(n) > lastActualYear);
  if (forward.length === 0) return null;

  const firstProjected = forward[0];
  const yearGap = fyStartOf(firstProjected) - lastActualYear;

  const base = lastActual.consensus_value;
  const projected = firstProjected.consensus_value;

  // Guard: a base too small or the wrong side of zero makes a percentage meaningless.
  if (Math.abs(base) < MIN_MEANINGFUL_BASE) return null;
  if (base <= 0 || projected <= 0) return null;   // sign flip / turnaround, not growth

  // Annualise, so a three-year jump is not compared against a one-year rate.
  const impliedGrowthPct = (Math.pow(projected / base, 1 / yearGap) - 1) * 100;
  if (impliedGrowthPct <= 0) return null;         // flat or declining forecast is not this rule's business

  const trailing = trailingCagr(historicals);

  // Two paths, because "grew 20%, forecasts 300%" and "was shrinking, forecasts 300%" are
  // different findings and the second cannot be expressed as a ratio.
  let ratio;
  let reason;

  if (trailing === null) {
    // Only one historical point, or a sign change in history. No trend to compare against, so
    // fall back to an absolute-magnitude test only.
    if (impliedGrowthPct < CFG.min_absolute_growth_pct * 2) return null;
    ratio = null;
    reason = 'no_trend_available_large_absolute_growth';
  } else if (trailing <= 0) {
    if (impliedGrowthPct < CFG.min_absolute_growth_pct) return null;
    ratio = null;
    reason = 'reversal_from_decline_to_growth';
  } else {
    ratio = impliedGrowthPct / trailing;
    if (ratio <= CFG.growth_ratio_threshold) return null;
    if (impliedGrowthPct < CFG.min_absolute_growth_pct) return null;
    reason = 'growth_far_above_historical_trend';
  }

  const currency = lastActual.observations[0] ? lastActual.observations[0].currency : 'INR';
  const unit = lastActual.unit;

  const trailingText = trailing === null
    ? 'no comparable historical trend'
    : `historical trend ${round(trailing, 1)}% per year`;

  return makeFinding({
    rule_id: `R4.growth_break.${metricKey}`,
    rule_class: 'R4',
    metric_key: metricKey,
    period_key: firstProjected.period_key,
    node: firstProjected,
    graph,
    observations: [...historicals.flatMap(n => n.observations), ...firstProjected.observations],
    computation: {
      expression: `projected ${metricKey} growth vs trailing historical growth`,
      substituted: `${lastActual.period_key}: ${fmt(base, unit, currency)} -> ${firstProjected.period_key}: ${fmt(projected, unit, currency)}` +
        `  =  ${round(impliedGrowthPct, 1)}% per year   [${trailingText}]`,
      stated: projected,
      computed: null,
      delta_abs: null,
      delta_pct: impliedGrowthPct,
      // Materiality measures how far beyond history the forecast reaches. Never zero, so the
      // saturating curve in severity.js stays well defined.
      tolerance_pct: Math.max(
        trailing === null ? CFG.min_absolute_growth_pct : trailing * CFG.growth_ratio_threshold,
        1
      ),
      result: 'FLAGGED',
      blocked_reason: null
    },
    extra: {
      reason,
      implied_growth_pct: round(impliedGrowthPct, 2),
      trailing_cagr_pct: trailing === null ? null : round(trailing, 2),
      growth_ratio: ratio === null ? null : round(ratio, 2),
      year_gap: yearGap,
      historical_periods: historicals.map(n => ({ period_key: n.period_key, value: n.consensus_value })),
      projected_period: firstProjected.period_key,
      threshold_used: CFG.growth_ratio_threshold,
      uncalibrated: true
    }
  });
}

/**
 * Compound annual growth across the historical series.
 *
 * Returns null when it cannot be computed honestly: fewer than two points, a non-positive
 * endpoint (compound growth across zero is undefined), or a base too small to be meaningful.
 */
function trailingCagr(series) {
  if (series.length < 2) return null;

  const first = series[0];
  const last = series[series.length - 1];

  const firstValue = first.consensus_value;
  const lastValue = last.consensus_value;

  if (firstValue <= 0 || lastValue <= 0) return null;
  if (Math.abs(firstValue) < MIN_MEANINGFUL_BASE) return null;

  const years = fyStartOf(last) - fyStartOf(first);
  if (years <= 0) return null;

  return (Math.pow(lastValue / firstValue, 1 / years) - 1) * 100;
}

/**
 * A projected margin far above anything the company has ever achieved.
 *
 * Margins are bounded and slow-moving, so a projected jump of more than 10 percentage points
 * beyond the best historical year is a strong assumption. Compared in percentage points, not
 * relative percent - 38% to 50% is a 12pp step, and calling it "a 31% increase" would hide
 * how large a claim it is.
 */
function checkMarginStep(metricKey, graph) {
  const historicals = annualSeries(metricKey, 'actual', graph);
  const projections = annualSeries(metricKey, 'forward', graph);

  if (historicals.length === 0 || projections.length === 0) return null;

  const bestHistorical = historicals.reduce(
    (best, n) => (n.consensus_value > best.consensus_value ? n : best),
    historicals[0]
  );
  const highestProjected = projections.reduce(
    (best, n) => (n.consensus_value > best.consensus_value ? n : best),
    projections[0]
  );

  const stepPp = highestProjected.consensus_value - bestHistorical.consensus_value;
  if (stepPp <= CFG.margin_step_change_pp) return null;

  return makeFinding({
    rule_id: `R4.margin_step.${metricKey}`,
    rule_class: 'R4',
    metric_key: metricKey,
    period_key: highestProjected.period_key,
    node: highestProjected,
    graph,
    observations: [...bestHistorical.observations, ...highestProjected.observations],
    computation: {
      expression: `projected ${metricKey} vs best historical ${metricKey}`,
      substituted: `best historical ${bestHistorical.period_key}: ${round(bestHistorical.consensus_value, 1)}%` +
        `  ->  projected ${highestProjected.period_key}: ${round(highestProjected.consensus_value, 1)}%` +
        `  =  +${round(stepPp, 1)} percentage points`,
      stated: highestProjected.consensus_value,
      computed: bestHistorical.consensus_value,
      delta_abs: stepPp,
      delta_pct: null,
      tolerance_abs: CFG.margin_step_change_pp,
      result: 'FLAGGED',
      blocked_reason: null
    },
    extra: {
      reason: 'margin_step_change',
      step_pp: round(stepPp, 2),
      best_historical: { period_key: bestHistorical.period_key, value: bestHistorical.consensus_value },
      projected: { period_key: highestProjected.period_key, value: highestProjected.consensus_value },
      threshold_pp: CFG.margin_step_change_pp,
      uncalibrated: true
    }
  });
}

/**
 * Burn dropping sharply with no corresponding headcount reduction.
 *
 * Salaries dominate burn at most startups, so a plan to cut spending 50% while keeping - or
 * growing - the team is an assumption that needs stating. If headcount does fall, the plan is
 * internally coherent and this stays quiet.
 */
function checkBurnDiscontinuity(graph) {
  const historicalBurn = annualSeries('burn_rate', 'actual', graph);
  const projectedBurn = annualSeries('burn_rate', 'forward', graph);

  if (historicalBurn.length === 0 || projectedBurn.length === 0) return null;

  const lastActual = historicalBurn[historicalBurn.length - 1];
  const forward = projectedBurn.filter(n => fyStartOf(n) > fyStartOf(lastActual));
  if (forward.length === 0) return null;

  const firstProjected = forward[0];

  const base = lastActual.consensus_value;
  if (base <= 0) return null;

  const dropPct = ((base - firstProjected.consensus_value) / base) * 100;
  if (dropPct <= CFG.burn_drop_pct) return null;

  // Does the plan also cut the team? If so, the drop is explained and there is no finding.
  const headcountActual = annualSeries('headcount', 'actual', graph);
  const headcountForward = annualSeries('headcount', 'forward', graph);

  let headcountNote = 'no headcount figures available to corroborate the reduction';

  if (headcountActual.length > 0 && headcountForward.length > 0) {
    const hcBase = headcountActual[headcountActual.length - 1].consensus_value;
    const hcProjected = headcountForward[0].consensus_value;

    if (hcProjected < hcBase) return null; // team shrinks, burn falling is coherent

    headcountNote = hcProjected > hcBase
      ? `headcount rises from ${Math.round(hcBase)} to ${Math.round(hcProjected)}`
      : `headcount unchanged at ${Math.round(hcBase)}`;
  }

  const currency = lastActual.observations[0] ? lastActual.observations[0].currency : 'INR';

  return makeFinding({
    rule_id: 'R4.burn_discontinuity',
    rule_class: 'R4',
    metric_key: 'burn_rate',
    period_key: firstProjected.period_key,
    node: firstProjected,
    graph,
    observations: [...lastActual.observations, ...firstProjected.observations],
    computation: {
      expression: 'projected burn reduction vs headcount plan',
      substituted: `burn falls from ${fmt(base, 'currency', currency)} to ${fmt(firstProjected.consensus_value, 'currency', currency)}` +
        `  =  -${round(dropPct, 1)}%, but ${headcountNote}`,
      stated: firstProjected.consensus_value,
      computed: base,
      delta_abs: base - firstProjected.consensus_value,
      delta_pct: dropPct,
      tolerance_pct: CFG.burn_drop_pct,
      result: 'FLAGGED',
      blocked_reason: null
    },
    extra: {
      reason: 'burn_drop_without_headcount_reduction',
      drop_pct: round(dropPct, 2),
      headcount_note: headcountNote,
      threshold_pct: CFG.burn_drop_pct,
      uncalibrated: true
    }
  });
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

module.exports = { run, RULE_CLASS: 'R4', trailingCagr };
