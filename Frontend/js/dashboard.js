document.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();

  const urlParams = new URLSearchParams(window.location.search);
  const sessionId = urlParams.get('sessionId');

  if (!sessionId) {
    window.location.href = 'index.html';
    return;
  }

  const mainContent = document.getElementById('main-content');
  const overlayError = document.getElementById('overlay-error');
  const overlayProcessing = document.getElementById('overlay-processing');
  
  let currentSessionData = null;
  let currentFilter = 'all';
  let currentPillarFilter = null;

  const PIPELINE_STAGES = {
    initializing: { label: 'Initializing', icon: '⚙️' },
    parsing: { label: 'Parsing Documents', icon: '📄' },
    extracting: { label: 'Extracting Metrics', icon: '🔍' },
    validating: { label: 'Validating Claims', icon: '🛡️' },
    analyzing: { label: 'Running Verification', icon: '🔬' },
    complete: { label: 'Complete', icon: '✅' },
    error: { label: 'Error', icon: '❌' }
  };

  const H = window.DashboardHelpers.escapeHTML;
  const DH = window.DashboardHelpers;

  const showError = (msg) => {
    overlayProcessing.style.display = 'none';
    mainContent.style.display = 'none';
    overlayError.style.display = 'flex';
    document.getElementById('error-message').textContent = msg;
  };

  const showProcessing = (stage, progress, message) => {
    mainContent.style.display = 'none';
    overlayProcessing.style.display = 'flex';
    
    const stageInfo = PIPELINE_STAGES[stage] || { label: message || stage, icon: '⏳' };
    document.getElementById('processing-stage').textContent = message || stageInfo.label;

    if (progress && progress.total > 0) {
      document.getElementById('progress-container').style.display = 'block';
      document.getElementById('progress-text').style.display = 'block';
      const pct = (progress.current / progress.total) * 100;
      document.getElementById('progress-bar').style.width = `${pct}%`;
      document.getElementById('progress-text').textContent = `Processing document ${progress.current} of ${progress.total}`;
    } else {
      document.getElementById('progress-container').style.display = 'none';
      document.getElementById('progress-text').style.display = 'none';
    }
  };

  // ─── MAIN RENDER ────────────────────────────────────────────────

  const renderDashboard = (data) => {
    currentSessionData = data;
    overlayProcessing.style.display = 'none';
    mainContent.style.display = 'block';

    const { session, discrepancies, findings, score, breakdown, documents, schema } = data;

    if (session.status === 'failed') {
      showError("Analysis Pipeline Failed");
      return;
    }
    if (session.status === 'insufficient_documents') {
      showError("Analysis Failed: At least two different types of documents are required for cross-verification.");
      return;
    }

    document.getElementById('session-info').textContent = 
      `Session ID: ${session.id.split('-')[0]} • Analyzed ${new Date(session.created_at).toLocaleString()}`;

    const isEngine = schema === 'engine';
    const items = isEngine ? findings : discrepancies;
    const finalScore = isEngine ? score : session.readiness_score;
    const pillarsObj = isEngine ? breakdown?.pillars : session.summary_report?.pillars;
    const pillars = (isEngine && pillarsObj) ? Object.values(pillarsObj) : pillarsObj;
    const ceilingApplied = isEngine ? breakdown?.ceiling_applied : false;
    const ceilingVal = isEngine ? breakdown?.ceiling : null;
    const coverage = isEngine ? breakdown?.coverage : null;
    const bandLabel = isEngine ? (breakdown?.label || '') : '';
    const band = isEngine ? (breakdown?.band || '') : '';

    renderScoreHero({ score: finalScore, ceilingApplied, ceiling: ceilingVal, coverage, bandLabel, band });
    renderPillarBreakdown(pillars || []);
    renderClassificationCounts(items || [], isEngine ? breakdown?.counts : null);
    renderComparisonMatrix(items || [], data.documents || []);
    
    renderFilterBar();
    renderFindings(items || []);
    
    renderVerified(items || []);
    renderFollowUps(items || []);

    // AI Notes — engine uses ai_notes, legacy uses summary_report.summary
    const aiNotesContent = isEngine ? data.ai_notes : session.summary_report?.summary;
    const aiPanel = document.getElementById('ai-notes-panel');
    const aiSummary = document.getElementById('ai-summary');
    if (aiPanel && aiSummary) {
      if (aiNotesContent) {
        const notesText = typeof aiNotesContent === 'string' ? aiNotesContent : (aiNotesContent.summary || aiNotesContent.analysis || JSON.stringify(aiNotesContent));
        aiPanel.style.display = 'block';
        aiSummary.innerHTML = window.marked ? window.marked.parse(notesText) : H(notesText);
      } else {
        aiPanel.style.display = 'none';
      }
    }

    lucide.createIcons();
  };

  // ─── SECTION A: SCORE HERO ──────────────────────────────────────

  const renderScoreHero = (info) => {
    const score = info.score || 0;

    // Use backend's band label directly
    const statusText = info.bandLabel || getDefaultBandLabel(score);
    const color = getScoreColor(score);
    const bandClass = DH.getScoreBandClass(info.band || getDefaultBand(score));
    
    document.getElementById('gauge-score').textContent = score;
    document.getElementById('gauge-score').style.color = color;
    
    const statusEl = document.getElementById('gauge-status');
    statusEl.textContent = statusText;
    statusEl.style.color = color;
    statusEl.className = `score-band-label ${bandClass}`;
    
    const path = document.getElementById('gauge-path');
    if (path) {
      path.style.stroke = color;
      const maxOffset = 283;
      const offset = maxOffset - (score / 100) * maxOffset;
      setTimeout(() => { path.style.strokeDashoffset = offset; }, 100);
    }

    // Ceiling display
    const ceilingMarker = document.getElementById('ceiling-marker');
    if (ceilingMarker) {
      if (info.ceilingApplied && info.ceiling) {
        const corroborated = info.coverage?.nodes_corroborated || '?';
        const checked = info.coverage?.nodes_checked || '?';
        ceilingMarker.style.display = 'block';
        ceilingMarker.textContent = `Score capped at ${info.ceiling} — only ${corroborated} of ${checked} figures could be cross-checked against a second document.`;
      } else {
        ceilingMarker.style.display = 'none';
      }
    }
  };

  function getScoreColor(score) {
    if (score >= 85) return '#059669';
    if (score >= 70) return '#b45309';
    if (score >= 50) return '#c2410c';
    return '#dc2626';
  }

  function getDefaultBandLabel(score) {
    if (score >= 85) return 'Ready for Investor Review';
    if (score >= 70) return 'Conditional - Requires Clarification';
    if (score >= 50) return 'Material Gaps Identified';
    return 'High Risk - Significant Issues Found';
  }

  function getDefaultBand(score) {
    if (score >= 85) return 'READY';
    if (score >= 70) return 'CONDITIONAL';
    if (score >= 50) return 'MATERIAL_GAPS';
    return 'HIGH_RISK';
  }

  // ─── SECTION B: PILLAR BREAKDOWN ────────────────────────────────

  const renderPillarBreakdown = (pillars) => {
    const container = document.getElementById('pillar-breakdown');
    if (!container) return;
    if (!pillars || pillars.length === 0) {
      container.innerHTML = '<p class="text-secondary text-sm">No pillar data available.</p>';
      return;
    }
    container.innerHTML = pillars.map(p => {
      const label = p.label || p.name || 'Unknown';
      const score = p.score || 0;
      const applicable = p.applicable !== false;
      const weight = typeof p.weight === 'number' ? (p.weight < 1 ? Math.round(p.weight * 100) : p.weight) : 0;
      const findingCount = p.finding_count ?? p.findings_count ?? 0;
      const pillarKey = p.name || label.toLowerCase().replace(/\s+/g, '_');
      const isActive = currentPillarFilter === pillarKey;
      const barColor = !applicable ? '#d1d5db' : (score > 80 ? '#10B981' : score > 50 ? '#F59E0B' : '#EF4444');
      
      return `
      <div class="pillar-bar-container ${applicable ? '' : 'pillar-applicable-false'} ${isActive ? 'active-pillar' : ''}" 
           onclick="window.filterByPillar('${H(pillarKey)}')">
        <div class="pillar-bar-header">
          <span>${H(label)}</span>
          <span>${applicable ? score + '/100' : 'Not Assessed'}</span>
        </div>
        <div class="pillar-bar-bg">
          <div class="pillar-bar-fill" style="width: ${applicable ? score : 0}%; background: ${barColor}"></div>
        </div>
        <div class="text-xs text-secondary" style="margin-top: 4px;">
          ${applicable ? `${findingCount} finding${findingCount !== 1 ? 's' : ''} • Weight: ${weight}%` : 'No documents provided for this category'}
        </div>
      </div>`;
    }).join('');
  };

  window.filterByPillar = (pillarKey) => {
    currentPillarFilter = currentPillarFilter === pillarKey ? null : pillarKey;
    if (currentSessionData) {
      renderPillarBreakdown(getPillars());
      const items = getItems();
      renderFindings(items || []);
    }
  };

  function getPillars() {
    const data = currentSessionData;
    if (!data) return [];
    const isEngine = data.schema === 'engine';
    const pillarsObj = isEngine ? data.breakdown?.pillars : data.session?.summary_report?.pillars;
    return (isEngine && pillarsObj) ? Object.values(pillarsObj) : pillarsObj || [];
  }

  function getItems() {
    const data = currentSessionData;
    if (!data) return [];
    return data.schema === 'engine' ? data.findings : data.discrepancies;
  }

  // ─── SECTION C: CLASSIFICATION COUNTS ───────────────────────────

  const renderClassificationCounts = (items, backendCounts) => {
    const container = document.getElementById('classification-counts');
    if (!container) return;

    // Prefer backend counts if available
    let counts;
    if (backendCounts) {
      counts = backendCounts;
    } else {
      counts = (items || []).reduce((acc, d) => {
        acc[d.classification] = (acc[d.classification] || 0) + 1;
        return acc;
      }, {});
    }
    
    const classes = [
      ['VERIFIED_MISMATCH', 'var(--color-verified-mismatch)'],
      ['UNRESOLVED_INCONSISTENCY', 'var(--color-unresolved)'],
      ['MISSING_INFORMATION', 'var(--color-missing-info)'],
      ['UNUSUAL_ASSUMPTION_CHANGE', 'var(--color-unusual-assumption)'],
      ['VERIFIED_CONSISTENT', 'var(--color-verified-consistent)']
    ];
    
    container.innerHTML = classes.map(([c, color]) => {
      const count = counts[c] || 0;
      return `
        <div class="classification-count-row">
          <span class="classification-count-label">
            <span class="classification-count-dot" style="background: ${color}"></span>
            ${DH.getClassificationLabel(c)}
          </span>
          <span class="classification-count-num">${count}</span>
        </div>`;
    }).join('');
  };

  // ─── SECTION D: COMPARISON MATRIX ───────────────────────────────

  const renderComparisonMatrix = (items, documents) => {
    const container = document.getElementById('comparison-matrix');
    if (!container) return;

    // Build matrix from findings evidence: metric x document
    const docNames = [...new Set(documents.map(d => d.original_filename || d.document_category).filter(Boolean))];
    
    if (docNames.length === 0) {
      container.innerHTML = '<li class="text-secondary text-sm">No documents to compare.</li>';
      return;
    }

    // Group by metric+period across all evidence
    const metricsMap = new Map();
    for (const f of items) {
      if (!f.evidence || f.evidence.length === 0) continue;
      const key = `${f.metric_label || f.metric_key || 'unknown'}|${f.period_key || ''}`;
      if (!metricsMap.has(key)) {
        metricsMap.set(key, {
          metric: f.metric_label || f.metric_key,
          period: DH.formatPeriodKey(f.period_key),
          docs: new Map(),
          status: f.classification
        });
      }
      const row = metricsMap.get(key);
      for (const e of f.evidence) {
        const name = e.filename || 'Unknown';
        row.docs.set(name, e.value_raw || e.value_base || '—');
      }
    }

    if (metricsMap.size === 0) {
      container.innerHTML = '<li class="text-secondary text-sm">No cross-document comparisons available.</li>';
      return;
    }

    // Build compact table
    let html = '<div style="overflow-x: auto;"><table style="width: 100%; font-size: 0.78rem; border-collapse: collapse;">';
    html += '<thead><tr style="border-bottom: 2px solid #e2e8f0;">';
    html += '<th style="text-align: left; padding: 0.5rem 0.25rem; font-weight: 600;">Metric</th>';
    for (const dn of docNames.slice(0, 5)) {
      const short = dn.length > 18 ? dn.slice(0, 16) + '…' : dn;
      html += `<th style="text-align: right; padding: 0.5rem 0.25rem; font-weight: 600;">${H(short)}</th>`;
    }
    html += '<th style="text-align: center; padding: 0.5rem 0.25rem;">Status</th></tr></thead><tbody>';

    let rowCount = 0;
    for (const [, row] of metricsMap) {
      if (rowCount >= 10) break;
      const statusColor = row.status === 'VERIFIED_CONSISTENT' ? '#059669' : 
                           row.status === 'VERIFIED_MISMATCH' ? '#dc2626' : '#d97706';
      const statusIcon = row.status === 'VERIFIED_CONSISTENT' ? '✓' : 
                          row.status === 'VERIFIED_MISMATCH' ? '✗' : '?';
      html += `<tr style="border-bottom: 1px solid #f1f5f9;">`;
      html += `<td style="padding: 0.4rem 0.25rem; font-weight: 500;">${H(row.metric)}<br><span class="text-xs text-secondary">${H(row.period)}</span></td>`;
      for (const dn of docNames.slice(0, 5)) {
        const val = row.docs.get(dn) || '—';
        html += `<td style="text-align: right; padding: 0.4rem 0.25rem; font-family: monospace; font-size: 0.75rem;">${H(String(val))}</td>`;
      }
      html += `<td style="text-align: center; color: ${statusColor}; font-weight: 700;">${statusIcon}</td>`;
      html += '</tr>';
      rowCount++;
    }
    html += '</tbody></table></div>';

    container.innerHTML = html;
  };

  // ─── FILTER BAR ─────────────────────────────────────────────────

  const renderFilterBar = () => {
    const container = document.getElementById('filter-bar');
    if (!container) return;
    const filters = ['all', 'CRITICAL', 'HIGH', 'MEDIUM', 'MINOR'];
    container.innerHTML = filters.map(f => `
      <button class="filter-btn ${currentFilter === f ? 'active' : ''}" onclick="window.setFilter('${f}')">
        ${f === 'all' ? 'All' : f.charAt(0) + f.slice(1).toLowerCase()}
      </button>
    `).join('');
  };

  window.setFilter = (f) => {
    currentFilter = f;
    renderFilterBar();
    if (currentSessionData) {
      renderFindings(getItems() || []);
    }
  };

  // ─── SECTION E: FINDINGS LIST ───────────────────────────────────

  const renderFindings = (items) => {
    const container = document.getElementById('discrepancies-list');
    if (!container) return;

    // Exclude verified consistent
    let criticalFindings = (items || []).filter(d => d.classification !== 'VERIFIED_CONSISTENT');
    
    // Apply severity filter
    if (currentFilter !== 'all') {
      criticalFindings = criticalFindings.filter(d => 
        (d.severity_band || '').toUpperCase() === currentFilter.toUpperCase()
      );
    }

    // Apply pillar filter
    if (currentPillarFilter) {
      criticalFindings = criticalFindings.filter(d => d.pillar === currentPillarFilter);
    }
    
    if (criticalFindings.length === 0) {
      container.innerHTML = '<p class="text-secondary">No findings match this filter.</p>';
      return;
    }
    
    container.innerHTML = criticalFindings.map(d => {
      const cBadgeClass = DH.getClassificationBadgeClass(d.classification);
      const cLabel = DH.getClassificationLabel(d.classification);
      const sColor = DH.getSeverityColor(d.severity_band);
      const severityBand = d.severity_band || 'MEDIUM';
      const severityScore = d.severity_score != null ? d.severity_score : '';
      const periodDisplay = DH.formatPeriodKey(d.period_key);
      
      // Computation box
      let computationHtml = '';
      if (d.computation && d.computation.substituted) {
        computationHtml = `<div class="computation-box">${H(d.computation.substituted)}</div>`;
      }

      // Narrative or fallback
      const narrativeText = d.narrative || d.computation?.expression || '';
      const narrativeHtml = narrativeText ? `<p class="finding-narrative">${H(narrativeText)}</p>` : '';

      // Evidence grid
      let evidenceHtml = '';
      if (d.evidence && d.evidence.length > 0) {
        evidenceHtml = '<div class="evidence-grid">' + 
          d.evidence.map(e => DH.renderEvidenceCard(e)).join('') + 
          '</div>';
      }

      // FX chip
      const fxChipHtml = DH.renderFxChip(d.computation);

      // Factors chain
      const factorsHtml = DH.renderFactorsChain(d.factors, severityScore, severityBand);

      // Likely culprit
      const culpritHtml = DH.renderLikelyCulprit(d.details);

      // Use finding_id for modal lookup, fall back to id
      const findingId = d.finding_id || d.id;

      return `
        <div class="finding-card severity-${severityBand.toLowerCase()}" onclick="window.openVerificationModal('${H(findingId)}')" style="cursor: pointer;">
          <div class="finding-header">
            <div>
              <div style="font-family: monospace; font-size: 0.72rem; color: #64748b; margin-bottom: 0.25rem;">
                ${H(d.ref_code || findingId)} ${fxChipHtml}
              </div>
              <h4 class="h4" style="margin: 0;">${H(d.metric_label || d.metric_key || 'Observation')}</h4>
              <div class="text-xs text-secondary" style="margin-top: 0.25rem;">${H(periodDisplay)}</div>
            </div>
            <div class="finding-badges">
              <span class="classification-badge ${cBadgeClass}">${H(cLabel)}</span>
              <span class="severity-pill" style="color: ${sColor}; border-color: ${sColor};">
                ${H(severityBand)}${severityScore !== '' ? ` <span class="score-num">${severityScore}</span>` : ''}
              </span>
            </div>
          </div>
          ${computationHtml}
          ${narrativeHtml}
          ${evidenceHtml}
          ${factorsHtml}
          ${culpritHtml}
        </div>
      `;
    }).join('');
    
    lucide.createIcons();
  };

  // ─── SECTION F: VERIFIED CONSISTENT ─────────────────────────────

  const renderVerified = (items) => {
    const verified = (items || []).filter(d => d.classification === 'VERIFIED_CONSISTENT');
    const container = document.getElementById('verified-section');
    const list = document.getElementById('verified-list');
    if (!container || !list) return;
    
    if (verified.length > 0) {
      container.style.display = 'block';
      list.innerHTML = verified.map(d => {
        const periodDisplay = DH.formatPeriodKey(d.period_key);
        const evidenceCount = d.evidence ? d.evidence.length : 0;
        return `
        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #a7f3d0; padding: 0.75rem 0;">
          <div>
            <span style="font-weight: 600;">${H(d.metric_label || d.metric_key)}</span>
            <span class="text-xs text-secondary" style="margin-left: 0.5rem;">${H(periodDisplay)}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 0.75rem;">
            <span class="text-xs text-secondary">${evidenceCount > 0 ? `agrees across ${evidenceCount} source${evidenceCount > 1 ? 's' : ''}` : ''}</span>
            <span style="font-family: monospace; color: #065f46; font-weight: 600; font-size: 0.82rem;">✓ VERIFIED</span>
          </div>
        </div>`;
      }).join('');
    } else {
      container.style.display = 'none';
    }
  };

  // ─── SECTION G: FOLLOW-UP QUESTIONS ─────────────────────────────

  const renderFollowUps = (items) => {
    const container = document.getElementById('follow-up-list');
    if (!container) return;

    const questionsWithRefs = (items || [])
      .filter(d => d.follow_up_question && d.classification !== 'VERIFIED_CONSISTENT')
      .sort((a, b) => (b.severity_score || 0) - (a.severity_score || 0))
      .map(d => ({ question: d.follow_up_question, ref_code: d.ref_code }));
    
    if (questionsWithRefs.length === 0) {
      container.innerHTML = '<li class="text-secondary text-sm">No follow-up questions generated yet.</li>';
      return;
    }
    
    container.innerHTML = questionsWithRefs.map(q => `
      <li class="follow-up-item">
        <span class="follow-up-ref">${H(q.ref_code || '')}</span>
        <span class="follow-up-text">${H(q.question)}</span>
      </li>
    `).join('');
  };
  
  window.copyQuestions = () => {
    const items = getItems();
    const qs = (items || [])
      .filter(d => d.follow_up_question)
      .sort((a, b) => (b.severity_score || 0) - (a.severity_score || 0))
      .map(d => `[${d.ref_code || ''}] ${d.follow_up_question}`);
    if (qs.length > 0) {
      navigator.clipboard.writeText(qs.join('\n\n')).then(() => alert('Copied all questions!'));
    }
  };

  // ─── MODAL ──────────────────────────────────────────────────────

  window.openVerificationModal = (findingId) => {
    const items = getItems();
    // Try finding_id first, fall back to id
    const d = items?.find(x => (x.finding_id || x.id) === findingId);
    if (!d) return;

    const title = document.getElementById('modal-title');
    title.textContent = `${d.ref_code || ''}: ${d.metric_label || d.metric_key || 'Finding Detail'}`;
    
    const grid = document.getElementById('modal-evidence-grid');
    
    let modalContent = '';

    // Classification + severity header
    const cLabel = DH.getClassificationLabel(d.classification);
    const cBadgeClass = DH.getClassificationBadgeClass(d.classification);
    modalContent += `<div style="display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; align-items: center;">
      <span class="classification-badge ${cBadgeClass}">${H(cLabel)}</span>
      <span class="severity-pill" style="color: ${DH.getSeverityColor(d.severity_band)}; border-color: ${DH.getSeverityColor(d.severity_band)};">
        ${H(d.severity_band || '')} <span class="score-num">${d.severity_score != null ? d.severity_score : ''}</span>
      </span>
      <span class="text-xs text-secondary">${H(DH.formatPeriodKey(d.period_key))}</span>
      ${DH.renderFxChip(d.computation)}
    </div>`;

    // Computation block (THE PROOF — make it prominent)
    if (d.computation) {
      if (d.computation.substituted) {
        modalContent += `<div class="computation-box">${H(d.computation.substituted)}</div>`;
      }
      if (d.computation.expression) {
        modalContent += `<div style="font-size: 0.82rem; color: var(--text-secondary); margin-bottom: 0.5rem; font-style: italic;">Check applied: ${H(d.computation.expression)}</div>`;
      }
      if (d.computation.delta_pct != null) {
        modalContent += `<div style="font-size: 0.82rem; margin-bottom: 0.5rem;">Gap: <strong>${d.computation.delta_pct}%</strong>${d.computation.tolerance_pct != null ? ` (tolerance: ${d.computation.tolerance_pct}%)` : ''}</div>`;
      }
    }

    // Narrative
    if (d.narrative) {
      modalContent += `<p class="finding-narrative">${H(d.narrative)}</p>`;
    }

    // Evidence — variable length, scrollable
    if (d.evidence && d.evidence.length > 0) {
      modalContent += `<div style="margin-top: 1rem;"><strong style="font-size: 0.82rem; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.05em;">Source Evidence (${d.evidence.length})</strong></div>`;
      modalContent += '<div class="evidence-grid" style="margin-top: 0.5rem;">';
      for (const e of d.evidence) {
        modalContent += DH.renderEvidenceCard(e);
      }
      modalContent += '</div>';
    }

    // Factors chain
    if (d.factors) {
      modalContent += DH.renderFactorsChain(d.factors, d.severity_score, d.severity_band);
    }

    // Likely culprit
    modalContent += DH.renderLikelyCulprit(d.details);

    grid.innerHTML = modalContent;

    // Follow-up question
    document.getElementById('modal-investor-q').textContent = d.follow_up_question || 'No question generated for this finding.';
    document.getElementById('verification-modal').style.display = 'flex';
    
    lucide.createIcons();
  };

  window.copyModalContent = () => {
    const text = document.getElementById('modal-investor-q').textContent;
    navigator.clipboard.writeText(text).then(() => alert('Copied to clipboard!'));
  };

  // ─── DATA LOADING ───────────────────────────────────────────────

  const loadReport = async () => {
    try {
      const data = await window.api.get(`/sessions/${sessionId}`);
      
      if (['complete', 'failed', 'insufficient_documents'].includes(data.session.status)) {
        renderDashboard(data);
      } else {
        showProcessing(data.session.status, null);
        initSocket();
      }
    } catch (err) {
      showError(err.message || 'Failed to load report');
    }
  };

  const initSocket = () => {
    const socket = new window.SocketClient(
      (status, progress, message) => showProcessing(status, progress, message),
      (data) => loadReport(),
      (err) => showError(err),
      (msg) => console.warn("Warning:", msg),
      (data) => {
        // report:updated event — reload full report to get latest data
        loadReport();
      }
    );
    socket.connect();
  };

  // ─── EXPORT ─────────────────────────────────────────────────────

  window.exportPdf = () => {
    const token = localStorage.getItem('finverify_token') || '';
    window.open(`${window.api.baseUrl}/sessions/${sessionId}/export/pdf?token=${encodeURIComponent(token)}`, '_blank');
  };
  
  window.exportCsv = () => {
    const token = localStorage.getItem('finverify_token') || '';
    window.open(`${window.api.baseUrl}/sessions/${sessionId}/export/csv?token=${encodeURIComponent(token)}`, '_blank');
  };

  loadReport();
});
