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
  
  const processingIcon = document.getElementById('processing-icon');
  const processingStage = document.getElementById('processing-stage');
  const progressContainer = document.getElementById('progress-container');
  const progressBar = document.getElementById('progress-bar');
  const progressText = document.getElementById('progress-text');

  const errorMessage = document.getElementById('error-message');

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
    errorMessage.textContent = msg;
  };

  const showProcessing = (stage, progress) => {
    mainContent.style.display = 'none';
    overlayProcessing.style.display = 'flex';
    
    const stageInfo = PIPELINE_STAGES[stage] || { label: stage, icon: '⏳' };
    processingStage.textContent = stageInfo.label;
    processingIcon.textContent = stageInfo.icon;

    if (progress && progress.total > 0) {
      progressContainer.style.display = 'block';
      progressText.style.display = 'block';
      const pct = (progress.current / progress.total) * 100;
      progressBar.style.width = `${pct}%`;
      progressText.textContent = `Processing document ${progress.current} of ${progress.total}`;
    } else {
      progressContainer.style.display = 'none';
      progressText.style.display = 'none';
    }
  };

  const renderDashboard = (data) => {
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

    // Header info
    document.getElementById('session-info').textContent = 
      `Session ID: ${session.id.split('-')[0]} • Analyzed ${new Date(session.created_at).toLocaleString()}`;

    // AI Summary
    if (session.summary_report && session.summary_report.summary) {
      document.getElementById('ai-summary').innerHTML = marked.parse(session.summary_report.summary);
    } else {
      document.getElementById('ai-summary').innerHTML = "<p>No executive summary available.</p>";
    }

    // Metrics Grid
    const totalDiscrepancies = session.total_mismatches + session.total_inconsistencies + session.total_missing + session.total_unusual;
    const verifiedCount = session.summary_report?.matrix?.verified_consistent || 0;
    
    const metricsGrid = document.getElementById('metrics-grid');
    metricsGrid.innerHTML = `
      <div class="metric-card">
        <div class="metric-card-header">
          <span class="metric-card-title">Readiness Score</span>
          <i data-lucide="activity" class="metric-card-icon"></i>
        </div>
        <div class="metric-card-value">${session.readiness_score}</div>
      </div>
      <div class="metric-card">
        <div class="metric-card-header">
          <span class="metric-card-title">Documents Scanned</span>
          <i data-lucide="file-text" class="metric-card-icon"></i>
        </div>
        <div class="metric-card-value">${documents ? documents.length : 0}</div>
      </div>
      <div class="metric-card">
        <div class="metric-card-header">
          <span class="metric-card-title">Verified Metrics</span>
          <i data-lucide="shield-alert" class="metric-card-icon"></i>
        </div>
        <div class="metric-card-value">${verifiedCount}</div>
      </div>
      <div class="metric-card">
        <div class="metric-card-header">
          <span class="metric-card-title">Total Discrepancies</span>
          <i data-lucide="alert-circle" class="metric-card-icon"></i>
        </div>
        <div class="metric-card-value">${totalDiscrepancies}</div>
      </div>
    `;
    lucide.createIcons();

    // Gauge
    const score = session.readiness_score;
    let color = 'var(--accent-progress)'; // Solid Dark Amber
    let status = 'High Risk';
    if (score > 85) { status = 'Ready for Review'; }
    else if (score >= 60) { status = 'Conditional'; }
    
    document.getElementById('gauge-score').textContent = score;
    document.getElementById('gauge-score').style.color = color;
    document.getElementById('gauge-status').textContent = status;
    document.getElementById('gauge-status').style.color = color;
    
    // Animate gauge SVG path
    const path = document.getElementById('gauge-path');
    path.style.stroke = color;
    const maxOffset = 283; // Math.PI * 90 approx
    const offset = maxOffset - (score / 100) * maxOffset;
    // Timeout to allow DOM to render before animating
    setTimeout(() => { path.style.strokeDashoffset = offset; }, 100);

    // Discrepancies list
    const dList = document.getElementById('discrepancies-list');
    dList.innerHTML = '';
    if (discrepancies && discrepancies.length > 0) {
      let index = 1;
      discrepancies.forEach(d => {
        const cat = (d.category || 'MISMATCH').toUpperCase().replace(/ /g, '-');
        const dispId = `${cat}-${index.toString().padStart(2, '0')}`;
        
        const metricName = d.metric && d.metric !== 'undefined' && d.metric !== 'null' ? d.metric : 'Data Discrepancy';
        const severity = d.severity && d.severity !== 'undefined' && d.severity !== 'null' ? d.severity : 'Medium';
        const category = d.category && d.category !== 'undefined' && d.category !== 'null' ? d.category : 'Mismatch';
        const desc = (d.description || 'Discrepancy detected').replace(/null/g, 'unspecified value');

        const item = document.createElement('div');
        item.className = 'discrepancy-item';
        item.style.cursor = 'pointer';
        item.innerHTML = `
          <div style="display: flex; justify-content: space-between; align-items: flex-start;">
            <h4 class="h4 text-primary">${metricName}</h4>
            <span style="font-family: monospace; font-size: 0.75rem; font-weight: 700; color: var(--text-secondary);">${dispId}</span>
          </div>
          <p class="text-sm text-secondary">${desc}</p>
          <div class="discrepancy-item-tags">
             <span class="discrepancy-tag tag-${severity.toLowerCase().replace(/ /g, '-')}">${severity}</span>
             <span class="discrepancy-tag tag-${category.toLowerCase().replace(/ /g, '-')}">${category}</span>
          </div>
        `;
        
        item.addEventListener('click', () => {
          openVerificationModal(d, dispId);
        });

        dList.appendChild(item);
        index++;
      });
    } else {
      dList.innerHTML = '<p class="text-secondary">No discrepancies found.</p>';
    }
  };

  const loadReport = async () => {
    try {
      const data = await window.api.get(`/sessions/${sessionId}`);
      
      if (data.session.status === 'complete' || data.session.status === 'failed' || data.session.status === 'insufficient_documents') {
        renderDashboard(data);
      } else {
        // Still processing, establish socket
        showProcessing(data.session.status, null);
        initSocket();
      }
    } catch (err) {
      showError(err.message || 'Failed to load report');
    }
  };

  const initSocket = () => {
    const socket = new window.SocketClient(
      (status, progress) => showProcessing(status, progress), // onUpdate
      (data) => loadReport(), // onComplete
      (err) => showError(err), // onError
      (msg) => console.warn("Warning:", msg)
    );
    socket.connect();
    
    // Ask to rejoin the current session room
    socket.emit('rejoin', { sessionId });
  };

  window.exportPdf = () => {
    window.open(`http://localhost:5000/api/v1/sessions/${sessionId}/export/pdf`, '_blank');
  };
  
  window.exportCsv = () => {
    window.open(`http://localhost:5000/api/v1/sessions/${sessionId}/export/csv`, '_blank');
  };

  window.openVerificationModal = (d, dispId) => {
    document.getElementById('modal-title').textContent = `Verification Deep Dive: ${d.metric}`;
    
    document.getElementById('modal-doc1-name').textContent = d.source1_type || 'Pitch Deck';
    document.getElementById('modal-doc1-page').textContent = d.source1_page ? `Page ${d.source1_page}` : 'Page --';
    document.getElementById('modal-doc1-quote').textContent = `"${d.source1_quote || d.description}"`;
    
    document.getElementById('modal-doc2-name').textContent = d.source2_type || 'Financial Model';
    document.getElementById('modal-doc2-page').textContent = d.source2_page ? `Page ${d.source2_page}` : 'Page --';
    document.getElementById('modal-doc2-quote').textContent = `"${d.source2_quote || 'Conflicting numeric value found.'}"`;

    document.getElementById('modal-investor-q').textContent = `Why does your ${d.source1_type || 'Pitch Deck'} state the ${d.metric} is one value, while your ${d.source2_type || 'Financial Model'} indicates another? Can you walk me through the reconciliation?`;

    document.getElementById('verification-modal').style.display = 'flex';
  };

  window.copyModalContent = () => {
    const text = document.getElementById('modal-investor-q').textContent;
    navigator.clipboard.writeText(text).then(() => alert('Copied to clipboard!'));
  };

  // Kickoff
  loadReport();
});
