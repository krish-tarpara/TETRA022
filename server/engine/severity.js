/**
 * Severity scoring.
 *
 *   severity = BASE[rule] x materiality x confidence x direction x corroboration
 *
 * Every factor is a plain number pulled from rulepack.json, and every finding carries the
 * five factors it was built from. That is the point: the UI can show exactly why one finding
 * scored 35.6 and another scored 7.9, and a judge can disagree with a specific multiplier
 * rather than with "the AI thought so".
 *
 * The factors, and why each exists:
 *
 *   BASE           what kind of failure. Broken arithmetic outranks a soft assumption change.
 *   materiality    how much it matters - size of the gap AND which metric it lands on.
 *   confidence     do we actually believe we read both numbers correctly.
 *   direction      does the error flatter the company. Novel, and the one investors react to.
 *   corroboration  a lone dissenter among four is a typo; two against two is a real conflict.
 */

const rulepack = require('./rulepack.json');
const { unitOf } = require('../services/normalization/taxonomyMap');

const CFG = rulepack.severity;
const IMPORTANCE = rulepack.importance;
const DIRECTIONS = rulepack.favourable_direction;
const TIERS = rulepack.authority_tiers;

/**
 * @param {object} input
 * @param {string} input.rule_class      'R1'..'R7'
 * @param {string} input.metric_key
 * @param {object} input.computation     { delta_pct, delta_abs, tolerance_pct|tolerance_abs, ... }
 * @param {Array}  input.observations    the observations this finding is built from
 * @param {object} [input.node]          the fact node, when the finding came from one
 * @param {object} [input.graph]         for scale_anchor
 * @returns {{severity_score:number, severity_band:string, factors:object, confidence_factor:number}}
 */
function scoreFinding(input) {
  const base = rulepack.base_weights[input.rule_class] || 10;

  const materiality = materialityFactor(input);
  const confidence = confidenceFactor(input);
  const direction = directionFactor(input);
  const corroboration = corroborationFactor(input);

  const raw = base * materiality.value * confidence.value * direction.value * corroboration.value;
  const score = clamp(raw, 0, CFG.cap);

  return {
    severity_score: round(score, 1),
    severity_band: bandFor(score),
    confidence_factor: confidence.value,
    factors: {
      base,
      materiality: round(materiality.value, 3),
      confidence: round(confidence.value, 3),
      direction: round(direction.value, 3),
      corroboration: round(corroboration.value, 3),
      // Explanations, so the "why this score" panel needs no extra lookups.
      detail: {
        materiality: materiality.detail,
        confidence: confidence.detail,
        direction: direction.detail,
        corroboration: corroboration.detail
      }
    }
  };
}

/**
 * Materiality: 0.4 .. 2.0
 *
 * Two components, because either alone gives the wrong answer.
 *
 *   relative - a 62% gap is worse than a 3% gap, but saturating, so 200% and 400% are not
 *              wildly different. Both are simply "completely wrong".
 *   absolute - the gap measured against the company's own scale. A Rs 30 lakh discrepancy is
 *              existential at a Rs 3 Cr company and rounding error at a Rs 300 Cr one.
 *
 * Then multiplied by the metric's importance, which is what produces the behaviour the whole
 * design is aiming at: a 6% revenue gap outranks a 40% TAM gap, automatically.
 */
