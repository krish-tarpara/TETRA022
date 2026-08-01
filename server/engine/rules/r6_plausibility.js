/**
 * R6 - Plausibility bands.
 *
 * Catches numbers that cannot be true regardless of the business: a gross margin of 140%,
 * negative headcount, a shareholder owning 130%, an LTV/CAC of 400.
 *
 * These are almost always unit or scale errors rather than dishonesty - someone typed a
 * fraction where a percentage was expected, or a monthly figure into an annual column. Hence
 * the lowest base weight in the pack after R4 (6), and the deliberately generous bounds.
 *
 * The design constraint that matters: this rule must only fire on HARD impossibilities. A
 * plausibility rule that nags about unusual-but-possible numbers trains the reader to ignore
 * the whole report, and then the genuine findings go unread too. Every band here cites the
 * assumption behind it, so a reader can disagree with a specific bound rather than with the
 * system.
 *
 * It also checks derived values. Revenue per employee is nobody's stated figure, but revenue
 * divided by headcount landing outside Rs 1L to Rs 10Cr is a strong signal that one of the
 * two inputs has a scale error - which is worth saying even though no document states it.
 */

const rulepack = require('../rulepack.json');
const { makeFinding } = require('../finding');
const { formatAmount } = require('../canonicalize/currency');
const { labelOf } = require('../../services/normalization/taxonomyMap');

const BANDS = rulepack.plausibility_bands;

function run(graph) {
  const findings = [];

  for (const node of graph.nodes) {
    const finding = checkStated(node, graph);
    if (finding) findings.push(finding);
  }

  findings.push(...checkDerived(graph));

  return findings;
}

/** A number the document actually states, tested against its band. */
function checkStated(node, graph) {
  const band = BANDS[node.metric_key];
  if (!band) return null;

  // Nothing to test, or the value could not be resolved into a comparable number.
  if (node.consensus_value === null || node.blocked_reason) return null;

  const value = node.consensus_value;
  const breach = breachOf(value, band);
  if (!breach) return null;

  const currency = node.observations[0] ? node.observations[0].currency : 'INR';

  return makeFinding({
    rule_id: `R6.band.${node.metric_key}`,
    rule_class: 'R6',
    metric_key: node.metric_key,
    period_key: node.period_key,
    node,
    graph,
    observations: node.observations,
    computation: {
      expression: `${labelOf(node.metric_key)} must be between ${fmt(band.min, band.unit, currency)} and ${fmt(band.max, band.unit, currency)}`,
      substituted: `stated ${fmt(value, band.unit, currency)}, which is ${breach.direction} the ${breach.bound === 'max' ? 'upper' : 'lower'} bound of ${fmt(breach.limit, band.unit, currency)}`,
      stated: value,
      computed: breach.limit,
      delta_abs: Math.abs(value - breach.limit),
      delta_pct: relativeGap(value, breach.limit),
      // The band edge IS the tolerance. Anything beyond it is out of bounds by definition,
      // so the tolerance is nominal and exists only to keep materiality well defined.
      tolerance_pct: 0.1,
      result: 'FAIL',
      blocked_reason: null
    },
    extra: {
      reason: 'implausible_value',
      band: { min: band.min, max: band.max, unit: band.unit },
      bound_breached: breach.bound,
      assumption: band.assumption,
      derived: false,
      likely_cause: likelyCause(node.metric_key, value, band)
    }
  });
}

/**
 * Values the engine computes rather than reads, checked for scale sanity.
 *
 * Only identities marked `derive_only` in the rule pack, and only when nothing in the
 * documents states the result directly - if the document does state it, R2 already compares
 * stated against computed and this would be a duplicate.
 */
function checkDerived(graph) {
  const findings = [];

  for (const identity of rulepack.identities) {
    if (!identity.derive_only) continue;

    const band = BANDS[identity.result];
    if (!band) continue;

    for (const periodKey of periodsIn(graph)) {
      for (const basisClass of ['actual', 'forward']) {
        const finding = checkDerivedIdentity(identity, band, periodKey, basisClass, graph);
        if (finding) findings.push(finding);
      }
    }
  }

  return findings;
}

