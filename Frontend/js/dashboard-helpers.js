window.DashboardHelpers = {
  escapeHTML: (str) => {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>'"]/g, 
      tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
      }[tag]));
  },
  getClassificationColor: (c) => {
    const map = {
      'VERIFIED_MISMATCH': 'var(--color-verified-mismatch)',
      'UNRESOLVED_INCONSISTENCY': 'var(--color-unresolved)',
      'MISSING_INFORMATION': 'var(--color-missing-info)',
      'UNUSUAL_ASSUMPTION_CHANGE': 'var(--color-unusual-assumption)',
      'VERIFIED_CONSISTENT': 'var(--color-verified-consistent)'
    };
    return map[c] || '#64748b';
  },
  getSeverityColor: (s) => {
    const map = {
      'CRITICAL': 'var(--color-critical)',
      'HIGH': 'var(--color-high)',
      'MEDIUM': 'var(--color-medium)',
      'MINOR': 'var(--color-minor)'
    };
    return map[s] || '#64748b';
  }
};
