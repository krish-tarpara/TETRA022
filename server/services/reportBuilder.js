/**
 * Pipeline orchestrator.
 *
 * Runs one analysis session end to end: parse, extract, verify, score, narrate, persist.
 *
 * The structure follows one principle - everything that can fail is isolated from everything that
 * cannot. Parsing and extraction touch the network and are allowed to fail per document. The
 * engine is pure arithmetic and cannot fail on valid input. Narration touches the network and is
 * allowed to fail entirely.
 *
 * So the pipeline degrades in stages rather than collapsing:
 *
 *   one document fails to parse  -> continue with the rest, warn the user
 *   the AI extractor is down     -> the session fails, honestly, with a clear reason
 *   the narrator is down         -> full report with templated prose, user barely notices
 *   the second opinion is down   -> the AI Notes tab shows unavailable, nothing else changes
 *
 * The only unrecoverable failure is losing the extractor, because without observations there is
 * nothing to verify. Everything downstream of extraction is guaranteed to produce a report.
 */

const db = require('../db/queries');
const parser = require('./parser');
const extractor = require('./ai/geminiExtractor');
const narrator = require('./ai/narrator');
const engine = require('../engine');
const rulepack = require('../engine/rulepack.json');

const ENGINE_VERSION = `engine-${rulepack.version}`;

async function runPipeline(sessionId, files, documentTypes, io, options = {}) {
  const emit = makeEmitter(io, sessionId);

  try {
    const fxRates = normalizeFxRates(options.fxRates);
    if (Object.keys(fxRates).length > 0) {
      await db.updateSessionFxRates(sessionId, fxRates);
    }

    // ── 1. Guard: cross-checking needs something to cross-check against ────────────────────
    const gate = validateInput(files, documentTypes);
    if (!gate.ok) {
      await db.updateSessionStatus(sessionId, 'insufficient_documents');
      emit('analysis:error', { error: gate.message, code: gate.code });
      return;
    }

    // ── 2. Parse and extract, per document, in parallel ────────────────────────────────────
    emit('status:update', {
      stage: 'parsing',
      message: `Reading ${files.length} document${files.length === 1 ? '' : 's'}...`,
      progress: { current: 0, total: files.length }
    });

    const perDocument = await Promise.allSettled(
      files.map((file, index) => processDocument({
        file, index, total: files.length,
        assignedType: documentTypes[index],
        sessionId, emit
      }))
    );

    const succeeded = perDocument
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);
    const failed = perDocument.filter(r => r.status === 'rejected');

    for (const failure of failed) {
      console.error(`Document processing failed in session ${sessionId}:`, failure.reason);
    }

    if (failed.length > 0) {
      emit('status:warning', {
        message: `${failed.length} of ${files.length} document(s) could not be processed. ` +
          `Continuing with the ${succeeded.length} that succeeded.`
      });
    }

    if (succeeded.length === 0) {
      await db.updateSessionStatus(sessionId, 'failed');
      emit('analysis:error', {
        error: 'No documents could be read. Check the file formats and try again.',
        code: 'all_documents_failed'
      });
      return;
    }

    const observations = succeeded.flatMap(d => d.observations);
    const documents = succeeded.map(d => ({
      document_id: d.document.id,
      document_category: d.document.document_category,
      original_filename: d.document.original_filename
    }));

    if (observations.length === 0) {
      // Every document parsed but nothing quotable came out. Almost always image-only PDFs.
      await db.updateSessionStatus(sessionId, 'failed');
      emit('analysis:error', {
        error: 'No financial figures could be extracted from these documents. ' +
          'They may be scanned images or contain no quantitative data.',
        code: 'no_observations'
      });
      return;
    }

    await db.insertObservations(observations);

    // ── 3. Cross-document sanity warnings ─────────────────────────────────────────────────
    warnOnCompanyMismatch(succeeded, emit);
    warnOnLowExtraction(succeeded, emit);

    // ── 4. Verify. Pure arithmetic, no network, cannot fail on valid input ─────────────────
    emit('status:update', { stage: 'analyzing', message: 'Running verification rules...' });

    const result = engine.verify(observations, { fxRates, documents });

    await db.insertFindings(sessionId, result.findings);

    const questions = aggregateQuestions(result.findings);

    await db.updateSessionEngineReport(sessionId, {
      score: result.score,
      breakdown: result.breakdown,
      executiveSummary: result.executive_summary,
      fxRates,
      questions,
      engineVersion: ENGINE_VERSION
    });

    // At this point the session is complete and scored. Everything after this is optional.
    emit('status:update', {
      stage: 'complete',
      message: `Verification complete. ${result.findings.length} findings.`
    });
    emit('analysis:complete', {
      sessionId,
      readinessScore: result.score,
      band: result.breakdown.band,
      findingCount: result.findings.length
    });

    // ── 5. Optional AI layer, after the user already has their report ──────────────────────
    runOptionalNarration(sessionId, result, emit).catch(err =>
      console.warn(`Optional narration failed for session ${sessionId}:`, err.message)
    );

  } catch (error) {
    // Anything unexpected. The engine is not supposed to throw, so reaching here means a real
    // bug - logged with the stack rather than swallowed.
    console.error(`Pipeline error for session ${sessionId}:`, error);
    emit('analysis:error', { error: error.message, code: 'pipeline_error' });
    db.updateSessionStatus(sessionId, 'failed').catch(console.error);
  }
}

