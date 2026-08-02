// Replace hooks/useSocket.js

class SocketClient {
  constructor(onStatusUpdate, onComplete, onError, onWarning, onReportUpdated) {
    this.socket = null;
    this.status = null;
    this.progress = null;
    this.error = null;
    this.warnings = [];
    
    this.onStatusUpdate = onStatusUpdate;
    this.onComplete = onComplete;
    this.onError = onError;
    this.onWarning = onWarning;
    this.onReportUpdated = onReportUpdated;
  }

  connect() {
    const token = localStorage.getItem('finverify_token');
    // Using global io object from CDN
    this.socket = io('/analysis', {
      auth: { token }
    });

    this.socket.on('connect', () => {
      console.log('Socket connected');
      // Always rejoin the room on connect/reconnect
      const currentSessionId = localStorage.getItem('currentSessionId');
      if (currentSessionId) {
        this.socket.emit('rejoin', { sessionId: currentSessionId });
      }
    });

    this.socket.on('report:updated', (data) => {
      if (this.onReportUpdated) this.onReportUpdated(data);
    });

    this.socket.on('status:update', (data) => {
      this.status = data.stage;
      if (data.progress) this.progress = data.progress;
      if (data.message) console.log(data.message);
      if (this.onStatusUpdate) this.onStatusUpdate(this.status, this.progress, data.message);
    });

    this.socket.on('status:warning', (data) => {
      this.warnings.push(data.message);
      if (this.onWarning) this.onWarning(data.message);
    });

    this.socket.on('analysis:complete', (data) => {
      this.status = 'complete';
      localStorage.removeItem('currentSessionId');
      if (this.onComplete) this.onComplete(data);
    });

    this.socket.on('analysis:error', (data) => {
      this.error = data.error;
      this.status = 'error';
      if (this.onError) this.onError(data.error);
    });
  }
  
  emit(event, data) {
    if (this.socket) {
      this.socket.emit(event, data);
    }
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
    }
  }
}

window.SocketClient = SocketClient;