function materialityFactor(input) {
  const cfg = CFG.materiality;
  const comp = input.computation || {};
  const importance = IMPORTANCE[input.metric_key] ?? IMPORTANCE._default;

  const tol = effectiveTolerance(comp, input.metric_key);

  // Coverage findings (R5) have no variance to measure - there is only one number, and the
  // problem is that nothing corroborates it. Falling through to the variance path would give
  // every unsupported claim an identical floor materiality, so an unsupported revenue claim
  // would score the same as an unsupported headcount claim. Importance alone must carry it.
  const hasVariance = (comp.delta_pct !== null && comp.delta_pct !== undefined)
    || (comp.delta_abs !== null && comp.delta_abs !== undefined);

  if (!hasVariance) {
    return {
      value: clamp(cfg.floor + cfg.span * importance, cfg.floor, cfg.floor + cfg.span),
      detail: {
        relative_component: null,
        absolute_component: null,
        delta_pct: null,
        tolerance_used: null,
        importance,
        note: 'no variance to measure; materiality driven entirely by metric importance'
      }
    };
  }

  const deltaPct = Math.abs(comp.delta_pct ?? comp.delta_abs ?? 0);

  // Relative component, saturating on a log curve.
  const ratio = deltaPct / tol;
  const rel = clamp(
    Math.log10(1 + Math.max(0, ratio)) / Math.log10(1 + cfg.rel_saturation),
    0, 1
  );

  // Absolute component. Only meaningful for currency metrics with a known company scale.
  const anchor = input.graph && input.graph.scale_anchor ? input.graph.scale_anchor.value : null;
  const isCurrency = (unitOf(input.metric_key) || 'currency') === 'currency';
  const deltaAbs = Math.abs(comp.delta_abs ?? 0);

  let value;
  let detail;

  if (anchor && anchor > 0 && isCurrency && deltaAbs > 0) {
    const abs = clamp(deltaAbs / (cfg.abs_anchor_fraction * anchor), 0, 1);
    const blended = cfg.rel_weight * rel + cfg.abs_weight * abs;
    value = cfg.floor + cfg.span * blended * importance;
    detail = {
      relative_component: round(rel, 3),
      absolute_component: round(abs, 3),
      delta_pct: round(deltaPct, 2),
      tolerance_used: tol,
      importance,
      scale_anchor: anchor
    };
  } else {
    // No usable scale anchor, or a non-currency metric where an absolute gap is meaningless
    // (2 percentage points of margin has no "company scale"). Relative component only,
    // taking the full weight rather than being diluted by a missing half.
    value = cfg.floor + cfg.span * rel * importance;
    detail = {
      relative_component: round(rel, 3),
      absolute_component: null,
      delta_pct: round(deltaPct, 2),
      tolerance_used: tol,
      importance,
      scale_anchor: anchor,
      note: isCurrency ? 'no scale anchor available' : 'non-currency metric, relative only'
    };
  }

  return { value: clamp(value, cfg.floor, cfg.floor + cfg.span), detail };
}

/**
 * The tolerance the gap is measured against.
 *
 * A zero tolerance (headcount: any difference is a difference) would divide by zero, so it
 * floors at 0.1. Without the floor, a single-person headcount discrepancy would score
 * infinite materiality.
 */
function effectiveTolerance(comp, metricKey) {
  const stated = comp.tolerance_pct ?? comp.tolerance_abs;
  if (stated !== undefined && stated !== null) return Math.max(stated, 0.1);

  const pp = rulepack.tolerances.percentage_point_metrics[metricKey];
  if (pp !== undefined) return Math.max(pp, 0.1);

  const byMetric = rulepack.tolerances.by_metric[metricKey];
  if (byMetric !== undefined) return Math.max(byMetric, 0.1);

  return rulepack.tolerances.default_pct;
}

/**
 * Confidence: 0 .. 1
 *
 * The weakest link across every observation involved, times an FX penalty when the
 * comparison crossed a currency using a rate we assumed rather than read.
 *
 * This factor does double duty: it scales severity, and below `unresolved_gate` it changes
 * the finding's classification entirely - from an accusation into a question. Suppressing
 * confident-but-wrong findings is the actual hard problem in this space, and the only reason
 * anyone would trust the output.
 */
function confidenceFactor(input) {
  const observations = input.observations || [];

  let weakest = 1;
  let weakestFrom = null;

  for (const obs of observations) {
    const c = obs.confidence || {};
    const combined = (c.value ?? 1) * (c.label ?? 1) * (c.period ?? 1) * (c.parse ?? 1);
    if (combined < weakest) {
      weakest = combined;
      weakestFrom = { filename: obs.filename, label: obs.raw_label, components: c };
    }
  }

  const crossedCurrency = Boolean(input.node && input.node.crossed_currency) || Boolean(input.crossed_currency);
  const fxPenalty = crossedCurrency ? CFG.confidence.fx_penalty : 1;

  return {
    value: clamp(weakest * fxPenalty, 0, 1),
    detail: {
      weakest_observation: round(weakest, 3),
      weakest_from: weakestFrom,
      fx_penalty: fxPenalty,
      crossed_currency: crossedCurrency
    }
  };
}

/**
 * Direction: 0.85 / 1.0 / 1.25
 *
 * An error that makes the company look better to an investor is worth more than one that
 * makes it look worse. A deck overstating revenue against audited statements is a different
 * kind of problem from a deck understating it.
 *
 * Only applies across authority tiers. Two management documents disagreeing has no
 * "self-serving" direction - neither is the authority the other is being measured against.
 */