function checkDerivedIdentity(identity, band, periodKey, basisClass, graph) {
  // If the document states the result itself, R2 owns this comparison.
  if (graph.index.one(identity.result, periodKey, basisClass)) return null;

  const numerator = graph.index.one(identity.numerator, periodKey, basisClass);
  const denominator = graph.index.one(identity.denominator, periodKey, basisClass);

  if (!numerator || !denominator) return null;
  if (numerator.consensus_value === null || denominator.consensus_value === null) return null;
  if (numerator.blocked_reason || denominator.blocked_reason) return null;
  if (denominator.consensus_value === 0) return null;

  const value = (numerator.consensus_value / denominator.consensus_value) * (identity.scale || 1);
  if (!Number.isFinite(value)) return null;

  const breach = breachOf(value, band);
  if (!breach) return null;

  const currency = numerator.observations[0] ? numerator.observations[0].currency : 'INR';

  return makeFinding({
    rule_id: `R6.derived.${identity.result}`,
    rule_class: 'R6',
    metric_key: identity.result,
    period_key: periodKey,
    node: numerator,
    graph,
    observations: [...numerator.observations, ...denominator.observations],
    computation: {
      expression: identity.expression,
      substituted: `${fmt(numerator.consensus_value, numerator.unit, currency)} / ${fmt(denominator.consensus_value, denominator.unit, currency)}` +
        ` = ${fmt(value, band.unit, currency)}, ${breach.direction} the plausible ${breach.bound === 'max' ? 'maximum' : 'minimum'} of ${fmt(breach.limit, band.unit, currency)}`,
      stated: null,
      computed: value,
      delta_abs: Math.abs(value - breach.limit),
      delta_pct: relativeGap(value, breach.limit),
      tolerance_pct: 0.1,
      result: 'FAIL',
      blocked_reason: null
    },
    extra: {
      reason: 'implausible_derived_value',
      band: { min: band.min, max: band.max, unit: band.unit },
      bound_breached: breach.bound,
      assumption: band.assumption,
      derived: true,
      derived_from: [
        { metric_key: identity.numerator, value: numerator.consensus_value },
        { metric_key: identity.denominator, value: denominator.consensus_value }
      ],
      likely_cause: 'One of the two input figures probably has a scale or unit error.',
      uncalibrated: true
    }
  });
}

function breachOf(value, band) {
  if (band.max !== undefined && value > band.max) {
    return { bound: 'max', limit: band.max, direction: 'above' };
  }
  if (band.min !== undefined && value < band.min) {
    return { bound: 'min', limit: band.min, direction: 'below' };
  }
  return null;
}

/**
 * A guess at what went wrong, phrased as a hint.
 *
 * Almost all of these are one of three mistakes, and naming the likely one turns
 * "this number is impossible" into something the founder can fix in thirty seconds.
 */
function likelyCause(metricKey, value, band) {
  if (band.unit === 'pct') {
    // 0.38 where 38 was meant, or 3800 where 38 was meant.
    if (value > 100 && value <= 10000) return 'A fraction may have been multiplied by 100 twice, or a ratio entered as a percentage.';
    if (value > 10000) return 'This looks like an absolute amount entered into a percentage field.';
    if (value < 0) return 'A negative percentage may be a bracketed accounting figure read as a minus.';
  }
  if (band.unit === 'count' && value < 0) {
    return 'A count cannot be negative - this may be a bracketed figure read as a minus.';
  }
  if (metricKey === 'ltv_cac_ratio') {
    return 'LTV and CAC may be stated over different periods, or one of them in different units.';
  }
  if (metricKey === 'cash_runway') {
    return 'Runway may have been stated in months but computed from an annual burn figure.';
  }
  return null;
}

function periodsIn(graph) {
  return [...new Set(graph.nodes.map(n => n.period_key))].filter(p => p && p !== 'UNKNOWN');
}

function relativeGap(a, b) {
  const denom = Math.max(Math.abs(a), Math.abs(b));
  if (denom === 0) return 0;
  return (Math.abs(a - b) / denom) * 100;
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

module.exports = { run, RULE_CLASS: 'R6' };
