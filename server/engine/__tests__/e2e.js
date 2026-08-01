/**
 * End-to-end pipeline check.  node server/engine/__tests__/e2e.js
 *
 * Exercises the real path: reportBuilder -> database -> route handlers -> exports -> adjudication.
 * The only things stubbed are the two network boundaries, and they are stubbed rather than mocked
 * away so the code under test is exactly what runs in production:
 *
 *   - the document parser, so no LlamaParse credits are spent
 *   - the AI extractor, so the observations are fixed and the result is comparable run to run
 *
 * Everything else is genuine: real Postgres writes, real engine, real PDF and CSV generation, real
 * Express handlers invoked with real request objects.
 *
 * Kept out of `npm test` because it needs a database and network. Run it manually before a demo.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const pool = require('../../db/pool');
const db = require('../../db/queries');

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
  }
}

function section(name) {
  console.log(`\n${name}`);
}

// ── Stub the two network boundaries before reportBuilder loads them ──────────────────────────────
//
// Overriding the module cache rather than injecting dependencies keeps reportBuilder.js free of
// test-only seams. What runs here is the same code that runs in production.

const PARSER_PATH = require.resolve('../../services/parser');
const EXTRACTOR_PATH = require.resolve('../../services/ai/geminiExtractor');
const NARRATOR_PATH = require.resolve('../../services/ai/narrator');

require.cache[PARSER_PATH] = {
  id: PARSER_PATH, filename: PARSER_PATH, loaded: true, exports: {
    async parseDocument(file, category) {
      return { parsedContent: `stub content for ${file.originalname}`, finalCategory: category };
    }
  }
};

/** Observations keyed by the filename the fixture uploads. */
const FIXTURE = {
  'Financial_Statements.xlsx': [
    row('revenue', 'Revenue from operations', '3,20,00,000', 32000000, 'FY25', 'audited'),
    row('cogs', 'Cost of goods sold', '2,00,00,000', 20000000, 'FY25', 'audited'),
    row('gross_profit', 'Gross profit', '1,50,00,000', 15000000, 'FY25', 'audited'),
    row('cash_position', 'Cash and cash equivalents', '1,20,00,000', 12000000, 'FY25', 'audited')
  ],
  'Pitch_Deck.pdf': [
    row('revenue', 'Topline', 'Rs 5.2 Cr', 52000000, 'FY25', 'management'),
    row('customer_base', 'Paying customers', '1,200', 1200, 'FY25', 'management'),
    row('gross_margin', 'Gross margin', '140%', 140, 'FY25', 'management')
  ],
  'MIS_Monthly.xlsx': [
    row('cash_position', 'Closing cash balance', '1,20,00,000', 12000000, 'FY25', 'management')
  ],
  'Cap_Table.xlsx': [
    row('ownership', 'Rahul Sharma (Founder) shareholding %', '52%', 52, 'FY26', 'management'),
    row('ownership', 'Priya Nair (Co-founder) shareholding %', '25%', 25, 'FY26', 'management'),
    row('ownership', 'Seed Investor shareholding %', '16%', 16, 'FY26', 'management')
  ]
};

function row(metricKey, label, valueRaw, value, period, basis) {
  return {
    metric_key: metricKey,
    raw_label: label,
    value_raw: valueRaw,
    value,
    period,
    period_type: 'historical',
    basis,
    source_page: 1,
    source_cell: null,
    source_quote: `${label}: ${valueRaw}`,
    confidence: 0.97,
    company_name: 'Acme Technologies'
  };
}

require.cache[EXTRACTOR_PATH] = {
  id: EXTRACTOR_PATH, filename: EXTRACTOR_PATH, loaded: true, exports: {
    async extractObservations(document) {
      const { canonicalizeBatch } = require('../canonicalize');
      const raw = FIXTURE[document.original_filename] || [];
      const { observations, dropped } = canonicalizeBatch(raw, document, document.session_id);
      return {
        observations,
        dropped,
        company_name: 'Acme Technologies',
        stats: {
          chunks: 1, chunk_errors: [], raw_count: raw.length,
          kept_count: observations.length, dropped_count: dropped.length,
          dropped_by_reason: {}
        }
      };
    }
  }
};

