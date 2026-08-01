/**
 * PDF export.
 *
 * Page 1 is the one-page fundraising readiness summary: score, pillar breakdown, counts, top
 * issues, priority questions. Pages 2+ carry every finding in full with its arithmetic and its
 * source quotes.
 *
 * The design constraint is that page 1 has to work on its own. It is what gets forwarded, printed
 * and put in front of a committee, so it cannot depend on anyone reading the detail pages. And the
 * detail pages have to include the verbatim quotes, because a finding nobody can trace back to a
 * document is not evidence.
 *
 * Layout note: pdfkit has no automatic pagination for custom drawing, so every block measures its
 * own height and breaks the page itself. The old version drew fixed-height boxes and let long text
 * overflow off the bottom of the page, silently losing content.
 */

const PDFDocument = require('pdfkit');

const COLORS = {
  primary: '#1e3a8a',
  text: '#334155',
  muted: '#64748b',
  border: '#cbd5e1',
  panel: '#f1f5f9',
  critical: '#dc2626',
  high: '#ea580c',
  medium: '#ca8a04',
  minor: '#64748b',
  good: '#059669'
};

const CLASSIFICATION_LABELS = {
  VERIFIED_MISMATCH: 'Verified Mismatch',
  UNRESOLVED_INCONSISTENCY: 'Unresolved - Could Not Verify',
  MISSING_INFORMATION: 'Missing Information',
  UNUSUAL_ASSUMPTION_CHANGE: 'Unusual Assumption',
  VERIFIED_CONSISTENT: 'Verified Consistent'
};

