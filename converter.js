// Handle the heavy downloading and ffmpeg processing inside this dedicated tab
// This completely bypasses the content script's memory and Cross-Origin Isolation issues!

const urlParams = new URLSearchParams(window.location.search);
const m3u8Url = urlParams.get('url');
let filename = urlParams.get('filename') || 'video';

const statusEl = document.getElementById('status');
const progressEl = document.getElementById('progress-bar');
const logEl = document.getElementById('log');
const closeBtn = document.getElementById('closeBtn');
const spinner = document.getElementById('spinner');

function log(msg) {
    console.log(msg);
    logEl.textContent += msg + '\n';
    logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(msg) {
    statusEl.textContent = msg;
    log(msg);
}

function toAbsolute(baseUrl, url) {
    if (url.startsWith('http')) return url;
    if (url.startsWith('/')) {
        const urlObj = new URL(baseUrl);
        return urlObj.origin + url;
    }
    const parts = baseUrl.split('/');
    parts.pop();
    return parts.join('/') + '/' + url;
}

closeBtn.addEventListener('click', () => {
    window.close();
});

function showResolutionPicker(variants) {
    statusEl.textContent = "Select Video Quality:";
    const picker = document.createElement('div');
    picker.style.cssText = 'display: flex; flex-direction: column; gap: 10px; margin-top: 20px; text-align: left;';
    
    variants.forEach(variant => {
        const btn = document.createElement('button');
        btn.style.cssText = `
            background: #334155; color: white; border: 1px solid #475569;
            padding: 12px; border-radius: 6px; cursor: pointer;
            display: flex; justify-content: space-between; font-size: 14px;
        `;
        btn.innerHTML = `<span>${variant.resolution === 'Unknown' ? 'Video Stream' : variant.resolution}</span> <span style="color:#94a3b8;">${variant.displaySize}</span>`;
        btn.onmouseover = () => { btn.style.background = '#475569'; };
        btn.onmouseout = () => { btn.style.background = '#334155'; };
        
        btn.onclick = () => {
            picker.remove();
            downloadVariant(variant);
        };
        picker.appendChild(btn);
    });
    
    document.querySelector('.container').appendChild(picker);
}

// Helper for human readable capacity
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

async function startProcess() {
    document.getElementById('filename').textContent = filename;

    try {
        setStatus("Fetching stream info...");
        
        let res = await fetch(m3u8Url);
        if (!res.ok) throw new Error("Failed to fetch m3u8");
        let text = await res.text();

        let variants = [];

        // Check if master playlist
        if (text.includes('#EXT-X-STREAM-INF')) {
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                if (line.startsWith('#EXT-X-STREAM-INF')) {
                    const bwMatch = line.match(/BANDWIDTH=(\d+)/);
                    const resMatch = line.match(/RESOLUTION=(\d+x\d+)/);
                    const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
                    const resolution = resMatch ? resMatch[1] : 'Unknown';
                    
                    let nextLineIndex = i + 1;
                    let url = null;
                    while (nextLineIndex < lines.length) {
                        const nextLine = lines[nextLineIndex].trim();
                         if (nextLine && !nextLine.startsWith('#')) {
                             url = nextLine;
                             break;
                         }
                         nextLineIndex++;
                    }

                    if (url) {
                        variants.push({ bandwidth: bw, resolution: resolution, url: toAbsolute(m3u8Url, url) });
                    }
                }
            }
        } else {
            variants.push({ bandwidth: 0, resolution: 'Default', url: m3u8Url, isMedia: true });
        }

        if (variants.length === 0) throw new Error("No video streams found.");

        variants.sort((a, b) => b.bandwidth - a.bandwidth);

        log("Estimating sizes...");
        await Promise.all(variants.map(async (v) => {
            try {
                const mRes = await fetch(v.url);
                const mText = await mRes.text();
                let duration = 0;
                for (const l of mText.split('\n')) {
                    if (l.startsWith('#EXTINF:')) {
                        const time = parseFloat(l.split(':')[1].split(',')[0]);
                        if (!isNaN(time)) duration += time;
                    }
                }
                v.mediaPlaylistContent = mText;
                if (v.bandwidth > 0 && duration > 0) {
                    v.estimatedBytes = (v.bandwidth / 8) * duration;
                    v.displaySize = "~" + formatBytes(v.estimatedBytes);
                } else {
                    v.displaySize = "Unknown Size";
                }
            } catch (e) {
                v.displaySize = "Error estimating";
            }
        }));

        spinner.style.display = 'none';

        if (variants.length === 1 && variants[0].isMedia) {
            downloadVariant(variants[0]);
        } else {
            showResolutionPicker(variants);
        }

    } catch (err) {
        let msg = "Unknown Error";
        if (err && err.message) msg = err.message;
        else if (err) msg = String(err);
        
        log(`CRITICAL ERROR: ${msg}`);
        if (err && err.stack) log(err.stack);
        console.error("Pipeline crashed:", err);

        statusEl.textContent = "An error occurred during processing.";
        progressEl.style.backgroundColor = 'var(--error)';
        spinner.style.display = 'none';
        closeBtn.style.display = 'inline-block';
    }
}

