function buildMatrix(allExtractedMetrics) {
  // Structure: { [normalizedName_normalizedPeriod]: { pitch_deck: metric, financial_statements: metric, ... } }
  const matrixMap = {};

  allExtractedMetrics.forEach(metric => {
    const key = `${metric.normalizedName}_${metric.normalizedPeriod}`;
    if (!matrixMap[key]) {
      matrixMap[key] = {
        metricName: metric.normalizedName,
        period: metric.normalizedPeriod,
        values: {},
        currencies: new Set()
      };
    }
    
    // Store first occurrence per document category (or ideally average/sum if multiple, but we simplify to first)
    if (!matrixMap[key].values[metric.documentCategory]) {
      matrixMap[key].values[metric.documentCategory] = {
        value: metric.metricValue,
        page: metric.sourcePage,
        context: metric.sourceContext,
        currency: metric.metricCurrency
      };
      if (metric.metricCurrency) matrixMap[key].currencies.add(metric.metricCurrency);
    }
  });

  const matrix = [];
  let verifiedConsistent = 0;
  let discrepanciesFound = 0;
  let partialCoverage = 0;

  for (const key in matrixMap) {
    const row = matrixMap[key];
    const docCategories = Object.keys(row.values);
    let status = 'PARTIAL_COVERAGE';
    let maxVariance = 0;

    if (docCategories.length > 1) {
      // We have multiple documents claiming this metric
      if (row.currencies.size > 1) {
        status = 'UNRESOLVED_INCONSISTENCY'; // Currency mismatch
        discrepanciesFound++;
      } else {
        // Calculate max variance
        let minVal = Infinity;
        let maxVal = -Infinity;
        docCategories.forEach(cat => {
          const val = Number(row.values[cat].value);
          if (!isNaN(val)) {
            minVal = Math.min(minVal, val);
            maxVal = Math.max(maxVal, val);
          }
        });

        if (minVal !== Infinity && minVal !== 0) {
          maxVariance = ((maxVal - minVal) / Math.abs(minVal)) * 100;
          if (maxVariance <= 1) {
            status = 'VERIFIED_CONSISTENT';
            verifiedConsistent++;
          } else if (maxVariance <= 2) {
            status = 'UNRESOLVED_INCONSISTENCY';
            discrepanciesFound++;
          } else {
            status = 'VERIFIED_MISMATCH';
            discrepanciesFound++;
          }
        }
      }
    } else {
      partialCoverage++;
    }

    row.status = status;
    row.maxVariance = maxVariance;
    matrix.push(row);
  }

  return {
    matrix,
    verified_consistent: verifiedConsistent,
    discrepancies_found: discrepanciesFound,
    partial_coverage: partialCoverage
  };
}

module.exports = { buildMatrix };
