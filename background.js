// Video MIME types to detect
const VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/webm',
  'video/ogg',
  'application/vnd.apple.mpegurl', // HLS m3u8
  'application/x-mpegURL',
  'application/dash+xml' // DASH mpd
];

// Patterns to ignore (segments, fragments, ads)
const IGNORE_PATTERNS = [
  /segment/i,
  /frag/i,
  /\/seg-\d+/i,
  /\.ts(\?|$)/i,
  /\.m4s(\?|$)/i,
  /pixel/i,
  /ad\//i,
  /track/i
];

function isIgnoredUrl(url) {
  return IGNORE_PATTERNS.some(regex => regex.test(url));
}

// Helper to check if a URL is likely a video based on extension (fallback)
function isVideoUrl(url) {
  const videoExtensions = ['.mp4', '.m3u8', '.webm', '.ogg', '.mov', '.mkv'];
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname.toLowerCase();
    return videoExtensions.some(ext => pathname.endsWith(ext));
  } catch (e) {
    return false;
  }
}

// Intercept network requests to find videos
chrome.webRequest.onHeadersReceived.addListener(
  function(details) {
    if (details.type === 'media' || details.type === 'xmlhttprequest' || details.type === 'other') {
      
      if (isIgnoredUrl(details.url)) return;

      let isVideo = false;
      let contentType = '';
      let format = '';
      let contentLength = 0;

      // Check Content-Type and Content-Length header
      for (let header of details.responseHeaders) {
        const name = header.name.toLowerCase();
        if (name === 'content-type') {
          contentType = header.value.split(';')[0].trim().toLowerCase();
          if (VIDEO_MIME_TYPES.includes(contentType)) {
             isVideo = true;
             
             if (contentType.includes('mp4')) format = 'MP4';
             else if (contentType.includes('webm')) format = 'WEBM';
             else if (contentType.includes('mpegurl')) format = 'HLS (m3u8)';
             else if (contentType.includes('dash')) format = 'DASH (mpd)';
             else format = contentType.split('/')[1] || 'Video';
          }
        } else if (name === 'content-length') {
          contentLength = parseInt(header.value, 10);
        }
      }
      
      // Fallback: Check URL extension
      if (!isVideo && isVideoUrl(details.url)) {
        isVideo = true;
        format = 'Unknown (Guessed from URL)';
        if (details.url.includes('.mp4')) format = 'MP4';
        if (details.url.includes('.m3u8')) format = 'HLS (m3u8)';
      }

      if (isVideo) {
        // We found a video source
        const tabId = details.tabId;
        
        // Skip requests not originating from a tab
        if (tabId === -1) return;

        // Ignore small files (less than 100KB) unless it's a playlist format (m3u8/mpd)
        if (contentLength > 0 && contentLength < 100 * 1024) {
            if (!format.includes('HLS') && !format.includes('DASH') && !details.url.includes('.m3u8')) {
                return;
            }
        }

        chrome.tabs.get(tabId, function(tab) {
          if (chrome.runtime.lastError || !tab) {
            // tab might be closed or not accessible
            processVideoDetection(tabId, details, format, contentLength, 'Video');
            return;
          }

          let title = tab.title || 'Video';
          // Clean up title (remove common suffixes like "- SiteName")
          title = title.replace(/[|:-]\s*[^|:-]*$/, '').trim();
          
          processVideoDetection(tabId, details, format, contentLength, title);
        });
      }
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

function processVideoDetection(tabId, details, format, contentLength, tabTitle) {
    chrome.storage.local.get(['detectedVideos'], function(result) {
        let detectedVideos = result.detectedVideos || {};
        
        if (!detectedVideos[tabId]) {
          detectedVideos[tabId] = [];
        }

        // Avoid adding the exact same URL multiple times
        if (!detectedVideos[tabId].some(video => video.url === details.url)) {
          let filename = tabTitle; // Use tab title by default
          
          // Try to get a meaningful extension
          let extension = '';
          if (format.includes('MP4')) extension = '.mp4';
          else if (format.includes('WEBM')) extension = '.webm';
          else if (format.includes('HLS')) extension = '.m3u8';
          else if (format.includes('DASH')) extension = '.mpd';
          
          // Limit filename length to avoid issues
          if (filename.length > 100) {
              filename = filename.substring(0, 100);
          }
          
          // Ensure valid filename characters
          filename = filename.replace(/[/\\?%*:|"<>]/g, '-');
          const finalFilename = filename + (extension || '');

          // Check if we already have a video with this EXACT same filename for this tab
          const alreadyExists = detectedVideos[tabId].some(v => v.filename === finalFilename);

          if (!alreadyExists) {
              const videoInfo = {
                url: details.url,
                format: format,
                filename: finalFilename,
                size: contentLength > 0 ? formatBytes(contentLength) : 'Unknown',
                type: details.type,
                timestamp: Date.now()
              };

              detectedVideos[tabId].push(videoInfo);
              console.log("Detected video:", videoInfo);
              
              chrome.storage.local.set({ detectedVideos }, () => {
                  chrome.action.setBadgeText({
                      text: detectedVideos[tabId].length.toString(),
                      tabId: tabId
                  });
                  chrome.action.setBadgeBackgroundColor({
                      color: '#FF0000',
                      tabId: tabId
                  });
                  chrome.action.setBadgeTextColor({
                      color: '#FFFFFF',
                      tabId: tabId
                  });
              });
          }
        }
    });
}

// Clean up when a tab is closed or updated
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.get(['detectedVideos'], function(result) {
    let detectedVideos = result.detectedVideos || {};
    if (detectedVideos[tabId]) {
      delete detectedVideos[tabId];
      chrome.storage.local.set({ detectedVideos });
    }
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    chrome.storage.local.get(['detectedVideos'], function(result) {
      let detectedVideos = result.detectedVideos || {};
      detectedVideos[tabId] = [];
      chrome.storage.local.set({ detectedVideos }, () => {
          chrome.action.setBadgeText({
              text: '',
              tabId: tabId
          });
      });
    });
  }
});

// Helper for human readable capacity
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}
