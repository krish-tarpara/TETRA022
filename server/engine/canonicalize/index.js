/**
 * Turn raw extractor output into canonical observations.
 *
 * This is the gate between the AI and the engine. Everything downstream assumes its input
 * is clean, cited, and comparable, and this file is the only reason that assumption holds.
 *
 * Two hard rules, both of which drop data on the floor:
 *
 *   1. No verbatim quote -> discarded. A number the model cannot cite is a number it may
 *      have invented. This is the single cheapest defence against hallucinated findings.
 *   2. No resolvable metric_key or no parseable value -> discarded. There is nothing the
 *      rule engine could do with it except produce noise.
 *
 * Everything else is kept and *scored*, not rejected. Doubtful periods, unit mismatches and
 * scale disagreements survive as low confidence, which is what lets the engine later say
 * "we could not verify this" instead of making a false accusation.
 */

const crypto = require('crypto');
const rulepack = require('../rulepack.json');
const { canonicalizeValue } = require('./scale');
const { canonicalizePeriod } = require('./period');
const { resolveMetric, reconcileUnit } = require('./taxonomy');
const { unitOf } = require('../../services/normalization/taxonomyMap');

const PARSE_QUALITY = rulepack.severity.confidence.parse_quality;

/** Document categories whose numbers are audited third-party facts. */
const AUDITED_CATEGORIES = new Set(['auditor_notes', 'audited_financials']);
/** Document categories that are inherently forward-looking. */
const PROJECTED_CATEGORIES = new Set(['projections']);

const VALID_BASIS = new Set(['audited', 'management', 'projected', 'pro_forma']);

/**
 * @param {object} raw       one record from the extractor
 * @param {object} document  { id, original_filename, document_category, file_type, period_hint }
 * @param {string} sessionId
 * @returns {{observation:object|null, dropped:string|null}}
 */
function canonicalizeObservation(raw, document, sessionId) {
  // ── Rule 1: no citation, no fact ──
  const quote = typeof raw.source_quote === 'string' ? raw.source_quote.trim() : '';
  if (!quote) {
    return { observation: null, dropped: 'missing_source_quote' };
  }

  // ── Rule 2: must resolve to a known metric ──
  const resolved = resolveMetric(raw.raw_label, raw.metric_key);
  if (!resolved.metric_key) {
    return { observation: null, dropped: 'unresolvable_metric' };
  }

  const declaredUnit = unitOf(resolved.metric_key);
  const scaled = canonicalizeValue(raw.value_raw, numeric(raw.value), declaredUnit);

  if (scaled.value_base === null) {
    return { observation: null, dropped: 'unparseable_value' };
  }

  // The value's apparent unit can redirect the metric key, e.g. a percentage that was
  // filed under `ebitda` really belongs on `ebitda_margin`.
  const reconciled = reconcileUnit(resolved.metric_key, scaled.detected_unit);
  const metricKey = reconciled.metric_key;
  const finalUnit = unitOf(metricKey) || scaled.detected_unit;

  const period = canonicalizePeriod(raw.period, {
    documentPeriodHint: document.period_hint,
    periodType: raw.period_type
  });

  const basis = deriveBasis(raw, document, period);
  const parseQuality = deriveParseQuality(raw, document);

  return {
    observation: {
      observation_id: crypto.randomUUID(),
      session_id: sessionId,
      document_id: document.id,
      filename: document.original_filename,
      document_category: document.document_category,

      metric_key: metricKey,
      raw_label: raw.raw_label || null,

      value_raw: raw.value_raw === undefined ? null : String(raw.value_raw),
      value_base: scaled.value_base,
      currency: finalUnit === 'currency' ? (scaled.currency || rulepack.fiscal.base_currency) : null,
      unit: finalUnit,

      period_raw: raw.period || null,
      period_key: period.period_key,
      period_granularity: period.granularity,
      period_type: normalizePeriodType(raw.period_type, basis),
      basis,
      basis_class: basisClass(basis),

      source: {
        page: numeric(raw.source_page),
        cell: raw.source_cell || null,
        quote
      },

      confidence: {
        value: clamp01(numeric(raw.confidence) ?? 0.9) * scaled.scale_conf,
        label: resolved.label_conf * reconciled.unit_conf,
        period: period.period_conf,
        parse: PARSE_QUALITY[parseQuality] ?? PARSE_QUALITY.unknown
      },

      // Kept for the "why is this low confidence?" drill-down in the UI.
      diagnostics: {
        scale_reason: scaled.reason,
        scale_multiplier: scaled.multiplier,
        label_agreement: resolved.agreement,
        matched_alias: resolved.matched_alias,
        unit_redirected: reconciled.redirected,
        period_quality: period.quality,
        parse_quality: parseQuality
      },

      node_key: null // assigned by factGraph, which knows the session FX table
    },
    dropped: null
  };
}