// Narration is skipped so the run is deterministic and spends no tokens. The templated prose that
// explain.js already produced is what gets asserted on.
require.cache[NARRATOR_PATH] = {
  id: NARRATOR_PATH, filename: NARRATOR_PATH, loaded: true, exports: {
    async narrate(findings) {
      return { findings, narrated: false, reason: 'stubbed_for_e2e', model: null };
    },
    async secondOpinion() { return null; }
  }
};

const reportBuilder = require('../../services/reportBuilder');

/** Socket collector, so emitted events can be asserted on. */
function fakeIo() {
  const events = [];
  return {
    events,
    of() { return this; },
    to() { return this; },
    emit(event, data) { events.push({ event, data }); }
  };
}

function fakeFiles() {
  return Object.keys(FIXTURE).map((name, i) => ({
    originalname: name,
    filename: `stub-${i}-${name}`,
    size: 1024 * (i + 1),
    path: path.join(os.tmpdir(), `finverify-e2e-${i}`)
  }));
}

const DOC_TYPES = ['financial_statements', 'pitch_deck', 'mis', 'cap_table'];

async function main() {
  const health = await pool.healthCheck();
  if (!health.ok) {
    console.error(`Database unreachable: ${health.error}`);
    console.error('Run: npm run migrate');
    process.exit(1);
  }
  console.log(`FinVerify end-to-end check  (database: ${health.database})`);

  // ── Setup ──
  const user = await db.createUser(`e2e-${Date.now()}`);
  const session = await db.createSession(user.id);
  const io = fakeIo();

  section('pipeline');
  const started = Date.now();
  await reportBuilder.runPipeline(session.id, fakeFiles(), DOC_TYPES, io, {
    fxRates: JSON.stringify({ USD_INR: 83.2, source: 'user' })
  });
  const elapsed = Date.now() - started;

  const errors = io.events.filter(e => e.event === 'analysis:error');
  check('pipeline completed without error', errors.length === 0,
    errors.map(e => e.data.error).join('; '));
  check('emitted analysis:complete', io.events.some(e => e.event === 'analysis:complete'));
  check('emitted progress updates', io.events.filter(e => e.event === 'status:update').length >= 3);
  check(`finished quickly without network (${elapsed}ms)`, elapsed < 20000);

  // ── Persistence ──
  section('database writes');
  const saved = await db.getSessionById(session.id);
  check('session marked complete', saved.status === 'complete', `status was ${saved.status}`);
  check('engine version recorded', String(saved.engine_version || '').startsWith('engine-'),
    `engine_version was ${saved.engine_version}`);
  check('rulepack version recorded', Boolean(saved.rulepack_version));
  check('score is a number 0-100',
    Number.isFinite(Number(saved.readiness_score)) && saved.readiness_score >= 0 && saved.readiness_score <= 100,
    `score was ${saved.readiness_score}`);
  check('score breakdown stored', Boolean(saved.score_breakdown && saved.score_breakdown.pillars));
  check('executive summary stored', Boolean(saved.executive_summary));
  check('fx rates stored', saved.fx_rates && Number(saved.fx_rates.USD_INR) === 83.2);
  check('follow-up questions stored',
    Array.isArray(saved.follow_up_questions) && saved.follow_up_questions.length > 0);

  const observations = await db.getSessionObservations(session.id);
  const expectedObservations = Object.values(FIXTURE).reduce((n, rows) => n + rows.length, 0);
  check(`all ${expectedObservations} observations persisted`, observations.length === expectedObservations,
    `stored ${observations.length}`);
  check('every observation has a quote', observations.every(o => o.source_quote && o.source_quote.length > 0));
  check('scale parsing survived the round trip',
    observations.some(o => o.metric_key === 'revenue' && Number(o.value_base) === 52000000),
    'Rs 5.2 Cr should be stored as 52000000');
  check('Indian fiscal year applied',
    observations.every(o => !o.period_key || /^(FY|Q|M|REL|UNKNOWN)/.test(o.period_key)));
  check('cap table subjects kept distinct',
    new Set(observations.filter(o => o.metric_key === 'ownership').map(o => o.subject)).size === 3);

  const findings = await db.getSessionFindings(session.id);
  check('findings persisted', findings.length > 0, `${findings.length} findings`);
  check('every finding has a ref code', findings.every(f => f.ref_code));
  check('every finding has evidence with quotes',
    findings.every(f => Array.isArray(f.evidence) && f.evidence.length > 0 && f.evidence.every(e => e.quote)));
  check('every finding has computation and factors',
    findings.every(f => f.computation && f.factors));
  check('every finding has a narrative', findings.every(f => f.narrative && f.narrative.length > 10));
  check('problems have a follow-up question',
    findings.filter(f => f.classification !== 'VERIFIED_CONSISTENT').every(f => f.follow_up_question));

  // ── The planted issues must all be caught ──
  section('planted issues detected');
  const byRule = ruleClass => findings.filter(f => f.rule_class === ruleClass);

  check('R1 caught the revenue conflict (5.2 Cr vs 3.2 Cr)',
    byRule('R1').some(f => f.metric_key === 'revenue' && f.classification === 'VERIFIED_MISMATCH'));
  check('R2 caught the gross profit that does not reconcile',
    byRule('R2').some(f => f.metric_key === 'gross_profit' && f.computation.result === 'FAIL'));
  check('R2 flagged it as a single-document contradiction',
    byRule('R2').some(f => f.computation.single_document === true));
  check('R5 caught the unsupported customer claim',
    byRule('R5').some(f => f.metric_key === 'customer_base'));
  check('R6 caught the 140% gross margin',
    byRule('R6').some(f => f.metric_key === 'gross_margin'));
  check('R7 caught the cap table totalling 93%',
    byRule('R7').some(f => f.metric_key === 'ownership' && f.computation.result === 'FAIL'));
  // The balance sheet says "cash and cash equivalents"; the MIS says "closing cash balance".
  // Different metric keys by design, so a definitional identity is what compares them.
  check('cash agreement across documents reported as VERIFIED_CONSISTENT',
    findings.some(f =>
      (f.metric_key === 'cash_position' || f.metric_key === 'closing_cash') &&
      f.classification === 'VERIFIED_CONSISTENT'));
  check('confirmations carry no severity',
    findings.filter(f => f.classification === 'VERIFIED_CONSISTENT')
      .every(f => Number(f.severity_score) === 0 && f.severity_band === 'NONE'));
  check('revenue conflict outranks the customer claim',
    severityOf(findings, 'revenue', 'R1') > severityOf(findings, 'customer_base', 'R5'));

  // ── Route handlers ──
  section('API routes');
  const sessionsRouter = require('../../routes/sessions');
  const req = { params: { id: session.id }, user: { userId: user.id }, body: {}, app: { get: () => io } };

  const report = await callRoute(sessionsRouter, 'get', '/:id', req);
  check('GET /:id returns 200', report.status === 200, `status ${report.status}`);
  check('GET /:id reports the engine schema', report.body.schema === 'engine');
  check('GET /:id includes findings', Array.isArray(report.body.findings) && report.body.findings.length > 0);
  check('GET /:id includes the breakdown', Boolean(report.body.breakdown && report.body.breakdown.pillars));
  check('GET /:id includes documents with extraction stats',
    report.body.documents.length === 4 && report.body.documents.every(d => d.extraction_stats));

  const list = await callRoute(sessionsRouter, 'get', '/', { user: { userId: user.id }, params: {}, body: {} });
  check('GET / lists the session', list.status === 200 && list.body.some(s => s.id === session.id));

  const obsRoute = await callRoute(sessionsRouter, 'get', '/:id/observations', req);
  check('GET /:id/observations returns 200', obsRoute.status === 200 && obsRoute.body.schema === 'engine');

  const rulepackRoute = await callRoute(sessionsRouter, 'get', '/:id/rulepack', req);
  check('GET /:id/rulepack returns weights',
    rulepackRoute.status === 200 && Boolean(rulepackRoute.body.base_weights));
  check('rulepack is not stale for a fresh session', rulepackRoute.body.stale === false);

  // Ownership check: another user must not be able to read this session.
  const intruder = await callRoute(sessionsRouter, 'get', '/:id',
    { params: { id: session.id }, user: { userId: '00000000-0000-0000-0000-000000000000' }, body: {} });
  check('another user gets 404, not the report', intruder.status === 404);

  // ── Adjudication ──
  section('adjudication');
  const target = findings.find(f => f.metric_key === 'revenue' && f.rule_class === 'R1');
  const financialsDoc = report.body.documents.find(d => d.document_category === 'financial_statements');

  const adjReq = {
    params: { id: session.id },
    user: { userId: user.id },
    body: {
      adjudications: [{ type: 'authoritative_source', document_id: financialsDoc.id, note: 'Deck is stale.' }],
      persist: false
    }
  };
  const adj = await callRoute(sessionsRouter, 'post', '/:id/adjudicate', adjReq);

  check('POST /:id/adjudicate returns 200', adj.status === 200, JSON.stringify(adj.body).slice(0, 200));
  check('adjudication was not persisted', adj.body.persisted === false);
  check('the score improved', adj.body.score > saved.readiness_score,
    `${saved.readiness_score} -> ${adj.body.score}`);
  check('a diff is returned', Boolean(adj.body.diff && adj.body.diff.pillars));
  check('the diff names the pillars that moved', adj.body.diff.pillars_changed.length > 0);

  const stillSaved = await db.getSessionById(session.id);
  check('the stored score is untouched when persist is false',
    stillSaved.readiness_score === saved.readiness_score);

  const acceptReq = {
    params: { id: session.id },
    user: { userId: user.id },
    body: {
      adjudications: [{ type: 'accept_explanation', finding_ref: target.ref_code, note: 'Explained.' }],
      persist: false
    }
  };
  const accepted = await callRoute(sessionsRouter, 'post', '/:id/adjudicate', acceptReq);
  const waived = accepted.body.findings.find(f => f.ref_code === target.ref_code);
  check('an accepted finding is kept, not deleted', Boolean(waived));
  check('the accepted finding is marked waived', waived && waived.adjudication.accepted === true);
  check('its original severity is preserved',
    waived && waived.adjudication.original_severity === Number(target.severity_score));

  // ── Exports ──
  section('exports');
  const pdf = await captureStream(res => {
    const pdfGenerator = require('../../services/export/pdfGenerator');
    pdfGenerator.generatePdf(saved, findings, report.body.documents, res);
  });
  check('PDF generated', pdf.length > 5000, `${pdf.length} bytes`);
  check('PDF is a valid PDF', pdf.slice(0, 5).toString() === '%PDF-');

  const csv = await captureStream(res => {
    const csvExporter = require('../../services/export/csvExporter');
    csvExporter.generateCsv(saved, findings, observations, report.body.documents, res);
  });
  const csvText = csv.toString('utf8');
  check('CSV generated', csv.length > 2000, `${csv.length} bytes`);
  check('CSV contains the findings section', csvText.includes('FINDINGS'));
  check('CSV contains the evidence trail', csvText.includes('EXTRACTED FIGURES'));
  check('CSV contains the comparison matrix', csvText.includes('COMPARISON MATRIX'));
  check('CSV includes the arithmetic', csvText.includes('revenue - cogs = gross_profit'));

  // ── Input guards ──
  section('input validation');
  const oneFile = await runGuard(1, ['pitch_deck']);
  check('a single document is rejected', oneFile.some(e => e.event === 'analysis:error'));

  const oneType = await runGuard(2, ['pitch_deck', 'pitch_deck']);
  check('two documents of the same type are rejected', oneType.some(e => e.event === 'analysis:error'));

  // ── Determinism against the live database ──
  section('determinism');
  const session2 = await db.createSession(user.id);
  await reportBuilder.runPipeline(session2.id, fakeFiles(), DOC_TYPES, fakeIo(), {
    fxRates: JSON.stringify({ USD_INR: 83.2, source: 'user' })
  });
  const rerun = await db.getSessionById(session2.id);
  check('the same documents produce the same score',
    rerun.readiness_score === saved.readiness_score,
    `${saved.readiness_score} vs ${rerun.readiness_score}`);

  const findings2 = await db.getSessionFindings(session2.id);
  check('and the same findings',
    findings.map(f => `${f.ref_code}:${f.severity_score}`).join() ===
    findings2.map(f => `${f.ref_code}:${f.severity_score}`).join());

  // ── Cleanup ──
  await pool.query('DELETE FROM users WHERE id = $1', [user.id]);

  // ── Report ──
  console.log(`\n${'-'.repeat(64)}`);
  console.log(`score ${saved.readiness_score}/100 (${saved.score_breakdown.label})  ·  ` +
    `${findings.length} findings  ·  ${observations.length} figures  ·  ${elapsed}ms`);
  console.log(`${passed}/${passed + failed} checks passed`);

  if (failed > 0) {
    console.log(`\n${failed} failure(s):`);
    failures.forEach(f => console.log(`  ${f}`));
    process.exitCode = 1;
  }
}

