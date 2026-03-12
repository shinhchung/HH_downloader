document.addEventListener('DOMContentLoaded', () => {
  const videoListEl = document.getElementById('video-list');
  const emptyStateEl = document.getElementById('empty-state');
  const videoCountEl = document.getElementById('video-count');
  const refreshBtn = document.getElementById('refresh-btn');
  const clearBtn = document.getElementById('clear-btn');

  let currentTabId = null;

  // Initialize
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      currentTabId = tabs[0].id;
      loadVideos();
    }
  });

  // Listen for storage changes to update live
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.detectedVideos) {
      loadVideos();
    }
  });

  refreshBtn.addEventListener('click', () => {
    const icon = refreshBtn.querySelector('svg');
    icon.style.animation = 'spin 1s linear';
    setTimeout(() => icon.style.animation = '', 1000);
    loadVideos();
  });

  clearBtn.addEventListener('click', () => {
    if (currentTabId) {
      chrome.storage.local.get(['detectedVideos'], function(result) {
        let detectedVideos = result.detectedVideos || {};
        detectedVideos[currentTabId] = [];
        chrome.storage.local.set({ detectedVideos }, () => {
          chrome.action.setBadgeText({ text: '', tabId: currentTabId });
          loadVideos();
        });
      });
    }
  });

  function loadVideos() {
    if (!currentTabId) return;

    chrome.storage.local.get(['detectedVideos'], (result) => {
      const allVideos = result.detectedVideos || {};
      const tabVideos = allVideos[currentTabId] || [];

      renderVideos(tabVideos);
    });
  }

  function renderVideos(videos) {
    videoListEl.innerHTML = '';
    videoCountEl.textContent = `${videos.length} found`;

    if (videos.length === 0) {
      emptyStateEl.classList.remove('hidden');
      return;
    }

    emptyStateEl.classList.add('hidden');

    // Sort newest first
    const sortedVideos = [...videos].sort((a, b) => b.timestamp - a.timestamp);

    sortedVideos.forEach((video, index) => {
      const isM3u8 = video.format.toLowerCase().includes('hls') || 
                     video.format.toLowerCase().includes('m3u8') || 
                     video.url.includes('.m3u8');
      
      const card = document.createElement('div');
      card.className = 'video-card';
      // stagger animation based on index
      card.style.animationDelay = `${index * 0.05}s`;
      
      let title = video.filename || 'Unknown Video';
      if (title.length > 50) title = title.substring(0, 47) + '...';

      card.innerHTML = `
        <div class="video-info">
          <div class="video-filename" title="${video.url}">${title}</div>
          <div class="video-meta">
            <span class="tag">${video.format}</span>
            <span>${video.size}</span>
          </div>
        </div>
        <div class="video-actions">
          <button class="btn-primary download-btn" data-url="${video.url}" data-filename="${video.filename}" data-hls="${isM3u8}">
            <svg viewBox="0 0 24 24" fill="none" width="16" height="16" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
            Download ${isM3u8 ? 'Full Stream' : 'Video'}
          </button>
        </div>
      `;

      videoListEl.appendChild(card);
    });

    document.querySelectorAll('.download-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const url = e.currentTarget.getAttribute('data-url');
        const filename = e.currentTarget.getAttribute('data-filename');
        const isHls = e.currentTarget.getAttribute('data-hls') === 'true';
        
        if (isHls) {
           // We open our dedicated Extension Page to bypass all Cross-Origin/Memory limitations
           const converterUrl = chrome.runtime.getURL(`converter.html?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(filename)}`);
           
           // Fetch the current window so we explicitly attach the new tab to the user's active window (works in Incognito)
           chrome.windows.getCurrent((win) => {
               chrome.tabs.create({ windowId: win.id, url: converterUrl, active: true }, () => {
                   window.close();
               });
           });
        } else {
           chrome.downloads.download({
             url: url,
             filename: filename && filename !== 'video' ? filename : undefined,
             saveAs: true
           });
        }
      });
    });
  }
});
