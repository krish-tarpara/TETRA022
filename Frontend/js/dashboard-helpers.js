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

  /** Map classification enum to CSS class suffix for badge styling */
  getClassificationBadgeClass: (c) => {
    const map = {
      'VERIFIED_MISMATCH': 'badge-verified-mismatch',
      'UNRESOLVED_INCONSISTENCY': 'badge-unresolved',
      'MISSING_INFORMATION': 'badge-missing-info',
      'UNUSUAL_ASSUMPTION_CHANGE': 'badge-unusual-assumption',
      'VERIFIED_CONSISTENT': 'badge-verified-consistent'
    };
    return map[c] || '';
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

  /** Human-readable label for the classification enum */
  getClassificationLabel: (c) => {
    const map = {
      'VERIFIED_MISMATCH': 'Verified Mismatch',
      'UNRESOLVED_INCONSISTENCY': 'Could Not Verify',
      'MISSING_INFORMATION': 'Missing Information',
      'UNUSUAL_ASSUMPTION_CHANGE': 'Unusual Assumption',
      'VERIFIED_CONSISTENT': 'Verified Consistent'
    };
    return map[c] || c.replace(/_/g, ' ');
  },

  getSeverityColor: (band) => {
    const map = {
      'CRITICAL': 'var(--color-critical)',
      'HIGH': 'var(--color-high)',
      'MEDIUM': 'var(--color-medium)',
      'MINOR': 'var(--color-minor)'
    };
    return map[String(band).toUpperCase()] || '#64748b';
  },

  /**
   * Convert backend period key to human-readable display.
   * FY2025-26 stays as-is. M03-FY2024-25 → "March 2025".
   * Q3-FY2024-25 → "Q3 FY2024-25". REL-Y1 → "Year 1 (projected)".
   * UNKNOWN → "Period not stated".
   */
  formatPeriodKey: (key) => {
    if (!key || key === 'UNKNOWN') return 'Period not stated';
    if (key.startsWith('REL-')) return key.replace('REL-Y', 'Year ') + ' (projected)';

    // Monthly: M03-FY2024-25 → March 2025
    const monthMatch = key.match(/^M(\d{2})-FY(\d{4})-(\d{2})$/);
    if (monthMatch) {
      const monthNum = parseInt(monthMatch[1], 10);
      const fyStart = parseInt(monthMatch[2], 10);
      const months = ['', 'January', 'February', 'March', 'April', 'May', 'June',
                       'July', 'August', 'September', 'October', 'November', 'December'];
      // Indian FY: April=M01 means April of fyStart year. M01-M12 maps to Apr-Mar.
      // Actually: M03 of FY2024-25 = March 2025 (last month of that FY)
      // Months 1-3 (Jan-Mar) belong to the second year of FY, months 4-12 (Apr-Dec) to the first
      const calYear = monthNum <= 3 ? fyStart + 1 : fyStart;
      return `${months[monthNum] || `Month ${monthNum}`} ${calYear}`;
    }

    // Quarterly: Q3-FY2024-25
    const qMatch = key.match(/^Q(\d)-FY(\d{4})-(\d{2})$/);
    if (qMatch) return `Q${qMatch[1]} FY${qMatch[2]}-${qMatch[3]}`;

    // Annual: FY2025-26 — pass through
    return key;
  },

  /**
   * Format a number in Indian lakh/crore grouping.
   * 52000000 → "₹5,20,00,000"
   */
  formatIndianNumber: (num) => {
    if (num === null || num === undefined) return '';
    const n = Number(num);
    if (!Number.isFinite(n)) return String(num);
    const neg = n < 0;
    const abs = Math.abs(n);
    const str = Math.round(abs).toString();

    if (str.length <= 3) return (neg ? '-' : '') + '₹' + str;

    // Indian grouping: last 3, then pairs
    let result = str.slice(-3);
    let rest = str.slice(0, -3);
    while (rest.length > 0) {
      result = rest.slice(-2) + ',' + result;
      rest = rest.slice(0, -2);
    }
    return (neg ? '-' : '') + '₹' + result;
  },

  /**
   * Render the severity factors as a multiplication chain.
   * factors is an OBJECT: { base, materiality, confidence, direction, corroboration }
   */
  renderFactorsChain: (factors, severityScore, severityBand) => {
    if (!factors || typeof factors !== 'object') return '';

    const H = window.DashboardHelpers.escapeHTML;
    const dirNote = window.DashboardHelpers.getDirectionNote(factors.direction);

    return `<details class="factors-chain">
      <summary>Why this score? (${H(severityScore)} ${H(severityBand)})</summary>
      <table class="factors-table">
        <tr><td>Base (documents disagree)</td><td>${H(factors.base)}</td></tr>
        <tr><td>× Materiality</td><td>${H(factors.materiality)}</td></tr>
        <tr><td>× Confidence</td><td>${H(factors.confidence)}</td></tr>
        <tr><td>× Direction</td><td>${H(factors.direction)}</td></tr>
        <tr><td>× Corroboration</td><td>${H(factors.corroboration)}</td></tr>
        <tr><td>= Severity</td><td>${H(severityScore)}  ${H(severityBand)}</td></tr>
      </table>
      ${dirNote}
    </details>`;
  },

  /** Explain what the direction factor means in plain language */
  getDirectionNote: (directionVal) => {
    if (directionVal === null || directionVal === undefined) return '';
    const d = Number(directionVal);
    if (d > 1) {
      return '<div class="direction-note overstates">⚠ Error makes the company look better — weighted higher</div>';
    } else if (d < 1) {
      return '<div class="direction-note understates">Company understated — weighted lower</div>';
    }
    return '';
  },

  /** Render an evidence card (used in both finding cards and modal) */
  renderEvidenceCard: (e) => {
    const H = window.DashboardHelpers.escapeHTML;
    const filename = e.filename || e.original_filename || 'Unknown document';
    const page = e.page != null ? `p.${e.page}` : '';
    const cell = e.cell ? ` · ${e.cell}` : '';
    const quote = e.quote || '';
    const valueRaw = e.value_raw || '';

    return `<div class="evidence-card">
      <div class="evidence-card-header">
        <span>${H(filename)}</span>
        <span class="page-tag">${page ? H(page) + H(cell) : '—'}</span>
      </div>
      ${quote ? `<blockquote class="evidence-quote">"${H(quote)}"</blockquote>` : ''}
      ${valueRaw ? `<div class="evidence-value">Value: ${H(valueRaw)}</div>` : ''}
    </div>`;
  },

  /** Render the likely_culprit detail object */
  renderLikelyCulprit: (details) => {
    if (!details || !details.likely_culprit) return '';
    const lc = details.likely_culprit;
    const H = window.DashboardHelpers.escapeHTML;
    const fmt = window.DashboardHelpers.formatIndianNumber;
    return `<div class="likely-culprit-box">
      <strong>Likely Culprit:</strong> ${H(lc.metric_key)} would need to be ${fmt(lc.would_need_to_be)} for this to reconcile (currently ${fmt(lc.value)}).
    </div>`;
  },

  /** Render fx_applied chip if present */
  renderFxChip: (computation) => {
    if (!computation || !computation.fx_applied) return '';
    const fx = computation.fx_applied;
    const fxInfo = Array.isArray(fx) ? fx : [fx];
    const labels = fxInfo.map(f => `${f.pair || '?'} @ ${f.rate || '?'}`).join(', ');
    return `<span class="fx-chip">💱 Converted: ${window.DashboardHelpers.escapeHTML(labels)}</span>`;
  },

  /** Get the score band CSS class */
  getScoreBandClass: (band) => {
    const map = {
      'READY': 'band-ready',
      'CONDITIONAL': 'band-conditional',
      'MATERIAL_GAPS': 'band-material-gaps',
      'HIGH_RISK': 'band-high-risk'
    };
    return map[band] || 'band-high-risk';
  }
};
