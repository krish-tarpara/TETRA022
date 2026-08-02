function validateClaims(allExtractedMetrics) {
  const discrepancies = [];
  let discrepancyCount = 1;

  // Separate pitch deck metrics from others
  const pitchDeckMetrics = allExtractedMetrics.filter(m => m.documentCategory === 'pitch_deck');
  const otherMetrics = allExtractedMetrics.filter(m => m.documentCategory !== 'pitch_deck');

  // Check each pitch deck metric against all other metrics
  pitchDeckMetrics.forEach(pdMetric => {
    // Look for same normalized_name AND normalized_period in ANY other document
    const foundSupport = otherMetrics.some(om => 
      om.normalizedName === pdMetric.normalizedName && 
      om.normalizedPeriod === pdMetric.normalizedPeriod
    );

    if (!foundSupport) {
      discrepancies.push({
        refCode: `MISSING-CLAIM-${String(discrepancyCount).padStart(3, '0')}`,
        classification: 'MISSING_INFORMATION',
        severityWeight: 10,
        metricName: pdMetric.metricName,
        description: `Pitch deck claims ${pdMetric.metricName} = ${pdMetric.metricValue} for ${pdMetric.period}, but no supporting data found in any other uploaded document.`,
        sourceADocId: pdMetric.documentId,
        sourceAFilename: pdMetric.filename, // Note: caller must enrich these fields
        sourceAPage: pdMetric.sourcePage,
        sourceAValue: String(pdMetric.metricValue),
        sourceAContext: pdMetric.sourceContext,
        sourceBDocId: null,
        sourceBFilename: null,
        sourceBPage: null,
        sourceBValue: null,
        sourceBContext: null,
        variancePct: null,
        followUpQuestion: `Can you provide documentation to support the ${pdMetric.metricName} figure of ${pdMetric.metricValue} stated in your pitch deck?`,
        details: { sub_type: 'unsupported_claim' }
      });
      discrepancyCount++;
    }
  });

  return discrepancies;
}

module.exports = { validateClaims };
