const API_URL = 'http://localhost:5000/api/v1';

// Initialize session token if it doesn't exist
const initSession = async () => {
  let token = localStorage.getItem('finverify_token');
  if (!token) {
    try {
      const res = await fetch(`${API_URL}/auth/session`, { method: 'POST' });
      const data = await res.json();
      if (data.token) {
        localStorage.setItem('finverify_token', data.token);
        token = data.token;
      }
    } catch (err) {
      console.error('Failed to initialize session:', err);
    }
  }
  return token;
};

// Ensure session is initialized immediately
initSession();

window.api = {
  get: async (endpoint) => {
    const token = await initSession();
    const response = await fetch(`${API_URL}${endpoint}`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || 'Request failed');
    }
    return response.json();
  },
  
  post: async (endpoint, formData, options = {}) => {
    const token = await initSession();
    const headers = options.headers || {};
    
    headers['Authorization'] = `Bearer ${token}`;
    
    if (headers['Content-Type'] === 'multipart/form-data') {
      delete headers['Content-Type'];
    }

    const response = await fetch(`${API_URL}${endpoint}`, {
      method: 'POST',
      headers,
      body: formData
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || 'Request failed');
    }
    return response.json();
  }
};
