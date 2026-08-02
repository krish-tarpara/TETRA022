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

  const PIPELINE_STAGES = {
    initializing: { label: 'Initializing', icon: '⚙️' },
    parsing: { label: 'Parsing Documents', icon: '📄' },
    extracting: { label: 'Extracting Metrics', icon: '🔍' },
    validating: { label: 'Validating Claims', icon: '🛡️' },
    analyzing: { label: 'Reasoning Analysis', icon: '🧠' },
    complete: { label: 'Complete', icon: '✅' },
    error: { label: 'Error', icon: '❌' }
  };

  const showError = (msg) => {
    overlayProcessing.style.display = 'none';
    mainContent.style.display = 'none';
    overlayError.style.display = 'flex';
    document.getElementById('error-message').textContent = msg;
  };

  const showProcessing = (stage, progress) => {
    mainContent.style.display = 'none';
    overlayProcessing.style.display = 'flex';
    
    const stageInfo = PIPELINE_STAGES[stage] || { label: stage, icon: '⏳' };
    document.getElementById('processing-stage').textContent = stageInfo.label;

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

  const renderDashboard = (data) => {
    currentSessionData = data;
    overlayProcessing.style.display = 'none';
    mainContent.style.display = 'block';

    const { session, discrepancies, documents } = data;

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

    renderScoreHero(session);
    renderPillarBreakdown(session.summary_report?.pillars || []);
    renderClassificationCounts(discrepancies || []);
    renderComparisonMatrix(session.summary_report?.matrix || {});
    
    renderFilterBar();
    renderFindings(discrepancies || []);
    
    renderVerified(discrepancies || []);
    renderFollowUps(discrepancies || []);

    if (session.summary_report?.summary) {
      document.getElementById('ai-notes-panel').style.display = 'block';
      document.getElementById('ai-summary').innerHTML = window.marked ? window.marked.parse(session.summary_report.summary) : session.summary_report.summary;
    } else {
      document.getElementById('ai-notes-panel').style.display = 'none';
    }

    lucide.createIcons();
  };

  const renderScoreHero = (session) => {
    const score = session.readiness_score || 0;
    let color = 'var(--accent-progress)';
    let status = 'High Risk';
    if (score > 85) { status = 'Ready for Review'; color = 'var(--accent-success, #059669)'; }
    else if (score >= 60) { status = 'Conditional'; }
    
    document.getElementById('gauge-score').textContent = score;
    document.getElementById('gauge-score').style.color = color;
    document.getElementById('gauge-status').textContent = status;
    document.getElementById('gauge-status').style.color = color;
    
    const path = document.getElementById('gauge-path');
    if (path) {
      path.style.stroke = color;
      const maxOffset = 283;
      const offset = maxOffset - (score / 100) * maxOffset;
      setTimeout(() => { path.style.strokeDashoffset = offset; }, 100);
    }

    const ceilingInfo = session.summary_report?.ceiling_applied;
    const ceilingMarker = document.getElementById('ceiling-marker');
    if (ceilingMarker) {
      if (ceilingInfo && ceilingInfo.applied) {
        ceilingMarker.style.display = 'block';
        ceilingMarker.textContent = `Score capped at ${ceilingInfo.cap_score} due to: ${ceilingInfo.reason}`;
      } else {
        ceilingMarker.style.display = 'none';
      }
    }
  };

  const renderPillarBreakdown = (pillars) => {
    const container = document.getElementById('pillar-breakdown');
    if (!container) return;
    if (!pillars || pillars.length === 0) {
      container.innerHTML = '<p class="text-secondary text-sm">No pillar data available.</p>';
      return;
    }
    container.innerHTML = pillars.map(p => `
      <div class="pillar-bar-container ${p.applicable ? '' : 'pillar-applicable-false'}">
        <div class="pillar-bar-header">
          <span>${window.DashboardHelpers.escapeHTML(p.name)}</span>
          <span>${p.applicable ? p.score + '/100' : 'Not Assessed'}</span>
        </div>
        <div class="pillar-bar-bg">
          <div class="pillar-bar-fill" style="width: ${p.applicable ? p.score : 0}%; background: ${p.score > 80 ? '#10B981' : p.score > 50 ? '#F59E0B' : '#EF4444'}"></div>
        </div>
        <div class="text-xs text-secondary" style="margin-top: 4px;">
          ${p.applicable ? `${p.findings_count} finding(s) • Weight: ${p.weight}%` : 'N/A'}
        </div>
      </div>
    `).join('');
  };

  const renderClassificationCounts = (discrepancies) => {
    const counts = discrepancies.reduce((acc, d) => {
      acc[d.classification] = (acc[d.classification] || 0) + 1;
      return acc;
    }, {});
    
    const container = document.getElementById('classification-counts');
    if (!container) return;
    
    const classes = ['VERIFIED_MISMATCH', 'UNRESOLVED_INCONSISTENCY', 'MISSING_INFORMATION', 'UNUSUAL_ASSUMPTION_CHANGE', 'VERIFIED_CONSISTENT'];
    
    container.innerHTML = classes.map(c => {
      const count = counts[c] || 0;
      if (count === 0 && c !== 'VERIFIED_MISMATCH') return '';
      return `
        <div style="display: flex; justify-content: space-between; font-size: 0.85rem; padding: 0.5rem 0; border-bottom: 1px solid #f1f5f9;">
          <span style="display: flex; align-items: center; gap: 0.5rem;">
            <span style="width: 12px; height: 12px; border-radius: 50%; background: ${window.DashboardHelpers.getClassificationColor(c)}"></span>
            ${c.replace(/_/g, ' ')}
          </span>
          <span style="font-weight: 600;">${count}</span>
        </div>
      `;
    }).join('');
  };

  const renderComparisonMatrix = (matrix) => {
    const container = document.getElementById('comparison-matrix');
    if (!container) return;
    const pairs = matrix.pairs || [];
    if (pairs.length === 0) {
      container.innerHTML = '<li>No document pairs analyzed.</li>';
      return;
    }
    container.innerHTML = pairs.map(p => {
      const score = p.match_score || 0;
      const color = score > 80 ? 'var(--accent-primary, #059669)' : score > 50 ? 'var(--accent-progress, #D97706)' : 'var(--color-mismatch, #991B1B)';
      return `
        <li style="display: flex; justify-content: space-between; border-bottom: 1px solid rgba(0,0,0,0.05); padding-bottom: 0.5rem; margin-bottom: 0.5rem;">
          <span>${window.DashboardHelpers.escapeHTML(p.doc1)} ↔ ${window.DashboardHelpers.escapeHTML(p.doc2)}</span>
          <span style="color: ${color}; font-weight: 600;">${score}% Match</span>
        </li>
      `;
    }).join('');
  };

  const renderFilterBar = () => {
    const container = document.getElementById('filter-bar');
    if (!container) return;
    const filters = ['all', 'critical', 'high', 'medium', 'minor'];
    container.innerHTML = filters.map(f => `
      <button class="filter-btn ${currentFilter === f ? 'active' : ''}" onclick="window.setFilter('${f}')">
        ${f.charAt(0).toUpperCase() + f.slice(1)}
      </button>
    `).join('');
  };

  window.setFilter = (f) => {
    currentFilter = f;
    renderFilterBar();
    if (currentSessionData) {
      renderFindings(currentSessionData.discrepancies || []);
    }
  };

  const renderFindings = (discrepancies) => {
    const container = document.getElementById('discrepancies-list');
    if (!container) return;
    const criticalFindings = discrepancies.filter(d => d.classification !== 'VERIFIED_CONSISTENT');
    const filtered = currentFilter === 'all' ? criticalFindings : criticalFindings.filter(d => (d.severity || '').toLowerCase() === currentFilter);
    
    if (filtered.length === 0) {
      container.innerHTML = '<p class="text-secondary">No findings match this filter.</p>';
      return;
    }
    
    container.innerHTML = filtered.map(d => {
      const cColor = window.DashboardHelpers.getClassificationColor(d.classification);
      const sColor = window.DashboardHelpers.getSeverityColor(d.severity);
      
      let evidenceHtml = '';
      if (d.evidence && d.evidence.length > 0) {
        evidenceHtml = '<div class="evidence-grid" style="margin-top: 0.5rem; font-size: 0.75rem;">' + d.evidence.map(e => 
          `<div class="evidence-card">
            <div style="font-weight: 600;">${window.DashboardHelpers.escapeHTML(e.document_type)} (Pg ${e.page_number || '-'})</div>
            <div style="color: #475569; margin-top: 0.25rem;">"${window.DashboardHelpers.escapeHTML(e.extracted_text)}"</div>
            ${e.value_found ? `<div style="margin-top: 0.25rem; font-family: monospace; color: #0284c7;">Value: ${window.DashboardHelpers.escapeHTML(e.value_found)}</div>` : ''}
          </div>`
        ).join('') + '</div>';
      }

      let fxChipHtml = '';
      if (d.fx_applied) {
        fxChipHtml = `<div class="fx-chip"><i data-lucide="refresh-cw" style="width:12px;height:12px;"></i> FX Applied</div>`;
      }

      let computationHtml = '';
      if (d.computation && d.computation.substituted) {
        computationHtml = `<div class="computation-box">${window.DashboardHelpers.escapeHTML(d.computation.substituted)}</div>`;
      }

      let factorsHtml = '';
      if (d.factors && d.factors.length > 0) {
        factorsHtml = `<div class="factors-chain"><strong>Trace:</strong> ${d.factors.map(f => window.DashboardHelpers.escapeHTML(f)).join(' ➔ ')}</div>`;
      }

      return `
        <div class="finding-card" onclick="window.openVerificationModal('${d.id}')" style="cursor: pointer;">
          <div class="finding-header">
            <div>
              <div style="font-family: monospace; font-size: 0.75rem; color: #64748b; margin-bottom: 0.25rem;">${window.DashboardHelpers.escapeHTML(d.ref_code || d.id)} ${fxChipHtml}</div>
              <h4 class="h4" style="margin: 0;">${window.DashboardHelpers.escapeHTML(d.metric_label || d.metric || 'Observation')}</h4>
              <div class="text-xs text-secondary" style="margin-top: 0.25rem;">${window.DashboardHelpers.escapeHTML(d.period || '')}</div>
            </div>
            <div class="finding-badges">
              <span class="classification-badge" style="background: ${cColor};">${d.classification}</span>
              <span class="badge-severity" style="color: ${sColor}; border-color: ${sColor};">${d.severity}</span>
            </div>
          </div>
          <p class="text-sm" style="margin: 1rem 0 0.5rem 0;">${window.DashboardHelpers.escapeHTML(d.narrative || d.description || '')}</p>
          ${computationHtml}
          ${factorsHtml}
          ${evidenceHtml}
          ${d.likely_culprit ? `<div style="margin-top: 0.75rem; font-size: 0.8rem; color: #b91c1c; background: #fef2f2; padding: 0.5rem; border-radius: 4px;"><strong>Likely Culprit:</strong> ${window.DashboardHelpers.escapeHTML(d.likely_culprit)}</div>` : ''}
        </div>
      `;
    }).join('');
    
    lucide.createIcons();
  };

  const renderVerified = (discrepancies) => {
    const verified = discrepancies.filter(d => d.classification === 'VERIFIED_CONSISTENT');
    const container = document.getElementById('verified-section');
    const list = document.getElementById('verified-list');
    if (!container || !list) return;
    
    if (verified.length > 0) {
      container.style.display = 'block';
      list.innerHTML = verified.map(d => `
        <div style="display: flex; justify-content: space-between; border-bottom: 1px solid #a7f3d0; padding: 0.75rem 0;">
          <span>${window.DashboardHelpers.escapeHTML(d.metric_label || d.metric)}</span>
          <span style="font-family: monospace; color: #065f46; font-weight: 600;">VERIFIED</span>
        </div>
      `).join('');
    } else {
      container.style.display = 'none';
    }
  };

  const renderFollowUps = (discrepancies) => {
    const container = document.getElementById('follow-up-list');
    if (!container) return;
    const qs = discrepancies.filter(d => d.follow_up_question).map(d => d.follow_up_question);
    
    if (qs.length === 0) {
      container.innerHTML = '<li class="text-secondary text-sm">No follow-up questions generated.</li>';
      return;
    }
    
    container.innerHTML = qs.map(q => `
      <li>${window.DashboardHelpers.escapeHTML(q)}</li>
    `).join('');
  };
  
  window.copyQuestions = () => {
    const qs = currentSessionData?.discrepancies.filter(d => d.follow_up_question).map(d => d.follow_up_question) || [];
    if (qs.length > 0) {
      navigator.clipboard.writeText(qs.join('\n\n')).then(() => alert('Copied all questions!'));
    }
  };

  window.openVerificationModal = (id) => {
    const d = currentSessionData.discrepancies.find(x => x.id === id);
    if (!d) return;

    document.getElementById('modal-title').textContent = `Verification Evidence: ${d.metric_label || d.metric}`;
    
    const grid = document.getElementById('modal-evidence-grid');
    if (d.evidence && d.evidence.length > 0) {
      grid.innerHTML = d.evidence.map(e => `
        <div style="background: rgba(0,0,0,0.02); border: 1px solid var(--bg-glass-border); border-radius: var(--radius-sm); padding: 1.5rem;">
          <div style="display: flex; justify-content: space-between; margin-bottom: 1rem; font-size: 0.85rem; font-weight: 600; color: var(--text-secondary); text-transform: uppercase;">
            <span>${window.DashboardHelpers.escapeHTML(e.document_type)}</span>
            <span style="color: var(--accent-primary);">Page ${e.page_number || '--'}</span>
          </div>
          <blockquote style="border-left: 3px solid var(--accent-primary); padding-left: 1rem; margin: 0; font-family: monospace; font-size: 0.9rem; line-height: 1.6; color: var(--text-primary);">
            "${window.DashboardHelpers.escapeHTML(e.extracted_text)}"
          </blockquote>
          ${e.value_found ? `<div style="margin-top: 1rem; font-family: monospace; color: #0284c7;">Value: ${window.DashboardHelpers.escapeHTML(e.value_found)}</div>` : ''}
        </div>
      `).join('');
    } else {
      grid.innerHTML = '<p>No evidence snippets available.</p>';
    }

    document.getElementById('modal-investor-q').textContent = d.follow_up_question || 'No question generated.';
    document.getElementById('verification-modal').style.display = 'flex';
  };

  window.copyModalContent = () => {
    const text = document.getElementById('modal-investor-q').textContent;
    navigator.clipboard.writeText(text).then(() => alert('Copied finding to clipboard!'));
  };

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
      (status, progress) => showProcessing(status, progress),
      (data) => loadReport(),
      (err) => showError(err),
      (msg) => console.warn("Warning:", msg),
      (data) => {
        // report:updated event
        if (currentSessionData && currentSessionData.session) {
          currentSessionData.session.summary_report = data.summary_report;
          if (data.summary_report?.summary) {
            document.getElementById('ai-notes-panel').style.display = 'block';
            document.getElementById('ai-summary').innerHTML = window.marked ? window.marked.parse(data.summary_report.summary) : data.summary_report.summary;
          }
        }
      }
    );
    socket.connect();
  };

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
