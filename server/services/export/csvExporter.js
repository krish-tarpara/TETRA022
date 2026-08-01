/**
 * CSV export.
 *
 * Emits a single file containing several labelled sections: the score breakdown, the findings, the
 * raw observations behind them, and a metric-by-document comparison matrix.
 *
 * One file rather than several because a browser can only download one thing per click, and a zip
 * would add a dependency for no real benefit. Sections are separated by a blank line and a heading
 * row, which every spreadsheet application handles.
 *
 * The observations section is the part that matters for auditability: every figure the engine read,
 * with its page and verbatim quote, so a reader can check any finding against the source documents
 * without access to this system.
 */

const { stringify } = require('csv-stringify');

/**
 * @param {object} session
 * @param {Array} findings      rows from the findings table
 * @param {Array} observations  rows from the observations table
 * @param {Array} documents     rows from the documents table
 * @param {object} res          Express response, streamed to
 */
function generateCsv(session, findings, observations, documents, res) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="FinVerify_${shortId(session.id)}.csv"`);

  const docNames = Object.fromEntries((documents || []).map(d => [d.id, d.original_filename]));
  const rows = [];

  rows.push(['FinVerify Verification Report']);
  rows.push(['Session', session.id]);
  rows.push(['Generated', new Date(session.updated_at || session.created_at).toISOString()]);
  rows.push(['Readiness Score', session.readiness_score]);
  rows.push(['Assessment', session.score_breakdown ? session.score_breakdown.label : '']);
  rows.push(['Rule Pack Version', session.rulepack_version || '']);

  if (session.fx_rates && Object.keys(session.fx_rates).length > 0) {
    // Any finding that crossed a currency depends on these, so the export must carry them or its
    // numbers cannot be reproduced.
    rows.push(['Exchange Rates Applied', describeRates(session.fx_rates)]);
  }
  rows.push([]);

  if (session.pillar_scores) {
    rows.push(['SCORE BREAKDOWN']);
    rows.push(['Pillar', 'Score', 'Weight', 'Findings', 'Assessed']);
    for (const p of Object.values(session.pillar_scores)) {
      rows.push([
        p.label, p.score, `${Math.round(p.weight * 100)}%`, p.finding_count,
        p.applicable ? 'yes' : 'no documents provided'
      ]);
    }
    rows.push([]);
  }

  rows.push(['FINDINGS']);
  rows.push([
    'Ref Code', 'Classification', 'Severity', 'Band', 'Pillar', 'Metric', 'Period',
    'Check', 'Arithmetic', 'Gap %', 'Tolerance', 'Documents', 'Explanation', 'Follow-Up Question'
  ]);

  for (const f of sortBySeverity(findings)) {
    const comp = f.computation || {};
    rows.push([
      f.ref_code,
      f.classification,
      f.severity_score,
      f.severity_band,
      f.pillar,
      f.metric_label || f.metric_key,
      f.period_key,
      comp.expression || '',
      comp.substituted || '',
      blank(comp.delta_pct) ? '' : round(comp.delta_pct, 2),
      toleranceText(comp),
      uniqueFilenames(f.evidence).join('; '),
      f.narrative || '',
      f.follow_up_question || ''
    ]);
  }
  rows.push([]);

  rows.push(['EXTRACTED FIGURES']);
  rows.push([
    'Document', 'Category', 'Metric', 'Label in Document', 'Value as Written', 'Value',
    'Currency', 'Unit', 'Period', 'Basis', 'Subject', 'Page', 'Cell', 'Quote', 'Confidence'
  ]);

  for (const o of observations || []) {
    rows.push([
      docNames[o.document_id] || '',
      o.document_category || '',
      o.metric_key,
      o.raw_label || '',
      o.value_raw || '',
      blank(o.value_base) ? '' : o.value_base,
      o.currency || '',
      o.unit || '',
      o.period_key || '',
      o.basis || '',
      o.subject || '',
      blank(o.source_page) ? '' : o.source_page,
      o.source_cell || '',
      o.source_quote || '',
      round(combinedConfidence(o), 3)
    ]);
  }
  rows.push([]);

  const matrix = buildMatrix(observations, documents);
  if (matrix.columns.length > 0 && matrix.rows.length > 0) {
    rows.push(['COMPARISON MATRIX']);
    rows.push(['Metric', 'Period', ...matrix.columns, 'Documents Reporting']);
    for (const row of matrix.rows) {
      rows.push([
        row.metric_key,
        row.period_key,
        ...matrix.columns.map(c => (row.values[c] === undefined ? '-' : row.values[c])),
        row.source_count
      ]);
    }
  }

  writeRows(rows, res);
}

/**
 * Pivot the observations into metric x document-category.
 *
 * Built from observations rather than findings deliberately: the matrix should show every figure
 * that was read, including those no rule had anything to say about. A matrix built from findings
 * would only ever show problems, which is the opposite of what a matrix is for.
 */
function buildMatrix(observations, documents) {
  const categories = [...new Set((documents || []).map(d => d.document_category).filter(Boolean))];
  const grouped = new Map();

  for (const o of observations || []) {
    if (!o.period_key || o.period_key === 'UNKNOWN') continue;

    const key = `${o.metric_key}|${o.period_key}|${o.subject || '-'}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        metric_key: o.subject ? `${o.metric_key} (${o.subject})` : o.metric_key,
        period_key: o.period_key,
        values: {},
        docs: new Set()
      });
    }

    const row = grouped.get(key);
    if (o.document_category) row.values[o.document_category] = o.value_raw || o.value_base;
    row.docs.add(o.document_id);
  }

  return {
    columns: categories,
    rows: [...grouped.values()]
      .map(r => ({ metric_key: r.metric_key, period_key: r.period_key, values: r.values, source_count: r.docs.size }))
      .sort((a, b) =>
        a.metric_key.localeCompare(b.metric_key) || a.period_key.localeCompare(b.period_key)
      )
  };
}

