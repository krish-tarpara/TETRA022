/**
 * Fixture builders.
 *
 * No real documents were available to calibrate against, so hand-authored observation sets
 * ARE the specification for this engine. These helpers exist so a fixture reads like the
 * claim it represents:
 *
 *   obs({ metric: 'revenue', value: 52000000, period: 'FY2025-26', doc: DOCS.deck })
 *
 * rather than twenty lines of confidence plumbing. Confidence defaults to 1.0 across the
 * board so that severity assertions isolate the factor under test - a test that wants to
 * exercise low confidence sets it explicitly.
 */

const crypto = require('crypto');
const { unitOf } = require('../../../services/normalization/taxonomyMap');
const { deriveSubject } = require('../../canonicalize');

/** The five document categories the scoring model expects, plus a couple of extras. */
const DOCS = {
  deck: { id: 'doc-deck', filename: 'Pitch_Deck.pdf', category: 'pitch_deck' },
  financials: { id: 'doc-fin', filename: 'Financial_Statements.xlsx', category: 'financial_statements' },
  mis: { id: 'doc-mis', filename: 'MIS_Monthly.xlsx', category: 'mis' },
  projections: { id: 'doc-proj', filename: 'Projections.xlsx', category: 'projections' },
  captable: { id: 'doc-cap', filename: 'Cap_Table.xlsx', category: 'cap_table' },
  auditor: { id: 'doc-aud', filename: 'Auditor_Notes.pdf', category: 'auditor_notes' },
  kpi: { id: 'doc-kpi', filename: 'KPI_Dashboard.xlsx', category: 'kpi_dashboard' }
};

/**
 * Build one canonical observation.
 *
 * @param {object} spec
 * @param {string} spec.metric        metric_key
 * @param {number} spec.value         value in base units (already expanded)
 * @param {string} spec.period        canonical period key, e.g. 'FY2025-26'
 * @param {object} spec.doc           one of DOCS
 * @param {string} [spec.unit]        defaults to the taxonomy's declared unit
 * @param {string} [spec.currency]    defaults to INR for currency metrics
 * @param {string} [spec.basis]       audited | management | projected | pro_forma
 * @param {string} [spec.label]       raw_label as the document writes it
 * @param {number} [spec.page]
 * @param {object} [spec.confidence]  partial override, e.g. { period: 0.6 }
 */
function obs(spec) {
  const unit = spec.unit || unitOf(spec.metric) || 'currency';
  const basis = spec.basis || defaultBasis(spec.doc);
  const label = spec.label || spec.metric;

  return {
    observation_id: spec.id || crypto.randomUUID(),
    session_id: spec.session_id || 'test-session',
    document_id: spec.doc.id,
    filename: spec.doc.filename,
    document_category: spec.doc.category,

    metric_key: spec.metric,
    raw_label: label,

    value_raw: spec.value_raw || String(spec.value),
    value_base: spec.value,
    currency: unit === 'currency' ? (spec.currency || 'INR') : null,
    unit,

    period_raw: spec.period,
    period_key: spec.period,
    period_granularity: granularityOf(spec.period),
    period_type: basis === 'projected' ? 'projected' : 'historical',
    basis,
    basis_class: basis === 'projected' || basis === 'pro_forma' ? 'forward' : 'actual',

    // Derived with the same function the real canonicalizer uses. Setting this by hand in
    // fixtures would let it drift from production behaviour, and the tests would then be
    // verifying something the engine never actually receives.
    subject: spec.subject !== undefined ? spec.subject : deriveSubject(spec.metric, label),

    source: {
      page: spec.page === undefined ? 1 : spec.page,
      cell: spec.cell || null,
      quote: spec.quote || `${label}: ${spec.value_raw || spec.value}`
    },

    confidence: {
      value: 1.0,
      label: 1.0,
      period: 1.0,
      parse: 1.0,
      ...(spec.confidence || {})
    },

    diagnostics: {},
    node_key: null
  };
}

function defaultBasis(doc) {
  if (doc.category === 'auditor_notes') return 'audited';
  if (doc.category === 'projections') return 'projected';
  if (doc.category === 'financial_statements') return 'audited';
  return 'management';
}

function granularityOf(periodKey) {
  if (/^M\d\d-/.test(periodKey)) return 'month';
  if (/^Q\d-/.test(periodKey)) return 'quarter';
  if (/^REL-/.test(periodKey)) return 'fy';
  if (/^FY/.test(periodKey)) return 'fy';
  return 'unknown';
}

/**
 * Build a set of observations for one metric across several documents.
 *
 * pair('revenue', 'FY2025-26', [[DOCS.deck, 52000000], [DOCS.financials, 32000000]])
 */
function spread(metric, period, entries, extra = {}) {
  return entries.map(([doc, value]) => obs({ metric, period, doc, value, ...extra }));
}

/** A full P&L for one period and document, for exercising the accounting identities. */
function pnl(doc, period, values, extra = {}) {
  return Object.entries(values).map(([metric, value]) =>
    obs({ metric, period, doc, value, ...extra })
  );
}

module.exports = { obs, spread, pnl, DOCS };
