const API_URL = '/api/v1';

const PUBLIC_PAGES = ['index.html', 'outcomes.html', 'login.html', ''];

const requireAuth = () => {
  const token = localStorage.getItem('finverify_token');
  const path = window.location.pathname;
  const page = path.split('/').pop();
  const isPublicPage = PUBLIC_PAGES.includes(page);
  const isLoginPage = page === 'login.html';

  if (!token && !isPublicPage) {
    window.location.href = 'login.html';
  } else if (token && isLoginPage) {
    window.location.href = 'index.html';
  }
  return token;
};

// Ensure auth is enforced immediately
requireAuth();

window.api = {
  baseUrl: API_URL,
  logout: () => {
    localStorage.removeItem('finverify_token');
    window.location.href = 'login.html';
  },
  
  get: async (endpoint) => {
    const token = requireAuth();
    const response = await fetch(`${API_URL}${endpoint}`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    if (!response.ok) {
      if (response.status === 401) {
        localStorage.removeItem('finverify_token');
        window.location.href = 'login.html';
      }
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || 'Request failed');
    }
    return response.json();
  },
  
  post: async (endpoint, formData, options = {}) => {
    // If it's a login request, we don't need a token
    const isLogin = endpoint.includes('/auth/login') || endpoint.includes('/auth/register');
    const token = isLogin ? null : requireAuth();
    
    const headers = options.headers || {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    
    if (headers['Content-Type'] === 'multipart/form-data') {
      delete headers['Content-Type'];
    }

    const response = await fetch(`${API_URL}${endpoint}`, {
      method: 'POST',
      headers,
      body: formData
    });

    if (!response.ok) {
      if (response.status === 401 && !isLogin) {
        localStorage.removeItem('finverify_token');
        window.location.href = 'login.html';
      }
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || 'Request failed');
    }
    return response.json();
  }
};
