/**
 * Resolve whatever a document called a metric onto a canonical metric_key.
 *
 * Two inputs, deliberately: the verbatim label from the document, and the key the extractor
 * *claims* it is. We resolve the label ourselves and use agreement between the two as a
 * confidence signal. When they disagree we prefer our own alias match, because the alias
 * table is auditable and the model is not.
 */

const { TAXONOMY_MAP, ALIAS_INDEX, unitOf } = require('../../services/normalization/taxonomyMap');

/**
 * @param {string} rawLabel      verbatim label, e.g. "Topline (FY26E)"
 * @param {string} [claimedKey]  metric_key the extractor returned
 * @returns {{metric_key:string|null, label_conf:number, matched_alias:string|null, agreement:string}}
 */
function resolveMetric(rawLabel, claimedKey) {
  const claimValid = Boolean(claimedKey && TAXONOMY_MAP[claimedKey]);
  const matched = matchAlias(rawLabel);

  // Both agree - the strong case.
  if (matched && claimValid && matched.key === claimedKey) {
    return {
      metric_key: matched.key,
      label_conf: 1.0,
      matched_alias: matched.alias,
      agreement: 'both'
    };
  }

  // We matched an alias but the model named something else. Trust the alias table.
  if (matched && claimValid && matched.key !== claimedKey) {
    return {
      metric_key: matched.key,
      label_conf: 0.7,
      matched_alias: matched.alias,
      agreement: 'conflict'
    };
  }

  // Only our alias table matched.
  if (matched) {
    return {
      metric_key: matched.key,
      label_conf: 0.9,
      matched_alias: matched.alias,
      agreement: 'alias_only'
    };
  }

  // Only the model's claim is usable. Plausible - the alias list will never be complete -
  // but unverified, so confidence drops.
  if (claimValid) {
    return {
      metric_key: claimedKey,
      label_conf: 0.65,
      matched_alias: null,
      agreement: 'model_only'
    };
  }

  return { metric_key: null, label_conf: 0, matched_alias: null, agreement: 'none' };
}

/**
 * Longest-alias-first match against the label.
 *
 * Longest-first is essential: "gross profit margin" has to beat "gross profit", or every
 * margin percentage in the corpus gets filed as a currency amount and the identity checks
 * produce nonsense.
 */
function matchAlias(rawLabel) {
  if (!rawLabel) return null;
  const label = String(rawLabel).toLowerCase().replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!label) return null;

  for (const { alias, key } of ALIAS_INDEX) {
    if (containsPhrase(label, alias)) return { key, alias };
  }
  return null;
}

/**
 * Phrase containment with boundaries, so "ebit" does not match inside "ebitda" and "cr"
 * does not match inside "increase".
 */
function containsPhrase(haystack, needle) {
  const idx = haystack.indexOf(needle);
  if (idx === -1) return false;

  const before = idx === 0 ? '' : haystack[idx - 1];
  const afterIdx = idx + needle.length;
  const after = afterIdx >= haystack.length ? '' : haystack[afterIdx];

  const isWordChar = ch => /[a-z0-9]/.test(ch);
  const needleStartsWord = isWordChar(needle[0]);
  const needleEndsWord = isWordChar(needle[needle.length - 1]);

  if (needleStartsWord && before && isWordChar(before)) return false;
  if (needleEndsWord && after && isWordChar(after)) return false;
  return true;
}

/**
 * Cross-check the value's apparent unit against the metric's declared unit.
 *
 * A percentage sitting on a currency key almost always means the extractor grabbed the
 * margin row instead of the amount row. We try to redirect to the matching sibling key
 * (ebitda -> ebitda_margin) rather than discard a good number.
 */
const PCT_SIBLINGS = {
  ebitda: 'ebitda_margin',
  gross_profit: 'gross_margin',
  net_profit: 'net_margin'
};
const CURRENCY_SIBLINGS = {
  ebitda_margin: 'ebitda',
  gross_margin: 'gross_profit',
  net_margin: 'net_profit'
};

function reconcileUnit(metricKey, detectedUnit) {
  const declared = unitOf(metricKey);
  if (!declared || !detectedUnit || detectedUnit === 'unknown' || declared === detectedUnit) {
    return { metric_key: metricKey, unit_conf: 1.0, redirected: false };
  }

  if (declared === 'currency' && detectedUnit === 'pct' && PCT_SIBLINGS[metricKey]) {
    return { metric_key: PCT_SIBLINGS[metricKey], unit_conf: 0.8, redirected: true };
  }
  if (declared === 'pct' && detectedUnit === 'currency' && CURRENCY_SIBLINGS[metricKey]) {
    return { metric_key: CURRENCY_SIBLINGS[metricKey], unit_conf: 0.8, redirected: true };
  }

  // No sibling to redirect to. Keep the key but mark it doubtful.
  return { metric_key: metricKey, unit_conf: 0.55, redirected: false };
}

module.exports = { resolveMetric, matchAlias, reconcileUnit, containsPhrase };
