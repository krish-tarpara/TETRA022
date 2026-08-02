function aggregateQuestions(discrepancies) {
  // Rank by severity: VERIFIED_MISMATCH (15) > MISSING (10) > UNUSUAL (8) > UNRESOLVED (5)
  const severityMap = {
    'VERIFIED_MISMATCH': 15,
    'MISSING_INFORMATION': 10,
    'UNUSUAL_ASSUMPTION_CHANGE': 8,
    'UNRESOLVED_INCONSISTENCY': 5
  };

  const ranked = discrepancies
    .filter(d => d.followUpQuestion)
    .sort((a, b) => {
      const weightA = severityMap[a.classification] || 0;
      const weightB = severityMap[b.classification] || 0;
      return weightB - weightA;
    });

  // Basic deduplication (fuzzy match could be added here, but exact match for now)
  const seen = new Set();
  const uniqueQuestions = [];

  for (const d of ranked) {
    if (!seen.has(d.followUpQuestion)) {
      seen.add(d.followUpQuestion);
      uniqueQuestions.push({
        refCode: d.refCode || 'N/A',
        classification: d.classification,
        question: d.followUpQuestion,
        priority: uniqueQuestions.length + 1
      });
    }
  }

  return uniqueQuestions.slice(0, 10); // Return top 10
}

module.exports = { aggregateQuestions };