function directionFactor(input) {
  const favourable = DIRECTIONS[input.metric_key];
  if (!favourable) {
    return { value: CFG.direction.neutral, detail: { reason: 'no_favourable_direction_defined' } };
  }

  const comp = input.computation || {};

  // Identity-style findings (R2, R3, R7) compare a stated figure against one the engine
  // computed from other figures, so authority tiers are the wrong question - the documents
  // involved are usually the same one. The meaningful question is whether the stated number
  // errs in the flattering direction: a gross profit stated ABOVE what revenue minus COGS
  // supports is overstated, whoever wrote it.
  if (isIdentityRule(input.rule_class) && isNumber(comp.stated) && isNumber(comp.computed)) {
    if (comp.stated === comp.computed) {
      return { value: CFG.direction.neutral, detail: { reason: 'no_deviation' } };
    }
    const statedIsHigher = comp.stated > comp.computed;
    const selfServing = favourable === 'up' ? statedIsHigher : !statedIsHigher;
    return {
      value: selfServing ? CFG.direction.self_serving : CFG.direction.conservative,
      detail: {
        reason: selfServing ? 'stated_figure_overstated' : 'stated_figure_understated',
        favourable_direction: favourable,
        stated: comp.stated,
        computed: comp.computed
      }
    };
  }

  // Cross-source findings compare the same metric across documents of differing authority.
  // Restricted to this finding's own metric: an R2 finding's observation set spans several
  // metrics, and ranking a COGS figure against a revenue figure would be meaningless.
  const observations = (input.observations || []).filter(o => o.metric_key === input.metric_key);

  if (observations.length < 2) {
    return { value: CFG.direction.neutral, detail: { reason: 'single_source_for_this_metric' } };
  }

  const ranked = observations
    .map(o => ({ obs: o, tier: TIERS[o.document_category] ?? TIERS.unknown }))
    .sort((a, b) => b.tier - a.tier);

  const highest = ranked[0];
  const lowest = ranked[ranked.length - 1];

  if (highest.tier === lowest.tier) {
    return {
      value: CFG.direction.neutral,
      detail: { reason: 'same_authority_tier', tier: highest.tier }
    };
  }

  const authorityValue = highest.obs.value_base;
  const claimValue = lowest.obs.value_base;

  if (authorityValue === null || claimValue === null || authorityValue === claimValue) {
    return { value: CFG.direction.neutral, detail: { reason: 'values_not_comparable' } };
  }

  // Is the less authoritative source on the flattering side?
  const claimIsHigher = claimValue > authorityValue;
  const selfServing = favourable === 'up' ? claimIsHigher : !claimIsHigher;

  return {
    value: selfServing ? CFG.direction.self_serving : CFG.direction.conservative,
    detail: {
      reason: selfServing ? 'self_serving' : 'conservative',
      favourable_direction: favourable,
      authority: { filename: highest.obs.filename, category: highest.obs.document_category, tier: highest.tier, value: authorityValue },
      claim: { filename: lowest.obs.filename, category: lowest.obs.document_category, tier: lowest.tier, value: claimValue }
    }
  };
}

/**
 * Corroboration: 0.8 / 1.0 / 1.15
 *
 * Three documents agreeing and one disagreeing is an isolated error - probably a stale slide,
 * probably fixable, and the company can point at the majority. One against one is a genuine
 * standoff with no tiebreaker, which is worse for an investor even though the arithmetic gap
 * is identical.
 */
function corroborationFactor(input) {
  const node = input.node;

  if (!node || node.distinct_source_docs <= 1) {
    return { value: CFG.corroboration.single_source, detail: { reason: 'single_source' } };
  }

  const total = node.distinct_source_docs;
  const dissenting = new Set((node.outliers || []).map(o => o.filename)).size;

  if (dissenting === 0) {
    return { value: CFG.corroboration.single_source, detail: { reason: 'no_identified_outliers', total } };
  }

  const ratio = dissenting / total;
  const isolated = ratio <= CFG.corroboration.outlier_ratio_threshold;

  return {
    value: isolated ? CFG.corroboration.isolated_outlier : CFG.corroboration.standoff,
    detail: {
      reason: isolated ? 'isolated_outlier' : 'standoff',
      dissenting_sources: dissenting,
      total_sources: total,
      ratio: round(ratio, 2)
    }
  };
}

/** Rules whose findings compare a stated figure against a computed one. */
function isIdentityRule(ruleClass) {
  return ruleClass === 'R2' || ruleClass === 'R3' || ruleClass === 'R7';
}

function isNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Display band from a severity score. */
function bandFor(score) {
  const bands = rulepack.bands;
  if (score >= bands.CRITICAL) return 'CRITICAL';
  if (score >= bands.HIGH) return 'HIGH';
  if (score >= bands.MEDIUM) return 'MEDIUM';
  return 'MINOR';
}

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function round(n, places) {
  if (!Number.isFinite(n)) return n;
  const f = Math.pow(10, places);
  return Math.round(n * f) / f;
}

module.exports = {
  scoreFinding,
  bandFor,
  materialityFactor,
  confidenceFactor,
  directionFactor,
  corroborationFactor,
  effectiveTolerance
};
