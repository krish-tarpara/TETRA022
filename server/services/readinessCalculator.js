function calculateScore(discrepancies, uniqueDocTypes) {
  let mismatches = 0;
  let missing = 0;
  let unusual = 0;
  let inconsistencies = 0;

  discrepancies.forEach(d => {
    switch (d.classification) {
      case 'VERIFIED_MISMATCH': mismatches++; break;
      case 'MISSING_INFORMATION': missing++; break;
      case 'UNUSUAL_ASSUMPTION_CHANGE': unusual++; break;
      case 'UNRESOLVED_INCONSISTENCY': inconsistencies++; break;
    }
  });

  const baseScore = 100 - (mismatches * 15 + missing * 10 + unusual * 8 + inconsistencies * 5);

  // Coverage penalty
  // Ideal: 5 document types (Pitch Deck, Financials, MIS, Projections, Cap Table)
  const coverageRatio = Math.min(uniqueDocTypes.length / 5, 1);
  const coveragePenalty = Math.round((1 - coverageRatio) * 20);

  let finalScore = Math.max(0, baseScore - coveragePenalty);
  
  return {
    score: finalScore,
    mismatches,
    missing,
    unusual,
    inconsistencies
  };
}

module.exports = { calculateScore };
