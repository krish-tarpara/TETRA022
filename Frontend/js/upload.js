document.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();

  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  const dropText = document.getElementById('drop-text');
  const rejectionMsg = document.getElementById('rejection-msg');
  const uploadedFilesSection = document.getElementById('uploaded-files-section');
  const fileCountHeading = document.getElementById('file-count-heading');
  const fileList = document.getElementById('file-list');
  const uploadError = document.getElementById('upload-error');
  const analyzeBtn = document.getElementById('analyze-btn');

  let stateFiles = [];
  let stateDocumentTypes = [];
  let loading = false;

  const DOCUMENT_TYPES = [
    { value: 'pitch_deck', label: 'Pitch Deck' },
    { value: 'financial_model', label: 'Financial Model' },
    { value: 'cap_table', label: 'Cap Table' },
    { value: 'certified_pnl', label: 'Certified P&L' },
    { value: 'unknown', label: 'Auto-detect' }
  ];

  const getIconForFile = (filename) => {
    if (filename.endsWith('.pdf')) return '📄';
    if (filename.endsWith('.xlsx') || filename.endsWith('.csv')) return '📊';
    if (filename.endsWith('.pptx')) return '📽️';
    return '📁';
  };

  const formatSize = (bytes) => (bytes / (1024 * 1024)).toFixed(2) + ' MB';

  const updateUI = () => {
    if (stateFiles.length > 0) {
      uploadedFilesSection.style.display = 'block';
      fileCountHeading.textContent = `Uploaded Documents (${stateFiles.length}/8)`;
    } else {
      uploadedFilesSection.style.display = 'none';
    }

    fileList.innerHTML = '';
    stateFiles.forEach((file, index) => {
      const card = document.createElement('div');
      card.className = 'card file-card-item';
      
      const icon = document.createElement('div');
      icon.className = 'file-card-icon';
      icon.textContent = getIconForFile(file.name);

      const info = document.createElement('div');
      info.className = 'file-card-info';
      info.innerHTML = `
        <h4 class="file-card-name">${file.name}</h4>
        <span class="file-card-size">${formatSize(file.size)}</span>
      `;

      const select = document.createElement('select');
      select.className = 'file-card-select';
      
      DOCUMENT_TYPES.forEach(t => {
        const option = document.createElement('option');
        option.value = t.value;
        option.textContent = t.label;
        if (stateDocumentTypes[index] === t.value) option.selected = true;
        select.appendChild(option);
      });

      select.addEventListener('change', (e) => {
        stateDocumentTypes[index] = e.target.value;
      });

      const removeBtn = document.createElement('button');
      removeBtn.innerHTML = '×';
      removeBtn.className = 'file-card-remove';
      
      removeBtn.addEventListener('click', () => {
        stateFiles.splice(index, 1);
        stateDocumentTypes.splice(index, 1);
        updateUI();
      });

      card.appendChild(icon);
      card.appendChild(info);
      card.appendChild(select);
      card.appendChild(removeBtn);
      
      fileList.appendChild(card);
    });
  };

  const handleFiles = (newFiles) => {
    rejectionMsg.style.display = 'none';
    const arr = Array.from(newFiles);
    
    if (stateFiles.length + arr.length > 8) {
      alert('Maximum 8 files allowed');
      return;
    }

    const filtered = arr.filter(f => {
      const isSizeOk = f.size <= 25 * 1024 * 1024;
      const isExtOk = ['.pdf', '.xlsx', '.csv', '.pptx'].some(ext => f.name.toLowerCase().endsWith(ext));
      return isSizeOk && isExtOk;
    });

    if (filtered.length < arr.length) {
      rejectionMsg.style.display = 'flex';
    }

    stateFiles = [...stateFiles, ...filtered];
    stateDocumentTypes = [...stateDocumentTypes, ...Array(filtered.length).fill('unknown')];
    
    updateUI();
  };

  // Drag and Drop events
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-active');
    dropZone.style.borderColor = 'var(--accent-primary)';
    dropText.textContent = "Drop your files here";
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-active');
    dropZone.style.borderColor = '';
    dropText.textContent = "Drag & drop files here";
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-active');
    dropZone.style.borderColor = '';
    dropText.textContent = "Drag & drop files here";
    if (e.dataTransfer.files) {
      handleFiles(e.dataTransfer.files);
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files) {
      handleFiles(e.target.files);
    }
  });

  analyzeBtn.addEventListener('click', async () => {
    if (stateFiles.length < 2) {
      alert('Please upload at least 2 documents for cross-verification.');
      return;
    }

    const uniqueTypes = new Set(stateDocumentTypes.filter(t => t && t !== 'unknown'));
    if (uniqueTypes.size < 2) {
      alert('Please assign at least 2 different document types (e.g., Pitch Deck, Financial Model) using the dropdown menus next to each file.');
      return;
    }

    loading = true;
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = 'INITIALIZING...';
    uploadError.style.display = 'none';

    const formData = new FormData();
    stateFiles.forEach(f => formData.append('files', f));
    stateDocumentTypes.forEach(t => formData.append('documentTypes', t));

    try {
      const res = await window.api.post('/analyze', formData);
      const sessionId = res.sessionId;
      localStorage.setItem('currentSessionId', sessionId);

      // We emit the analysis:start directly so the server starts processing.
      // (The socket connection might need to be initiated if not already connected in this page context)
      // Usually the dashboard page handles the socket connection for progress, but we need to start it here.
      const token = localStorage.getItem('finverify_token');
      const socket = io('http://localhost:5000/analysis', { auth: { token } });
      socket.on('connect', () => {
        socket.emit('analysis:start', { sessionId });
        // Redirect to dashboard
        window.location.href = `analysis.html?sessionId=${sessionId}`;
      });
    } catch (err) {
      uploadError.textContent = err.message || 'Upload failed';
      uploadError.style.display = 'block';
      loading = false;
      analyzeBtn.disabled = false;
      analyzeBtn.textContent = 'RUN COMPREHENSIVE AUDIT';
    }
  });
});