/**
 * Parse one document and extract its observations.
 *
 * Throws on failure, which Promise.allSettled turns into one lost document rather than a lost
 * session. Records the reason on the document row so the UI can say which file failed and why.
 */
async function processDocument({ file, index, total, assignedType, sessionId, emit }) {
  const path = require('path');

  const document = await db.createDocument({
    sessionId,
    originalFilename: file.originalname,
    storedFilename: file.filename,
    fileType: path.extname(file.originalname).toLowerCase(),
    documentCategory: assignedType || 'unknown',
    fileSizeBytes: file.size
  });

  try {
    emit('status:update', {
      stage: 'parsing',
      message: `Reading ${file.originalname}...`,
      progress: { current: index + 1, total }
    });

    const { parsedContent, finalCategory } = await parser.parseDocument(
      { ...file, file_type: document.file_type },
      assignedType
    );

    if (!parsedContent || parsedContent.trim().length === 0) {
      throw new Error('Document parsed but contained no readable text');
    }

    await db.updateDocumentParsed(document.id, parsedContent, 0);

    emit('status:update', {
      stage: 'extracting',
      message: `Extracting figures from ${file.originalname}...`,
      progress: { current: index + 1, total }
    });

    const extraction = await extractor.extractObservations({
      ...document,
      session_id: sessionId,
      document_category: finalCategory,
      parsed_content: parsedContent
    });

    await db.updateDocumentExtractionStats(document.id, extraction.stats, extraction.company_name);

    return {
      document: { ...document, document_category: finalCategory },
      observations: extraction.observations,
      dropped: extraction.dropped,
      stats: extraction.stats,
      company_name: extraction.company_name
    };

  } catch (err) {
    await db.updateDocumentParseError(document.id, err.message).catch(() => {});
    emit('status:warning', {
      file: file.originalname,
      message: `Could not process ${file.originalname}: ${err.message}`
    });
    throw err;
  }
}

/**
 * Reject sessions that cannot produce meaningful cross-document verification.
 *
 * Better to refuse clearly at the start than to hand back a report whose score is dominated by a
 * coverage ceiling the user does not understand.
 */
function validateInput(files, documentTypes) {
  if (!files || files.length === 0) {
    return { ok: false, code: 'no_files', message: 'No files were uploaded.' };
  }

  if (files.length < rulepack.coverage.min_documents) {
    return {
      ok: false,
      code: 'too_few_documents',
      message: `At least ${rulepack.coverage.min_documents} documents are required. ` +
        `Cross-document verification needs something to compare against.`
    };
  }

  const types = new Set((documentTypes || []).filter(t => t && t !== 'unknown'));
  if (types.size < rulepack.coverage.min_document_types) {
    return {
      ok: false,
      code: 'too_few_document_types',
      message: `At least ${rulepack.coverage.min_document_types} different document types are ` +
        `required, for example a pitch deck and financial statements.`
    };
  }

  return { ok: true };
}

/**
 * Do all the documents describe the same company?
 *
 * A high-value warning: if someone uploads one company's deck alongside another's statements,
 * every cross-document finding is meaningless. Cheap to detect and catastrophic to miss.
 */
function warnOnCompanyMismatch(processed, emit) {
  const names = processed
    .map(d => d.company_name)
    .filter(Boolean)
    .map(n => n.toLowerCase().trim());

  const unique = [...new Set(names)];
  if (unique.length <= 1) return;

  // Substring overlap catches "Acme Technologies" vs "Acme Technologies Pvt Ltd", which is the
  // same company written two ways and not worth warning about.
  const allRelated = unique.every(a => unique.some(b => a !== b && (a.includes(b) || b.includes(a))));
  if (allRelated) return;

  emit('status:warning', {
    code: 'company_name_mismatch',
    message: `These documents appear to reference different companies (${unique.join(', ')}). ` +
      `Cross-document comparisons may not be meaningful.`
  });
}