/**
 * Canonicalize a document's whole extraction batch.
 *
 * @returns {{observations:Array, dropped:Array<{reason:string,raw_label:string,value_raw:string}>}}
 */
function canonicalizeBatch(rawRecords, document, sessionId) {
  const observations = [];
  const dropped = [];

  for (const raw of rawRecords || []) {
    const { observation, dropped: reason } = canonicalizeObservation(raw, document, sessionId);
    if (observation) {
      observations.push(observation);
    } else {
      dropped.push({
        reason,
        raw_label: raw.raw_label || null,
        value_raw: raw.value_raw === undefined ? null : String(raw.value_raw)
      });
    }
  }

  return { observations, dropped };
}

/**
 * What kind of number is this - audited fact, management figure, or forecast?
 *
 * The document category is more trustworthy than the model's opinion here: a number in an
 * auditor's report is audited whatever the model says. But a projection sitting inside a
 * financial statements pack is still a projection, so period_type can override upward into
 * forward-looking territory.
 */
function deriveBasis(raw, document, period) {
  const claimed = typeof raw.basis === 'string' ? raw.basis.toLowerCase().trim() : null;
  const category = document.document_category;

  if (raw.period_type === 'projected' || period.quality === 'relative') return 'projected';
  if (PROJECTED_CATEGORIES.has(category)) return 'projected';
  if (AUDITED_CATEGORIES.has(category)) return 'audited';
  if (claimed && VALID_BASIS.has(claimed)) return claimed;
  return 'management';
}

/** audited/management describe what happened; projected/pro_forma describe what might. */
function basisClass(basis) {
  return basis === 'projected' || basis === 'pro_forma' ? 'forward' : 'actual';
}

function normalizePeriodType(claimed, basis) {
  const valid = new Set(['historical', 'current', 'projected', 'unknown']);
  if (basis === 'projected') return 'projected';
  if (typeof claimed === 'string' && valid.has(claimed.toLowerCase())) return claimed.toLowerCase();
  return 'unknown';
}

/**
 * How reliably did we read this number off the page?
 *
 * A spreadsheet cell is near-certain. A number lifted out of a prose sentence in a slide
 * deck is a guess about which number the sentence was talking about.
 */
function deriveParseQuality(raw, document) {
  const fileType = (document.file_type || '').toLowerCase();

  if (fileType === '.xlsx' || fileType === '.csv') return 'xlsx_cell';
  if (raw.source_cell) return 'parsed_table';

  // A markdown table row survives parsing with pipes intact; prose does not.
  const quote = String(raw.source_quote || '');
  if (quote.includes('|')) return 'parsed_table';
  if (quote.length > 0) return 'prose';
  return 'unknown';
}

function numeric(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp01(n) {
  if (n === null) return 0.9;
  return Math.max(0, Math.min(1, n));
}

module.exports = { canonicalizeObservation, canonicalizeBatch, deriveBasis, basisClass };
