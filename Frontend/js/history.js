document.addEventListener('DOMContentLoaded', async () => {
  const loadingIndicator = document.getElementById('loading-indicator');
  const errorIndicator = document.getElementById('error-indicator');
  const emptyState = document.getElementById('empty-state');
  const sessionsGrid = document.getElementById('sessions-grid');

  const getScoreColor = (score) => {
    if (score >= 85) return '#059669';
    if (score >= 70) return '#b45309';
    if (score >= 50) return '#c2410c';
    return '#dc2626';
  };

  const getBandClass = (band) => {
    if (band === 'READY') return 'band-ready';
    if (band === 'CONDITIONAL') return 'band-conditional';
    if (band === 'MATERIAL_GAPS') return 'band-material-gaps';
    return 'band-high-risk';
  };

  const renderSessions = (sessions) => {
    loadingIndicator.style.display = 'none';

    if (sessions.length === 0) {
      emptyState.style.display = 'block';
      return;
    }

    sessionsGrid.innerHTML = '';
    sessions.forEach(session => {
      const isComplete = session.status === 'complete';
      const scoreColor = getScoreColor(session.readiness_score || 0);
      const bandLabel = session.label || (isComplete ? 'Complete' : session.status);
      const bandClass = getBandClass(session.band);
      
      const card = document.createElement('div');
      card.className = 'history-card';
      card.onclick = () => window.location.href = `analysis.html?sessionId=${session.id}`;
      
      card.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1rem;">
          <span class="history-date">
            ${new Date(session.created_at).toLocaleString()}
          </span>
          <span class="history-status status-${session.status}">
            ${session.status.toUpperCase()}
          </span>
        </div>
        <div style="display: flex; align-items: center; gap: 1rem;">
          <div style="width: 60px; height: 60px; border-radius: 50%; display: flex; align-items: center; justify-content: center; border: 3px solid ${scoreColor}; color: ${scoreColor}; font-size: 1.2rem; font-weight: bold;">
            ${session.readiness_score || 0}
          </div>
          <div>
            <h3 class="h3" style="margin: 0; color: var(--text-primary);">Readiness Score</h3>
            <p style="margin: 0.25rem 0 0; font-size: 0.85rem; color: var(--text-secondary);">
              ${bandLabel}
            </p>
            ${session.band ? `<span class="score-band-label ${bandClass}" style="margin-top: 0.25rem; font-size: 0.72rem;">${session.band.replace(/_/g, ' ')}</span>` : ''}
          </div>
        </div>
      `;
      sessionsGrid.appendChild(card);
    });
  };

  try {
    const sessions = await window.api.get('/sessions');
    renderSessions(sessions);
  } catch (err) {
    loadingIndicator.style.display = 'none';
    errorIndicator.style.display = 'block';
    errorIndicator.textContent = err.message || 'Failed to fetch sessions';
  }
});