/** Tell the user when a document yielded almost nothing, instead of letting it look clean. */
function warnOnLowExtraction(processed, emit) {
  for (const doc of processed) {
    const stats = doc.stats || {};

    if (doc.observations.length === 0) {
      emit('status:warning', {
        file: doc.document.original_filename,
        code: 'no_figures_extracted',
        message: `No figures could be extracted from ${doc.document.original_filename}. ` +
          `It may be a scanned image or contain no financial data.`
      });
      continue;
    }

    // A high discard rate means the model produced numbers it could not cite. Worth surfacing:
    // the document contributed far less evidence than its size suggests.
    const dropped = stats.dropped_count || 0;
    const total = dropped + doc.observations.length;
    if (total > 0 && dropped / total > 0.4) {
      emit('status:warning', {
        file: doc.document.original_filename,
        code: 'high_discard_rate',
        message: `${dropped} of ${total} figures from ${doc.document.original_filename} were ` +
          `discarded because they could not be traced to a quote in the document.`
      });
    }
  }
}

/**
 * Deduplicate and rank the follow-up questions.
 *
 * The consolidated list is what an investor actually sends the founder, so near-duplicates are
 * worse than useless - they make the sender look careless.
 */
function aggregateQuestions(findings) {
  const seen = new Map();

  const ranked = findings
    .filter(f => f.follow_up_question && f.classification !== 'VERIFIED_CONSISTENT')
    .sort((a, b) => b.severity_score - a.severity_score);

  for (const finding of ranked) {
    const key = normalizeForDedupe(finding.follow_up_question);
    if (seen.has(key)) continue;

    seen.set(key, {
      question: finding.follow_up_question,
      ref_code: finding.ref_code,
      classification: finding.classification,
      severity_band: finding.severity_band,
      severity_score: finding.severity_score,
      metric_key: finding.metric_key,
      priority: seen.size + 1
    });
  }

  return [...seen.values()].slice(0, 12);
}

/** Collapse wording differences so genuinely duplicate questions compare equal. */
function normalizeForDedupe(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\b(the|a|an|your|of|for|in|and|is|are|can|you|please|provide|which|what)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Prose and the second opinion, both after the report is already delivered.
 *
 * Runs the two concurrently and independently. Neither can affect the score, and neither can
 * prevent the other from succeeding.
 */
async function runOptionalNarration(sessionId, result, emit) {
  const [narration, notes] = await Promise.allSettled([
    narrator.narrate(result.findings, {
      score: result.score,
      band: result.breakdown.label
    }),
    narrator.secondOpinion(result.findings, result.breakdown)
  ]);

  if (narration.status === 'fulfilled' && narration.value.narrated) {
    await db.replaceFindings(sessionId, narration.value.findings);
    emit('report:updated', {
      sessionId,
      reason: 'narration',
      message: 'Plain-English explanations added.'
    });
  }

  if (notes.status === 'fulfilled' && notes.value) {
    await db.updateSessionAiNotes(sessionId, notes.value);
    emit('report:updated', {
      sessionId,
      reason: 'ai_notes',
      message: 'AI analyst notes available.'
    });
  }
}

/**
 * Accept exchange rates in whatever shape the client sent them.
 *
 * Multipart form fields arrive as strings, so a JSON body and a form upload deliver the same
 * data differently. Rejecting one of them would be an obscure bug to chase.
 */
function normalizeFxRates(raw) {
  if (!raw) return {};

  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn('Ignoring unparseable fxRates payload');
      return {};
    }
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const out = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'source' || key === 'as_of') {
      out[key] = value;
      continue;
    }
    const rate = Number(value);
    if (Number.isFinite(rate) && rate > 0) out[key] = rate;
  }

  return out;
}

/**
 * Socket emitter that cannot break the pipeline.
 *
 * A disconnected client, a closed namespace or a serialization error must never take down an
 * analysis that is otherwise succeeding - the report still lands in the database and the user can
 * reload to find it.
 */
function makeEmitter(io, sessionId) {
  return (event, data) => {
    try {
      if (!io) return;
      io.of('/analysis').to(`session:${sessionId}`).emit(event, { ...data, timestamp: Date.now() });
    } catch (err) {
      console.warn(`Socket emit failed (${event}):`, err.message);
    }
  };
}

module.exports = { runPipeline, aggregateQuestions, normalizeFxRates, validateInput };