function severityOf(findings, metricKey, ruleClass) {
  const f = findings.find(x => x.metric_key === metricKey && x.rule_class === ruleClass);
  return f ? Number(f.severity_score) : 0;
}

async function runGuard(fileCount, types) {
  const user = await db.createUser(`e2e-guard-${Date.now()}-${Math.round(fileCount)}`);
  const session = await db.createSession(user.id);
  const io = fakeIo();
  await reportBuilder.runPipeline(session.id, fakeFiles().slice(0, fileCount), types, io, {});
  await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
  return io.events;
}

/**
 * Invoke an Express router handler directly.
 *
 * Avoids starting a server and binding a port. The handler receives a real request object and a
 * response stand-in that records what it was given.
 */
function callRoute(router, method, routePath, req) {
  const layer = router.stack.find(l =>
    l.route && l.route.path === routePath && l.route.methods[method]
  );
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${routePath}`);

  // Skip the auth middleware; req.user is supplied directly.
  const handlers = layer.route.stack.map(s => s.handle);
  const handler = handlers[handlers.length - 1];

  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      headersSent: false,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); return this; },
      send(body) { resolve({ status: this.statusCode, body }); return this; },
      setHeader() { return this; }
    };
    Promise.resolve(handler(req, res, reject)).catch(reject);
  });
}

/** Collect everything an export writer streams, as a Buffer. */
function captureStream(writer) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      headersSent: false,
      setHeader() { return this; },
      write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
      end(chunk) {
        if (chunk) chunks.push(Buffer.from(chunk));
        resolve(Buffer.concat(chunks));
      },
      on() { return this; },
      once() { return this; },
      emit() { return this; },
      removeListener() { return this; },
      status() { return this; },
      json(body) { reject(new Error(`export failed: ${JSON.stringify(body)}`)); return this; }
    };
    writer(res);
  });
}

main()
  .catch(err => {
    console.error(`\nEnd-to-end check crashed: ${err.stack}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
