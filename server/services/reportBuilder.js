const db = require('../db/queries');
const parser = require('./parser');
const geminiExtractor = require('./ai/geminiExtractor');
const claimValidator = require('./claimValidator');
const comparisonMatrix = require('./comparisonMatrix');
const deepseekReasoner = require('./ai/deepseekReasoner');
const questionAggregator = require('./questionAggregator');
const readinessCalculator = require('./readinessCalculator');

async function runPipeline(sessionId, files, documentTypes, io) {
  try {
    const emit = (event, data) => io.of('/analysis').to(`session:${sessionId}`).emit(event, data);

    // 1 & 2. Metadata already saved partially, need to validate min docs
    if (files.length < 2) {
      await db.updateSessionStatus(sessionId, 'insufficient_documents');
      emit('analysis:error', { error: 'At least 2 documents are required for cross-verification.' });
      return;
    }

    const uniqueTypes = new Set(documentTypes.filter(t => t && t !== 'unknown'));
    if (uniqueTypes.size < 2) {
      await db.updateSessionStatus(sessionId, 'insufficient_documents');
      emit('analysis:error', { error: 'At least 2 different types of documents are required.' });
      return;
    }

    emit('status:update', { stage: 'parsing', message: 'Parsing documents...' });

    // 4. Parallel Parsing & Extraction
    const allMetrics = [];
    const savedDocs = [];

    const filePromises = files.map(async (file, index) => {
      const assignedType = documentTypes[index];
      
      // Save doc record
      const docRecord = await db.createDocument({
        sessionId,
        originalFilename: file.originalname,
        storedFilename: file.filename,
        fileType: require('path').extname(file.originalname).toLowerCase(),
        documentCategory: assignedType,
        fileSizeBytes: file.size
      });
      savedDocs.push(docRecord);

      emit('status:update', { stage: 'parsing', message: `Parsing ${file.originalname}...`, progress: { current: index + 1, total: files.length } });
      const { parsedContent, finalCategory } = await parser.parseDocument({ ...file, file_type: docRecord.file_type }, assignedType);
      
      await db.updateDocumentParsed(docRecord.id, parsedContent, 0); // page count mock

      emit('status:update', { stage: 'extracting', message: `Extracting metrics from ${file.originalname}...`, progress: { current: index + 1, total: files.length } });
      const docWithContent = { ...docRecord, parsed_content: parsedContent, document_category: finalCategory };
      const extractedMetrics = await geminiExtractor.extractMetrics(docWithContent);

      if (extractedMetrics.length === 0) {
        emit('status:warning', { file: file.originalname, message: 'No financial metrics could be extracted.' });
      }

      await db.updateDocumentExtracted(docRecord.id, extractedMetrics);
      
      // Add filename and normalize to camelCase for downstream use
      const enrichedMetrics = extractedMetrics.map(m => ({
        sessionId: m.session_id,
        documentId: m.document_id,
        documentCategory: finalCategory,
        filename: file.originalname,
        companyName: m.company_name,
        metricName: m.metric_name,
        normalizedName: m.normalized_name,
        metricCategory: m.metric_category,
        metricValue: m.value,
        metricUnit: m.unit,
        period: m.period,
        normalizedPeriod: m.normalized_period,
        sourcePage: m.source_page,
        sourceRowText: m.source_row_text || '',
        sourceContext: m.source_context,
        confidence: m.confidence,
        metricCurrency: m.metric_currency,
        periodType: m.period_type
      }));
      allMetrics.push(...enrichedMetrics);
      return enrichedMetrics;
    });

    const results = await Promise.allSettled(filePromises);
    
    // 5. Check Partial Failures
    const failedDocs = results.filter(r => r.status === 'rejected');
    if (failedDocs.length > 0) {
      emit('status:warning', { message: `${failedDocs.length} documents failed processing, but continuing with the rest.` });
    }

    if (allMetrics.length === 0) {
      throw new Error('No metrics could be extracted from any document.');
    }

    await db.insertExtractedMetrics(allMetrics);

    // 6. Validate Company Names
    const names = allMetrics.map(m => m.company_name?.toLowerCase().trim()).filter(Boolean);
    const uniqueNames = [...new Set(names)];
    if (uniqueNames.length > 1) {
      emit('status:warning', { message: `Documents reference different companies: ${uniqueNames.join(', ')}` });
    }

    // 7. Claim Validation Pass
    emit('status:update', { stage: 'validating', message: 'Running programmatic claim validation...' });
    const claimDiscrepancies = claimValidator.validateClaims(allMetrics);

    // 8. Build Comparison Matrix
    emit('status:update', { stage: 'analyzing', message: 'Building cross-document comparison matrix...' });
    const matrixResult = comparisonMatrix.buildMatrix(allMetrics);

    // 9. AI Reasoning
    emit('status:update', { stage: 'analyzing', message: 'Running DeepSeek-R1 deep reasoning analysis...' });
    const analysisResult = await deepseekReasoner.analyzeDiscrepancies({
      matrix: matrixResult.matrix,
      claim_discrepancies: claimDiscrepancies
    });

    // Map AI discrepancies to camelCase
    const severityMap = {
      'VERIFIED_MISMATCH': 15,
      'MISSING_INFORMATION': 10,
      'UNUSUAL_ASSUMPTION_CHANGE': 8,
      'UNRESOLVED_INCONSISTENCY': 5
    };
    
    const aiDiscrepancies = (analysisResult.parsedData.discrepancies || []).map(d => ({
      refCode: d.ref_code,
      classification: d.classification,
      severityWeight: severityMap[d.classification] || 0,
      metricName: d.metric_name,
      description: d.description,
      sourceADocId: null,
      sourceAFilename: d.source_a?.filename,
      sourceAPage: d.source_a?.page,
      sourceAValue: String(d.source_a?.value || ''),
      sourceAContext: d.source_a?.context,
      sourceBDocId: null,
      sourceBFilename: d.source_b?.filename,
      sourceBPage: d.source_b?.page,
      sourceBValue: String(d.source_b?.value || ''),
      sourceBContext: d.source_b?.context,
      variancePct: d.variance_pct,
      followUpQuestion: d.follow_up_question,
      details: {}
    }));

    // Merge discrepancies and inject sessionId
    const allDiscrepancies = [...claimDiscrepancies, ...aiDiscrepancies].map(d => ({
      ...d,
      sessionId
    }));

    await db.insertDiscrepancies(allDiscrepancies);

    // 12. Aggregate Questions
    const followUpQuestions = questionAggregator.aggregateQuestions(allDiscrepancies);

    // 13. Calculate Score
    const extractedTypes = [...new Set(savedDocs.map(d => d.document_category))];
    const scoreData = readinessCalculator.calculateScore(allDiscrepancies, extractedTypes);

    // 14. Update Session
    const finalReport = {
      summary: analysisResult.parsedData.summary,
      matrix: matrixResult,
      metricsCount: allMetrics.length
    };

    await db.updateSessionReport(sessionId, {
      ...scoreData,
      report: finalReport,
      questions: followUpQuestions,
      reasoning: analysisResult.reasoningChain,
      model: analysisResult.modelUsed
    });

    emit('status:update', { stage: 'complete', message: 'Analysis complete!' });
    emit('analysis:complete', { sessionId, readinessScore: scoreData.score });

  } catch (error) {
    console.error(`Pipeline error for session ${sessionId}:`, error);
    io.of('/analysis').to(`session:${sessionId}`).emit('analysis:error', { error: error.message });
    db.updateSessionStatus(sessionId, 'failed').catch(console.error);
  }
}

module.exports = { runPipeline };
