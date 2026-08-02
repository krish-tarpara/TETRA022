/**
 * Scale + currency symbol parsing. "Rs 5.2 Cr" -> 52000000 INR.
 *
 * The extractor is asked to return a numeric value, but models are unreliable about scale:
 * they will happily return `5.2` for "5.2 Cr" or `52` for "52 lakh". So we always re-parse
 * the verbatim raw string and treat that as authoritative, using the model's number only
 * as a cross-check. When the two disagree we lower scale confidence rather than pick a
 * winner silently.
 */

const MULTIPLIERS = [
  // Longest-first: 'crore' must beat 'cr', 'thousand' must beat 'th'.
  { token: 'trillion', factor: 1e12 },
  { token: 'billion', factor: 1e9 },
  { token: 'million', factor: 1e6 },
  { token: 'thousand', factor: 1e3 },
  { token: 'hundred', factor: 1e2 },
  { token: 'crores', factor: 1e7 },
  { token: 'crore', factor: 1e7 },
  { token: 'lakhs', factor: 1e5 },
  { token: 'lakh', factor: 1e5 },
  { token: 'lacs', factor: 1e5 },
  { token: 'lac', factor: 1e5 },
  { token: 'cr.', factor: 1e7 },
  { token: 'cr', factor: 1e7 },
  { token: 'bn', factor: 1e9 },
  { token: 'mn', factor: 1e6 },
  { token: 'tn', factor: 1e12 },
  { token: 'k', factor: 1e3 },
  { token: 'm', factor: 1e6 },
  { token: 'b', factor: 1e9 }
];

const CURRENCY_SYMBOLS = [
  { token: '₹', code: 'INR' },   // rupee sign
  { token: 'rs.', code: 'INR' },
  { token: 'rs', code: 'INR' },
  { token: 'inr', code: 'INR' },
  { token: 'usd', code: 'USD' },
  { token: 'us$', code: 'USD' },
  { token: '$', code: 'USD' },
  { token: 'eur', code: 'EUR' },
  { token: '€', code: 'EUR' },
  { token: 'gbp', code: 'GBP' },
  { token: '£', code: 'GBP' },
  { token: 'aed', code: 'AED' },
  { token: 'sgd', code: 'SGD' }
];

/** Detect a currency code from a raw string. Returns null if nothing is stated. */
function detectCurrency(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  for (const { token, code } of CURRENCY_SYMBOLS) {
    if (s.includes(token)) return code;
  }
  return null;
}

/** Detect a scale multiplier, e.g. "5.2 Cr" -> 1e7. Returns 1 when none is stated. */
function detectMultiplier(raw) {
  if (!raw) return 1;
  const s = String(raw).toLowerCase();

  for (const { token, factor } of MULTIPLIERS) {
    // Single-letter suffixes (k/m/b) need a boundary check, otherwise the 'm' in
    // "management" or the 'b' in "EBITDA" would multiply the value by a million.
    if (token.length <= 2) {
      const re = new RegExp(`\\d\\s*${escapeRe(token)}\\b`, 'i');
      if (re.test(s)) return factor;
    } else if (s.includes(token)) {
      return factor;
    }
  }
  return 1;
}

