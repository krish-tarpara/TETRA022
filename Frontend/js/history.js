document.addEventListener('DOMContentLoaded', async () => {
  const loadingIndicator = document.getElementById('loading-indicator');
  const errorIndicator = document.getElementById('error-indicator');
  const emptyState = document.getElementById('empty-state');
  const sessionsGrid = document.getElementById('sessions-grid');

  const getScoreColor = (score) => {
    if (score > 85) return 'var(--accent-success)';
    if (score >= 60) return 'var(--color-inconsistency)';
    return 'var(--color-mismatch)';
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
      const bgColor = isComplete ? 'rgba(16, 185, 129, 0.1)' : 'rgba(245, 158, 11, 0.1)';
      const textColor = isComplete ? 'var(--accent-success)' : 'var(--color-inconsistency)';
      
      const card = document.createElement('div');
      card.className = 'card interactive';
      card.style.cursor = 'pointer';
      card.onclick = () => window.location.href = `analysis.html?sessionId=${session.id}`;
      
      card.innerHTML = `
        <div class="session-card-header">
          <span class="session-card-date">
            ${new Date(session.created_at).toLocaleString()}
          </span>
          <span class="session-card-status" style="background-color: ${bgColor}; color: ${textColor}">
            ${session.status.toUpperCase()}
          </span>
        </div>
        <div class="session-card-content">
          <div class="session-score-circle" style="border-color: ${getScoreColor(session.readiness_score)}; color: ${getScoreColor(session.readiness_score)}">
            ${session.readiness_score}
          </div>
          <div>
            <h3 class="h3 text-primary" style="margin: 0">Readiness Score</h3>
            <p class="text-sm text-secondary" style="margin: 0.2rem 0 0">
              ${session.total_mismatches} mismatches found
            </p>
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
