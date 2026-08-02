/**
 * Classification. Derived, never chosen.
 *
 * The brief's four tiers look like judgment calls, but they aren't - each one is decidable
 * from three things the engine already knows: how far outside tolerance the gap is, whether
 * the comparison was even possible, and how much we trust the reading. So this file is a
 * single function, one screen long, with no model involved.
 *
 * The ordering matters and is not arbitrary:
 *
 *   1. Rule identity first. A coverage gap is MISSING_INFORMATION whatever its numbers say,
 *      because there is no second number to compare.
 *   2. Blocked comparisons next. If we could not compare (missing FX rate, ambiguous period),
 *      the honest answer is "unresolved", never "mismatch". Asserting a mismatch we couldn't
 *      actually test is the worst failure this system can have.
 *   3. Low confidence next, for the same reason - a number we may have misread cannot support
 *      an accusation.
 *   4. Only then the arithmetic.
 *
 * VERIFIED_CONSISTENT falls out of the same function, so positive confirmations cost nothing
 * extra and use exactly the same logic as the negative ones.
 */

const rulepack = require('./rulepack.json');

const GATE = rulepack.severity.confidence.unresolved_gate;
const UNRESOLVED_MULTIPLIER = rulepack.classification.unresolved_tolerance_multiplier;

/** Rules whose classification is fixed by what the rule is, not by a variance. */
const FIXED_BY_RULE = {
  R4: 'UNUSUAL_ASSUMPTION_CHANGE',
  R5: 'MISSING_INFORMATION'
};

/**
 * Reasons a comparison could not be completed. Any of these forces UNRESOLVED_INCONSISTENCY
 * regardless of how large the apparent gap is, because the gap itself is not trustworthy.
 */
const BLOCKING_REASONS = new Set([
  'currency_mismatch',
  'period_ambiguous',
  'basis_mismatch',
  'unit_unknown',
  'no_value'
]);

/**
 * @param {object} finding  { rule_class, computation, confidence_factor }
 * @returns {{classification:string, reason:string}}
 */
function classify(finding) {
  const comp = finding.computation || {};

  if (FIXED_BY_RULE[finding.rule_class]) {
    return { classification: FIXED_BY_RULE[finding.rule_class], reason: 'fixed_by_rule_class' };
  }

  // R6 plausibility violations are hard-bound breaches - a margin above 100% is not a
  // "conflict between sources", it is a single number that cannot be true.
  if (finding.rule_class === 'R6') {
    return finding.confidence_factor < GATE
      ? { classification: 'UNRESOLVED_INCONSISTENCY', reason: 'plausibility_breach_low_confidence' }
      : { classification: 'VERIFIED_MISMATCH', reason: 'plausibility_breach' };
  }

  if (comp.blocked_reason && BLOCKING_REASONS.has(comp.blocked_reason)) {
    return { classification: 'UNRESOLVED_INCONSISTENCY', reason: comp.blocked_reason };
  }

  const delta = pickDelta(comp);
  const tolerance = pickTolerance(comp);

  if (delta === null || tolerance === null) {
    return { classification: 'UNRESOLVED_INCONSISTENCY', reason: 'incomparable_values' };
  }

  // Agreement is checked BEFORE the confidence gate, and the ordering is deliberate.
  //
  // The gate exists to stop the engine making an accusation it cannot support. Agreement is not an
  // accusation, so low confidence is no reason to withhold it - and withholding it actively
  // misleads: it converts "these two documents agree" into "unresolved inconsistency", inventing a
  // problem out of consensus.
  //
  // The bug this prevents is visible through adjudication. Marking one document authoritative
  // lowers the confidence of the others, which turned already-agreeing figures from a green
  // confirmation into a red finding - so an action meant to resolve conflicts created one.
  if (delta <= tolerance) {
    return { classification: 'VERIFIED_CONSISTENT', reason: 'within_tolerance' };
  }

  if (finding.confidence_factor !== undefined && finding.confidence_factor < GATE) {
    return { classification: 'UNRESOLVED_INCONSISTENCY', reason: 'below_confidence_gate' };
  }
  if (delta <= tolerance * UNRESOLVED_MULTIPLIER) {
    return { classification: 'UNRESOLVED_INCONSISTENCY', reason: 'marginal_variance' };
  }
  return { classification: 'VERIFIED_MISMATCH', reason: 'material_variance' };
}

/**
 * Percentage-point metrics compare absolute gaps; everything else compares relative gaps.
 *
 * Mixing these up is a real bug with a real symptom: a margin moving 38% -> 40% is a 2pp
 * change but only a 5% relative change, so testing it the wrong way either flags every
 * rounding difference or misses genuine margin drift.
 */
function pickDelta(comp) {
  if (comp.tolerance_abs !== undefined && comp.tolerance_abs !== null) {
    return comp.delta_abs === undefined || comp.delta_abs === null ? null : Math.abs(comp.delta_abs);
  }
  return comp.delta_pct === undefined || comp.delta_pct === null ? null : Math.abs(comp.delta_pct);
}

function pickTolerance(comp) {
  if (comp.tolerance_abs !== undefined && comp.tolerance_abs !== null) return comp.tolerance_abs;
  if (comp.tolerance_pct !== undefined && comp.tolerance_pct !== null) return comp.tolerance_pct;
  return null;
}

/** Which pillar a rule's findings score against. */
function pillarFor(ruleClass) {
  for (const [name, def] of Object.entries(rulepack.pillars)) {
    if (def.rules.includes(ruleClass)) return name;
  }
  return 'cross_doc_consistency';
}

/** True for classifications that represent a problem rather than a confirmation. */
function isNegative(classification) {
  return classification !== 'VERIFIED_CONSISTENT';
}

module.exports = { classify, pillarFor, isNegative, GATE, BLOCKING_REASONS };