async function downloadVariant(variant) {
    spinner.style.display = 'inline-block';
    let buffers = [];
    try {
        let text = variant.mediaPlaylistContent || '';
        if (!text) {
           const res = await fetch(variant.url);
           if (!res.ok) throw new Error("Failed to fetch media playlist");
           text = await res.text();
        }

        setStatus("Parsing segments...");
        const segments = [];
        const lines = text.split('\n');
        for (let line of lines) {
            line = line.trim();
            if (line.startsWith('#EXT-X-MAP:')) {
                // Extract the URI from the MAP tag which contains the vital MP4 header (init segment)
                const match = line.match(/URI="([^"]+)"/);
                if (match && match[1]) {
                    // Put the init segment at the absolute beginning of the segments list
                    segments.unshift(toAbsolute(variant.url || m3u8Url, match[1]));
                }
            } else if (line && !line.startsWith('#')) {
                segments.push(toAbsolute(variant.url || m3u8Url, line));
            }
        }

        if (segments.length === 0) throw new Error("No video segments found.");

        setStatus(`Ready to download ${segments.length} segments...`);
        let downloadedCount = 0;
        const CONCURRENCY = 6;

        for (let i = 0; i < segments.length; i += CONCURRENCY) {
            const chunk = segments.slice(i, i + CONCURRENCY);
            const promises = chunk.map(async (segUrl) => {
                let retries = 3;
                while (retries > 0) {
                   try {
                      const segRes = await fetch(segUrl);
                      if (!segRes.ok) throw new Error("Bad status");
                      return await segRes.arrayBuffer();
                   } catch (e) {
                      retries--;
                      if (retries === 0) throw e;
                      await new Promise(r => setTimeout(r, 1000));
                   }
                }
            });

            const results = await Promise.all(promises);
            buffers.push(...results);
            downloadedCount += results.length;
            const pct = Math.round((downloadedCount / segments.length) * 100);
            progressEl.style.width = `${pct}%`;
            statusEl.textContent = `Downloading segments: ${downloadedCount} / ${segments.length} (${pct}%)`;
        }

        progressEl.style.width = '0%';
        progressEl.style.backgroundColor = '#f59e0b';
        setStatus("Loading FFmpeg Engine...");
        log(`Cross-Origin Isolated: ${window.crossOriginIsolated}`);
        
        if (typeof SharedArrayBuffer === 'undefined') {
             throw new Error("SharedArrayBuffer is undefined! MV3 Cross-Origin headers might be missing or blocked.");
        }
        
        if (!window.FFmpegWASM) {
             throw new Error("window.FFmpegWASM is undefined! ffmpeg.js failed to load properly.");
        }

        const { FFmpeg } = window.FFmpegWASM;
        const ffmpeg = new FFmpeg();
        ffmpeg.on('progress', ({ progress }) => {
            const pct = Math.round(progress * 100);
            if (pct > 0 && pct <= 100) {
                statusEl.textContent = `Converting to MP4: ${pct}%`;
                progressEl.style.width = `${pct}%`;
            }
        });
        ffmpeg.on('log', ({ message }) => { log(`[FFmpeg] ${message}`); });

        await ffmpeg.load({
            coreURL: chrome.runtime.getURL('vendor/ffmpeg-core/ffmpeg-core.js'),
            wasmURL: chrome.runtime.getURL('vendor/ffmpeg-core/ffmpeg-core.wasm'),
            workerURL: chrome.runtime.getURL('vendor/ffmpeg/814.ffmpeg.js')
        });

        setStatus("Merging segments in memory...");
        // Calculate total size
        let totalLen = 0;
        for (let b of buffers) totalLen += b.byteLength;
        
        // Create one giant buffer
        const giantBuffer = new Uint8Array(totalLen);
        let offset = 0;
        for (let b of buffers) {
            giantBuffer.set(new Uint8Array(b), offset);
            offset += b.byteLength;
        }

        log(`Giant buffer created: ${totalLen} bytes. Passing to FFmpeg...`);
        
        const VIRTUAL_INPUT = 'input_fragmented.mp4';
        await ffmpeg.writeFile(VIRTUAL_INPUT, giantBuffer);
        
        setStatus("Converting and Repairing MP4 File... Please wait.");
        // This command tells FFmpeg to read the giant fragmented MP4 and rewrite its internal headers into a standard MP4
        await ffmpeg.exec(['-i', VIRTUAL_INPUT, '-c', 'copy', '-movflags', 'faststart', 'output.mp4']);
        
        setStatus("Finalizing MP4 file...");
        const data = await ffmpeg.readFile('output.mp4');
        const finalBlob = new Blob([data.buffer], { type: 'video/mp4' });
        ffmpeg.terminate();

        triggerDownload(finalBlob);

    } catch (err) {
        let msg = "Unknown Error";
        if (err && err.message) msg = err.message;
        else if (err) msg = String(err);
        
        log(`CRITICAL ERROR: ${msg}`);
        if (err && err.stack) log(err.stack);
        console.warn("Pipeline crashed:", err);
        
        setStatus("Error on FFmpeg conversion. Activating Ultimate Fallback...");
        log("Forcing pure binary segment merge (valid for Fragmented MP4s)...");
        
        try {
            log("Attempting to combine buffers...");
            const fallbackBlob = new Blob(buffers, { type: 'video/mp4' });
            log(`Blob created successfully! Size: ${fallbackBlob.size} bytes`);
            triggerDownload(fallbackBlob);
        } catch (fallbackErr) {
            let fmsg = fallbackErr && fallbackErr.message ? fallbackErr.message : String(fallbackErr);
            log(`FATAL FALLBACK ERROR: ${fmsg}`);
            if (fallbackErr.name === 'QuotaExceededError') {
                log("The video is too large for Chrome's memory limits.");
            }
            statusEl.textContent = "Fatal error: Fallback failed too.";
            progressEl.style.backgroundColor = 'var(--error)';
            spinner.style.display = 'none';
            closeBtn.style.display = 'inline-block';
        }
    }
}

function triggerDownload(blob) {
    try {
        setStatus("Conversion complete! Triggering download...");
        progressEl.style.width = '100%';
        progressEl.style.backgroundColor = 'var(--success)';
        spinner.style.display = 'none';

        filename = filename.replace(/\.(ts|m3u8|mp4)$/i, '');
        filename += '.mp4';
        
        log("Creating Object URL from Blob...");
        const blobUrl = URL.createObjectURL(blob);
        log("Object URL created. Bypassing Chrome Extension API and using direct Anchor tag download...");
        
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        
        log("Download triggered successfully via Anchor Tag.");
        setStatus("File saved! You can close this tab.");
        closeBtn.style.display = 'inline-block';
        
        setTimeout(() => { 
            document.body.removeChild(a);
            URL.revokeObjectURL(blobUrl); 
        }, 10000);
        
    } catch (e) {
        log(`TriggerDownload ERROR: ${e.message}`);
    }
}

if (m3u8Url) {
    startProcess();
} else {
    setStatus("Error: No URL provided.");
    spinner.style.display = 'none';
}