/** Export for sessions produced by the previous pipeline. */
function generateLegacyCsv(session, discrepancies, metrics, res) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="FinVerify_${shortId(session.id)}_legacy.csv"`);

  const rows = [];
  rows.push(['FinVerify Report (previous pipeline)']);
  rows.push(['Session', session.id]);
  rows.push(['Readiness Score', session.readiness_score]);
  rows.push([]);

  rows.push(['DISCREPANCIES']);
  rows.push([
    'Ref Code', 'Metric', 'Classification', 'Variance %',
    'Source A', 'Source A Context', 'Source B', 'Source B Context',
    'Description', 'Follow-Up Question'
  ]);

  for (const d of discrepancies || []) {
    rows.push([
      d.ref_code || '', d.metric_name || '', d.classification || '',
      blank(d.variance_pct) ? '' : round(d.variance_pct, 2),
      d.source_a_filename || '', d.source_a_context || '',
      d.source_b_filename || '', d.source_b_context || '',
      d.description || '', d.follow_up_question || ''
    ]);
  }
  rows.push([]);

  rows.push(['EXTRACTED METRICS']);
  rows.push(['Metric', 'Normalized', 'Value', 'Unit', 'Period', 'Category', 'Page', 'Context', 'Confidence']);
  for (const m of metrics || []) {
    rows.push([
      m.metric_name || '', m.normalized_name || '',
      blank(m.metric_value) ? '' : m.metric_value,
      m.metric_unit || '', m.normalized_period || m.period || '',
      m.document_category || '',
      blank(m.source_page) ? '' : m.source_page,
      m.source_context || '',
      blank(m.confidence) ? '' : m.confidence
    ]);
  }

  writeRows(rows, res);
}

/**
 * Stream rows out.
 *
 * BOM included because Excel on Windows otherwise reads UTF-8 as the local codepage, which turns
 * the rupee sign into mojibake in every currency column.
 */
function writeRows(rows, res) {
  const stringifier = stringify({ bom: true });

  stringifier.on('error', err => {
    console.error('CSV stringify failed:', err.message);
    res.end();
  });

  stringifier.pipe(res);
  for (const row of rows) stringifier.write(row);
  stringifier.end();
}

function toleranceText(comp) {
  if (!blank(comp.tolerance_pct)) return `${comp.tolerance_pct}%`;
  if (!blank(comp.tolerance_abs)) return `${comp.tolerance_abs}pp`;
  return '';
}

function sortBySeverity(findings) {
  return [...(findings || [])].sort((a, b) => Number(b.severity_score) - Number(a.severity_score));
}

function uniqueFilenames(evidence) {
  return [...new Set((evidence || []).map(e => e.filename).filter(Boolean))];
}

function combinedConfidence(o) {
  return [o.conf_value, o.conf_label, o.conf_period, o.conf_parse]
    .reduce((product, p) => product * (blank(p) ? 1 : Number(p)), 1);
}

function describeRates(rates) {
  return Object.entries(rates)
    .filter(([k]) => k !== 'source' && k !== 'as_of')
    .map(([pair, rate]) => `${String(pair).replace('_', '/')} = ${rate}`)
    .join(', ');
}

function blank(v) {
  return v === null || v === undefined || v === '';
}

function shortId(id) {
  return String(id).split('-')[0];
}

function round(n, places) {
  const value = Number(n);
  if (!Number.isFinite(value)) return '';
  const f = Math.pow(10, places);
  return Math.round(value * f) / f;
}

module.exports = { generateCsv, generateLegacyCsv, buildMatrix };