function escapeRe(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pull the bare number out of a raw string.
 *
 * Handles Indian grouping (5,20,00,000), Western grouping (5,200,000), accounting
 * negatives (3,200) -> -3200, trailing minus, and percentages.
 */
function parseNumber(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;

  let s = String(raw).trim();
  if (!s) return null;

  const isParenNegative = /^\(.*\)$/.test(s);
  if (isParenNegative) s = s.slice(1, -1);

  const hasTrailingMinus = /-\s*$/.test(s);
  const hasLeadingMinus = /^\s*-/.test(s);

  // Strip everything that isn't a digit or decimal point. Comma grouping differs between
  // Indian and Western conventions, so we discard separators entirely rather than trying
  // to infer which convention is in play.
  const digits = s.replace(/[^\d.]/g, '');
  if (!digits) return null;

  // A string like "1.2.3" is unparseable; keep the first decimal point only.
  const parts = digits.split('.');
  const cleaned = parts.length > 2 ? `${parts[0]}.${parts.slice(1).join('')}` : digits;

  let value = parseFloat(cleaned);
  if (!Number.isFinite(value)) return null;

  if (isParenNegative || hasTrailingMinus || hasLeadingMinus) value = -value;
  return value;
}

/**
 * Does this look like a prose cross-reference rather than a value?
 *
 * "see note 4" and "refer schedule 12" both contain a digit, and digit-stripping happily
 * turns them into 4 and 12. Those then enter the engine as revenue figures, which is worse
 * than extracting nothing at all - a wrong number produces a confident false mismatch,
 * whereas a missing number produces an honest coverage gap.
 *
 * Heuristic: two or more real words, and no currency symbol or scale token to anchor the
 * number. Conservative by design - it will occasionally reject a value like "total of 42
 * employees", and losing that is cheaper than believing "see note 4" is a number.
 */
function looksLikeProseReference(raw) {
  const s = String(raw).toLowerCase();
  if (detectCurrency(s)) return false;
  if (detectMultiplier(s) !== 1) return false;
  if (s.includes('%')) return false;

  const words = s.match(/[a-z]{3,}/g) || [];
  return words.length >= 2;
}

/** True when the raw string is expressed as a percentage. */
function isPercent(raw) {
  if (!raw) return false;
  const s = String(raw).toLowerCase();
  return s.includes('%') || /\bp(ercent|ct)\b/.test(s);
}

/**
 * Canonicalize one raw value into base units.
 *
 * @param {string|number} valueRaw  verbatim value from the document, e.g. "Rs 5.2 Cr"
 * @param {number|null} modelValue  the number the extractor claims it is
 * @param {string} declaredUnit     the metric's declared unit from the taxonomy
 * @returns {{value_base:number|null, currency:string|null, detected_unit:string, multiplier:number, scale_conf:number, reason:string|null}}
 */
function canonicalizeValue(valueRaw, modelValue, declaredUnit) {
  const currency = detectCurrency(valueRaw);
  const multiplier = detectMultiplier(valueRaw);
  const percent = isPercent(valueRaw);
  const parsed = looksLikeProseReference(valueRaw) ? null : parseNumber(valueRaw);

  const detectedUnit = percent ? 'pct' : (currency ? 'currency' : null);

  // Percentages and counts are never scaled - "45%" is 45, and a "5k customers" style
  // count does get scaled, but a "45.2%" never does.
  const applyMultiplier = !percent;
  const fromRaw = parsed === null ? null : parsed * (applyMultiplier ? multiplier : 1);

  let valueBase = fromRaw;
  let scaleConf = 1.0;
  let reason = null;

  if (fromRaw === null && modelValue !== null && modelValue !== undefined) {
    // Nothing parseable in the raw string; fall back to the model's number.
    valueBase = modelValue;
    scaleConf = 0.7;
    reason = 'value_raw_unparseable_used_model_value';
  } else if (fromRaw !== null && modelValue !== null && modelValue !== undefined) {
    const agree = relativeGap(fromRaw, modelValue) <= 0.005;
    if (!agree) {
      // The model's number and ours disagree. Trust the raw string - it is what the
      // document literally says - but flag the disagreement so severity is discounted.
      const modelMatchesUnscaled = parsed !== null && relativeGap(parsed, modelValue) <= 0.005;
      scaleConf = modelMatchesUnscaled ? 0.85 : 0.6;
      reason = modelMatchesUnscaled
        ? 'model_missed_scale_multiplier'
        : 'model_value_disagrees_with_raw';
    }
  }

  // A declared-unit mismatch means the extractor probably grabbed the wrong row, e.g. it
  // put a margin percentage onto a currency metric. Surfaced, never silently coerced.
  if (declaredUnit && detectedUnit && declaredUnit !== detectedUnit) {
    if (declaredUnit === 'currency' && detectedUnit === 'pct') {
      scaleConf = Math.min(scaleConf, 0.5);
      reason = 'declared_currency_but_value_is_percentage';
    } else if (declaredUnit === 'pct' && detectedUnit === 'currency') {
      scaleConf = Math.min(scaleConf, 0.5);
      reason = 'declared_percentage_but_value_is_currency';
    }
  }

  return {
    value_base: valueBase,
    currency: declaredUnit === 'currency' ? currency : null,
    detected_unit: detectedUnit || declaredUnit || 'unknown',
    multiplier,
    scale_conf: scaleConf,
    reason
  };
}

function relativeGap(a, b) {
  const denom = Math.max(Math.abs(a), Math.abs(b));
  if (denom === 0) return Math.abs(a - b) === 0 ? 0 : Infinity;
  return Math.abs(a - b) / denom;
}

module.exports = {
  canonicalizeValue,
  parseNumber,
  detectCurrency,
  detectMultiplier,
  isPercent,
  looksLikeProseReference,
  relativeGap,
  MULTIPLIERS,
  CURRENCY_SYMBOLS
};