function generatePdf(session, findings, documents, res) {
  const doc = new PDFDocument({ margin: 45, size: 'A4', bufferPages: true });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="FinVerify_${shortId(session.id)}.pdf"`);
  doc.pipe(res);

  const breakdown = session.score_breakdown || {};
  const all = [...(findings || [])].sort((a, b) => Number(b.severity_score) - Number(a.severity_score));
  const problems = all.filter(f => f.classification !== 'VERIFIED_CONSISTENT');
  const confirmations = all.filter(f => f.classification === 'VERIFIED_CONSISTENT');

  drawSummaryPage(doc, session, breakdown, problems, confirmations, documents);
  drawFindingDetails(doc, problems, confirmations);
  drawEvidenceIndex(doc, documents, session);
  drawFooters(doc, session);

  doc.end();
}

// ── Page 1: the one-page summary ───────────────────────────────────────────────────────────────

function drawSummaryPage(doc, session, breakdown, problems, confirmations, documents) {
  const width = doc.page.width - 90;

  doc.rect(0, 0, doc.page.width, 6).fill(COLORS.primary);
  doc.y = 40;

  doc.font('Helvetica-Bold').fontSize(20).fillColor(COLORS.primary)
    .text('FUNDRAISING READINESS SUMMARY', { align: 'left' });
  doc.font('Helvetica').fontSize(9).fillColor(COLORS.muted)
    .text(
      `Session ${shortId(session.id)}  ·  ` +
      `${new Date(session.updated_at || session.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}  ·  ` +
      `${(documents || []).length} documents  ·  Rule pack v${session.rulepack_version || 'n/a'}`
    );

  doc.moveDown(1);

  // ── Score panel ──
  const panelTop = doc.y;
  doc.roundedRect(45, panelTop, width, 62, 4).fill(COLORS.panel);

  doc.font('Helvetica-Bold').fontSize(34).fillColor(scoreColor(session.readiness_score))
    .text(`${session.readiness_score}`, 60, panelTop + 12, { width: 70, align: 'left' });
  doc.font('Helvetica').fontSize(9).fillColor(COLORS.muted)
    .text('out of 100', 62, panelTop + 46);

  doc.font('Helvetica-Bold').fontSize(13).fillColor(COLORS.text)
    .text(breakdown.label || '', 140, panelTop + 14, { width: width - 110 });

  if (breakdown.ceiling_applied) {
    // The single most important caveat on the whole report. A reader who misses this will treat a
    // capped score as a low score, when it actually means "not enough was verifiable".
    doc.font('Helvetica-Oblique').fontSize(8).fillColor(COLORS.muted)
      .text(
        `Capped at ${breakdown.ceiling} - only ${breakdown.coverage.nodes_corroborated} of ` +
        `${breakdown.coverage.nodes_checked} figures could be corroborated by a second document. ` +
        `More documents would raise this ceiling.`,
        140, panelTop + 32, { width: width - 110 }
      );
  }

  doc.y = panelTop + 74;

  // ── Executive assessment ──
  if (session.executive_summary) {
    sectionHeading(doc, 'EXECUTIVE ASSESSMENT');
    doc.font('Helvetica').fontSize(9.5).fillColor(COLORS.text)
      .text(session.executive_summary, 45, doc.y, { width, align: 'left', lineGap: 2.5 });
    doc.moveDown(1);
  }

  // ── Pillar breakdown ──
  if (breakdown.pillars) {
    sectionHeading(doc, 'SCORE BREAKDOWN');

    for (const pillar of Object.values(breakdown.pillars)) {
      const rowY = doc.y;

      doc.font('Helvetica').fontSize(9).fillColor(COLORS.text)
        .text(pillar.label, 45, rowY, { width: 165, lineBreak: false });

      // Bar
      const barX = 215;
      const barWidth = 210;
      doc.roundedRect(barX, rowY + 1, barWidth, 8, 2).fill('#e2e8f0');
      const filled = Math.max(2, (Math.min(100, pillar.score) / 100) * barWidth);
      doc.roundedRect(barX, rowY + 1, filled, 8, 2).fill(scoreColor(pillar.score));

      doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.text)
        .text(`${pillar.score}`, barX + barWidth + 8, rowY, { width: 30, lineBreak: false });

      const note = pillar.applicable
        ? `${Math.round(pillar.weight * 100)}%  ·  ${pillar.finding_count} finding${pillar.finding_count === 1 ? '' : 's'}`
        : `${Math.round(pillar.weight * 100)}%  ·  not assessed`;
      doc.font('Helvetica').fontSize(8).fillColor(COLORS.muted)
        .text(note, barX + barWidth + 42, rowY + 1, { width: 110, lineBreak: false });

      doc.y = rowY + 14;
    }
    doc.moveDown(0.6);
  }

  // ── Counts ──
  const counts = breakdown.counts || {};
  sectionHeading(doc, 'FINDINGS SUMMARY');

  const countRows = [
    ['Verified consistent', counts.VERIFIED_CONSISTENT || 0, COLORS.good],
    ['Verified mismatches', counts.VERIFIED_MISMATCH || 0, COLORS.critical],
    ['Missing information', counts.MISSING_INFORMATION || 0, COLORS.medium],
    ['Unusual assumptions', counts.UNUSUAL_ASSUMPTION_CHANGE || 0, COLORS.high],
    ['Could not verify', counts.UNRESOLVED_INCONSISTENCY || 0, COLORS.minor]
  ];

  for (const [label, count, color] of countRows) {
    const rowY = doc.y;
    doc.circle(50, rowY + 4, 3).fill(color);
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.text)
      .text(label, 60, rowY, { width: 170, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(9)
      .text(String(count), 235, rowY, { width: 30, lineBreak: false });
    doc.y = rowY + 12;
  }

  if (counts.unsupported_claims) {
    doc.font('Helvetica-Oblique').fontSize(8).fillColor(COLORS.muted)
      .text(`Includes ${counts.unsupported_claims} pitch deck claim(s) with no supporting document.`, 60, doc.y);
  }
  doc.moveDown(0.8);

  // ── Top issues ──
  if (problems.length > 0) {
    sectionHeading(doc, 'MOST SERIOUS ISSUES');

    for (const f of problems.slice(0, 3)) {
      const rowY = doc.y;
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(bandColor(f.severity_band))
        .text(`${f.ref_code}  ${f.severity_band}`, 45, rowY, { width: width, lineBreak: false });
      doc.font('Helvetica').fontSize(9).fillColor(COLORS.text)
        .text(truncate(f.narrative || f.computation.expression, 240), 45, rowY + 11, { width, lineGap: 1.5 });
      doc.moveDown(0.5);
    }
    doc.moveDown(0.3);
  }

  // ── Priority questions ──
  const questions = (session.follow_up_questions || []).slice(0, 5);
  if (questions.length > 0) {
    if (doc.y > doc.page.height - 170) doc.addPage();

    sectionHeading(doc, 'PRIORITY QUESTIONS FOR MANAGEMENT');

    questions.forEach((q, i) => {
      const text = typeof q === 'string' ? q : q.question;
      const ref = typeof q === 'string' ? null : q.ref_code;
      const rowY = doc.y;

      doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.primary)
        .text(`${i + 1}.`, 45, rowY, { width: 16, lineBreak: false });
      doc.font('Helvetica').fontSize(9).fillColor(COLORS.text)
        .text(ref ? `${text}  [${ref}]` : text, 61, rowY, { width: width - 16, lineGap: 1.5 });
      doc.moveDown(0.4);
    });
  }
}

// ── Pages 2+: full findings ────────────────────────────────────────────────────────────────────

function drawFindingDetails(doc, problems, confirmations) {
  if (problems.length === 0 && confirmations.length === 0) return;

  doc.addPage();
  doc.rect(0, 0, doc.page.width, 6).fill(COLORS.primary);
  doc.y = 40;

  doc.font('Helvetica-Bold').fontSize(15).fillColor(COLORS.primary).text('DETAILED FINDINGS');
  doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.muted)
    .text('Every finding below shows the arithmetic that produced it and the source text it came from.');
  doc.moveDown(1);

  for (const f of problems) drawFinding(doc, f);

  if (confirmations.length > 0) {
    if (doc.y > doc.page.height - 140) doc.addPage();
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(COLORS.good).text('VERIFIED CONSISTENT');
    doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.muted)
      .text('Figures that agreed across documents. Included so the review shows what was checked and found sound, not only what was wrong.');
    doc.moveDown(0.6);

    for (const f of confirmations) drawConfirmation(doc, f);
  }
}

/**
 * One finding block.
 *
 * Measures its own height first and breaks the page if it will not fit. Without this, a finding
 * with several evidence quotes runs off the bottom of the page and the content is simply lost -
 * which is exactly what the previous fixed-height version did.
 */
function drawFinding(doc, f) {
  const width = doc.page.width - 90;
  const comp = f.computation || {};
  const evidence = f.evidence || [];

  const estimate = estimateHeight(doc, f, width);
  if (doc.y + estimate > doc.page.height - 60) {
    doc.addPage();
    doc.rect(0, 0, doc.page.width, 6).fill(COLORS.primary);
    doc.y = 40;
  }

  const top = doc.y;

  // Severity stripe down the left edge, so the page can be skimmed by colour.
  doc.rect(45, top, 3, estimate).fill(bandColor(f.severity_band));

  doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.primary)
    .text(`${f.ref_code}   ${f.metric_label || f.metric_key}${f.period_key ? ` · ${f.period_key}` : ''}`, 56, top, { width: width - 11 });

  doc.font('Helvetica-Bold').fontSize(8).fillColor(bandColor(f.severity_band))
    .text(
      `${CLASSIFICATION_LABELS[f.classification] || f.classification}  ·  ` +
      `severity ${f.severity_score} (${f.severity_band})`,
      56, doc.y + 1, { width: width - 11 }
    );

  doc.moveDown(0.35);

  // The arithmetic. Monospace and boxed, because this is the proof and it must look like one.
  if (comp.substituted) {
    const boxTop = doc.y;
    const boxHeight = doc.font('Courier').fontSize(8.5).heightOfString(comp.substituted, { width: width - 26 }) + 14;
    doc.roundedRect(56, boxTop, width - 11, boxHeight, 2).fill(COLORS.panel);
    doc.font('Courier-Bold').fontSize(8.5).fillColor(COLORS.text)
      .text(comp.substituted, 63, boxTop + 7, { width: width - 26 });
    doc.y = boxTop + boxHeight + 4;
  }

  if (comp.expression) {
    doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(COLORS.muted)
      .text(`Check applied: ${comp.expression}`, 56, doc.y, { width: width - 11 });
    doc.moveDown(0.25);
  }

  if (f.narrative) {
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.text)
      .text(f.narrative, 56, doc.y, { width: width - 11, lineGap: 1.5 });
    doc.moveDown(0.3);
  }

  // Severity working, so the number is never unexplained.
  if (f.factors) {
    doc.font('Helvetica').fontSize(7.5).fillColor(COLORS.muted)
      .text(
        `Severity = base ${f.factors.base} × materiality ${f.factors.materiality} × ` +
        `confidence ${f.factors.confidence} × direction ${f.factors.direction} × ` +
        `corroboration ${f.factors.corroboration} = ${f.severity_score}`,
        56, doc.y, { width: width - 11 }
      );
    doc.moveDown(0.3);
  }

  // Evidence with verbatim quotes.
  if (evidence.length > 0) {
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(COLORS.muted)
      .text('SOURCES', 56, doc.y, { width: width - 11 });
    doc.moveDown(0.15);

    for (const e of evidence.slice(0, 6)) {
      const location = [e.filename, e.page ? `p.${e.page}` : null, e.cell]
        .filter(Boolean).join(' · ');
      doc.font('Helvetica').fontSize(8).fillColor(COLORS.text)
        .text(`${location} — states ${e.value_raw || e.value_base}`, 62, doc.y, { width: width - 22 });
      if (e.quote) {
        doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(COLORS.muted)
          .text(`"${truncate(e.quote, 200)}"`, 62, doc.y, { width: width - 22 });
      }
      doc.moveDown(0.2);
    }

    if (evidence.length > 6) {
      doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(COLORS.muted)
        .text(`...and ${evidence.length - 6} further source(s). See the CSV export for the complete list.`, 62, doc.y, { width: width - 22 });
      doc.moveDown(0.2);
    }
  }

  if (f.follow_up_question) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(COLORS.primary)
      .text('Question for management:', 56, doc.y, { width: width - 11 });
    doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.text)
      .text(f.follow_up_question, 56, doc.y, { width: width - 11, lineGap: 1.5 });
  }

  doc.moveDown(0.8);
  doc.moveTo(56, doc.y).lineTo(doc.page.width - 45, doc.y).strokeColor(COLORS.border).lineWidth(0.5).stroke();
  doc.moveDown(0.6);
}

function drawConfirmation(doc, f) {
  const width = doc.page.width - 90;

  if (doc.y > doc.page.height - 80) {
    doc.addPage();
    doc.rect(0, 0, doc.page.width, 6).fill(COLORS.primary);
    doc.y = 40;
  }

  const rowY = doc.y;
  doc.circle(50, rowY + 4, 3).fill(COLORS.good);
  doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.text)
    .text(f.narrative || `${f.metric_label} agrees across documents.`, 60, rowY, { width: width - 15, lineGap: 1.2 });
  doc.moveDown(0.35);
}

/**
 * Documents examined, with extraction quality.
 *
 * Included because a reader deserves to know how much of each document was actually read. A file
 * that yielded three figures out of a fifty-page pack contributed far less than its presence in
 * the list suggests.
 */
function drawEvidenceIndex(doc, documents, session) {
  if (!documents || documents.length === 0) return;

  if (doc.y > doc.page.height - 200) doc.addPage();
  doc.moveDown(0.5);

  doc.font('Helvetica-Bold').fontSize(13).fillColor(COLORS.primary).text('DOCUMENTS EXAMINED');
  doc.moveDown(0.4);

  const width = doc.page.width - 90;

  for (const d of documents) {
    const rowY = doc.y;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.text)
      .text(d.original_filename, 45, rowY, { width: width * 0.55, lineBreak: false });
    doc.font('Helvetica').fontSize(8).fillColor(COLORS.muted)
      .text(String(d.document_category || 'unclassified').replace(/_/g, ' '), 45 + width * 0.55, rowY + 1, { width: width * 0.45, lineBreak: false });
    doc.y = rowY + 11;

    const stats = d.extraction_stats || {};
    const notes = [];
    if (stats.kept_count !== undefined) notes.push(`${stats.kept_count} figures extracted`);
    if (stats.dropped_count) notes.push(`${stats.dropped_count} discarded as uncited`);
    if (d.parse_error) notes.push(`could not be read: ${d.parse_error}`);

    if (notes.length > 0) {
      doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(COLORS.muted)
        .text(notes.join('  ·  '), 51, doc.y, { width: width - 6 });
      doc.moveDown(0.25);
    }
    doc.moveDown(0.15);
  }

  if (session.fx_rates && Object.keys(session.fx_rates).filter(k => k !== 'source' && k !== 'as_of').length > 0) {
    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(COLORS.text).text('Exchange rates applied', 45, doc.y);
    doc.font('Helvetica').fontSize(8).fillColor(COLORS.muted)
      .text(
        Object.entries(session.fx_rates)
          .filter(([k]) => k !== 'source' && k !== 'as_of')
          .map(([pair, rate]) => `${String(pair).replace('_', '/')} = ${rate}`)
          .join('   ') +
        '  (supplied by the user; any finding that crossed a currency depends on these)',
        45, doc.y, { width }
      );
  }

  doc.moveDown(0.6);
  doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(COLORS.muted)
    .text(
      `Produced by a deterministic rule engine, version ${session.rulepack_version || 'n/a'}. ` +
      `The same documents and the same rule pack always produce the same score. Some thresholds ` +
      `governing projection credibility are reasoned defaults and have not been calibrated ` +
      `against a reference dataset.`,
      45, doc.y, { width }
    );
}

function drawFooters(doc, session) {
  const range = doc.bufferedPageRange();

  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.font('Helvetica').fontSize(7).fillColor(COLORS.muted)
      .text(
        `FinVerify · Confidential · Session ${shortId(session.id)} · Page ${i + 1} of ${range.count}`,
        45, doc.page.height - 28,
        { width: doc.page.width - 90, align: 'center' }
      );
  }
}

// ── Legacy ─────────────────────────────────────────────────────────────────────────────────────

/** Export for sessions produced by the previous pipeline, which have no findings table. */
function generateLegacyPdf(session, discrepancies, documents, res) {
  const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="FinVerify_${shortId(session.id)}_legacy.pdf"`);
  doc.pipe(res);

  doc.rect(0, 0, doc.page.width, 6).fill(COLORS.primary);
  doc.y = 45;

  doc.font('Helvetica-Bold').fontSize(18).fillColor(COLORS.primary).text('DISCREPANCY REPORT');
  doc.font('Helvetica').fontSize(9).fillColor(COLORS.muted)
    .text(`Session ${shortId(session.id)} · ${(documents || []).length} documents · previous pipeline`);
  doc.moveDown(1);

  doc.font('Helvetica-Bold').fontSize(13).fillColor(COLORS.text)
    .text(`Readiness Score: ${session.readiness_score}/100`);
  doc.moveDown(1);

  const summary = session.summary_report && session.summary_report.summary;
  if (summary) {
    doc.font('Helvetica').fontSize(10).fillColor(COLORS.text)
      .text(stripMarkdown(summary), { width: doc.page.width - 100, lineGap: 3 });
    doc.moveDown(1);
  }

  for (const d of discrepancies || []) {
    if (doc.y > doc.page.height - 150) doc.addPage();

    doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.primary)
      .text(`${d.ref_code || ''}: ${d.metric_name || ''}`);
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.critical)
      .text(d.classification || '');
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.text)
      .text(d.description || '', { width: doc.page.width - 100 });
    if (d.follow_up_question) {
      doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(COLORS.muted)
        .text(`Question: ${d.follow_up_question}`, { width: doc.page.width - 100 });
    }
    doc.moveDown(0.8);
  }

  drawFooters(doc, session);
  doc.end();
}

