function normalizePeriod(rawPeriod) {
  if (!rawPeriod) return 'Unknown';
  const p = String(rawPeriod).trim().toUpperCase();

  // "FY26" or "FY2026" or "2025-26" -> "FY2025-26"
  const fyRegex = /(?:FY)?(?:20)?(\d{2})(?:-(?:\d{2}))?$/;
  const match = p.match(fyRegex);
  if (match) {
    const yearEnd = parseInt(match[1]);
    const yearStart = yearEnd - 1;
    return `FY20${yearStart}-${yearEnd}`;
  }
  
  // "Q3 FY25" -> "Q3-FY2024-25"
  const qRegex = /Q([1-4]).*?(?:FY)?(?:20)?(\d{2})/;
  const qMatch = p.match(qRegex);
  if (qMatch) {
    const q = qMatch[1];
    const yearEnd = parseInt(qMatch[2]);
    const yearStart = yearEnd - 1;
    return `Q${q}-FY20${yearStart}-${yearEnd}`;
  }

  // Month-Year (e.g. "Mar-2025", "March 2025") -> "M03-FY2024-25" (Simplified)
  const monthNames = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  for (let i = 0; i < monthNames.length; i++) {
    if (p.includes(monthNames[i])) {
      const yearMatch = p.match(/20\d{2}/);
      if (yearMatch) {
        return `M${String(i + 1).padStart(2, '0')}-${yearMatch[0]}`;
      }
    }
  }

  return p; // Return as-is if no pattern matches
}

module.exports = { normalizePeriod };