// ── Helpers ────────────────────────────────────────────────────────────────────────────────────

function sectionHeading(doc, text) {
  doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.primary).text(text, 45, doc.y);
  doc.moveTo(45, doc.y + 1).lineTo(doc.page.width - 45, doc.y + 1)
    .strokeColor(COLORS.border).lineWidth(0.5).stroke();
  doc.moveDown(0.45);
}

/**
 * Approximate the height a finding block will need, so pagination can be decided before drawing.
 *
 * Approximate is fine - it only decides whether to break the page, and it errs generous. A block
 * that gets slightly more room than it needed is invisible; one that gets less loses text.
 */
function estimateHeight(doc, f, width) {
  let height = 34; // header lines

  const comp = f.computation || {};
  if (comp.substituted) {
    height += doc.font('Courier').fontSize(8.5).heightOfString(comp.substituted, { width: width - 26 }) + 18;
  }
  if (comp.expression) height += 11;
  if (f.narrative) {
    height += doc.font('Helvetica').fontSize(9).heightOfString(f.narrative, { width: width - 11 }) + 4;
  }
  if (f.factors) height += 20;

  const evidence = (f.evidence || []).slice(0, 6);
  height += evidence.length * 22 + (evidence.length > 0 ? 12 : 0);

  if (f.follow_up_question) {
    height += doc.font('Helvetica').fontSize(8.5).heightOfString(f.follow_up_question, { width: width - 11 }) + 16;
  }

  return height + 16;
}

function scoreColor(score) {
  if (score >= 85) return COLORS.good;
  if (score >= 70) return COLORS.medium;
  if (score >= 50) return COLORS.high;
  return COLORS.critical;
}

function bandColor(band) {
  if (band === 'CRITICAL') return COLORS.critical;
  if (band === 'HIGH') return COLORS.high;
  if (band === 'MEDIUM') return COLORS.medium;
  return COLORS.minor;
}

function truncate(text, max) {
  const s = String(text || '');
  return s.length <= max ? s : `${s.slice(0, max - 3)}...`;
}

function stripMarkdown(md) {
  if (!md) return '';
  return String(md)
    .replace(/`{3}[\s\S]*?`{3}/g, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/#+\s/g, '')
    .replace(/`/g, '');
}

function shortId(id) {
  return String(id).split('-')[0];
}

module.exports = { generatePdf, generateLegacyPdf };
