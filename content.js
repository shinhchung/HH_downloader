// HH Downloader Content Script - Handles HLS downloading on the page

let isDownloading = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'download_hls') {
    if (isDownloading) {
      console.warn("A download is already in progress. Please wait until it finishes.");
      return;
    }
    
    startHlsProcess(message.url, message.filename);
  }
});

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

// Helper for human readable capacity
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

async function startHlsProcess(m3u8Url, filename) {
  isDownloading = true;
  const ui = createFloatingUI(filename);
  document.body.appendChild(ui.container);

  try {
    ui.setStatus("Analyzing stream qualities...");

    // 1. Fetch main m3u8
    let res = await fetch(m3u8Url);
    if (!res.ok) throw new Error("Failed to fetch m3u8");
    let text = await res.text();

    let variants = [];

    // Check if it's a master playlist
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
                    variants.push({
                        bandwidth: bw,
                        resolution: resolution,
                        url: toAbsolute(m3u8Url, url)
                    });
                }
            }
        }
    } else {
        // It's already a media playlist
        variants.push({
            bandwidth: 0,
            resolution: 'Default',
            url: m3u8Url,
            isMedia: true
        });
    }

    if (variants.length === 0) {
        throw new Error("No video streams found in the playlist.");
    }

    // Sort variants by bandwidth descending
    variants.sort((a, b) => b.bandwidth - a.bandwidth);

    ui.setStatus("Estimating file sizes...");
    
    // Fetch all variant media playlists concurrently to get segment count & duration
    await Promise.all(variants.map(async (v) => {
        try {
            const mRes = await fetch(v.url);
            const mText = await mRes.text();
            
            // Calculate total duration
            let duration = 0;
            const mLines = mText.split('\n');
            let segCount = 0;
            for (const l of mLines) {
                if (l.startsWith('#EXTINF:')) {
                    const time = parseFloat(l.split(':')[1].split(',')[0]);
                    if (!isNaN(time)) duration += time;
                    segCount++;
                }
            }
            v.duration = duration;
            v.segmentCount = segCount;
            v.mediaPlaylistContent = mText; // cache it

            if (v.bandwidth > 0 && duration > 0) {
                // Approximate bits per second * seconds = total bits. Divide by 8 for bytes.
                v.estimatedBytes = (v.bandwidth / 8) * duration;
                v.displaySize = "~" + formatBytes(v.estimatedBytes);
            } else {
                v.displaySize = "Unknown Size";
            }
        } catch (e) {
            v.displaySize = "Error estimating";
        }
    }));

    // Construct Selection UI
    ui.showVariantSelection(variants, (selectedVariant) => {
        downloadVariant(selectedVariant, filename, ui);
    }, () => {
        // Cancelled
        isDownloading = false;
        ui.close();
    });

  } catch (err) {
    console.error("HLS Process Error:", err);
    ui.setStatus(`Error: ${err.message}`);
    ui.showCloseBtn();
    isDownloading = false;
  }
}

async function downloadVariant(variant, filename, ui) {
    try {
        let text = variant.mediaPlaylistContent || '';
        if (!text) {
           const res = await fetch(variant.url);
           if (!res.ok) throw new Error("Failed to fetch media playlist");
           text = await res.text();
        }

        ui.setStatus("Parsing segments...");
        const segments = [];
        const lines = text.split('\n');

        for (let line of lines) {
            line = line.trim();
            if (line && !line.startsWith('#')) {
                segments.push(toAbsolute(variant.url, line));
            }
        }

        if (segments.length === 0) {
            throw new Error("No video segments found in the playlist.");
        }

        ui.setStatus(`Ready to download ${segments.length} segments...`);

        // 3. Download segments
        const buffers = [];
        let downloadedCount = 0;
        const CONCURRENCY = 4; // Fetch 4 segments at a time

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
            ui.setProgress(downloadedCount, segments.length);
        }

        // 4. Combine and convert via FFmpeg
        ui.setStatus("Loading FFmpeg for conversion... (One time)");
        await new Promise(r => setTimeout(r, 100)); // allow UI to update

        let finalBlob;

        try {
            // Ensure FFmpeg is loaded
            if (typeof FFmpeg === 'undefined') {
                await new Promise((resolve, reject) => {
                    const script = document.createElement('script');
                    script.src = chrome.runtime.getURL('vendor/ffmpeg/ffmpeg.js');
                    script.onload = resolve;
                    script.onerror = reject;
                    document.head.appendChild(script);
                });
            }

            ui.setStatus("Initializing FFmpeg Engine...");
            
            const { FFmpeg } = window.FFmpeg;
            const ffmpeg = new FFmpeg();
            
            ffmpeg.on('progress', ({ progress }) => {
                const pct = Math.round(progress * 100);
                if (pct > 0 && pct <= 100) {
                    ui.setStatus(`Converting to MP4: ${pct}%`);
                    const pbar = ui.container.querySelector('div > div');
                    if (pbar) pbar.style.width = `${pct}%`;
                }
            });
            
            ffmpeg.on('log', ({ message }) => {
                console.log(`[FFmpeg] ${message}`);
            });

            await ffmpeg.load({
                coreURL: chrome.runtime.getURL('vendor/ffmpeg-core/ffmpeg-core.js'),
                wasmURL: chrome.runtime.getURL('vendor/ffmpeg-core/ffmpeg-core.wasm'),
            });

            ui.setStatus("Writing data to memory chunk by chunk...");
            
            // To avoid Out Of Memory errors, we write chunks to a single virtual file
            // by appending them sequentially, avoiding allocating one massive JS array
            const VIRTUAL_INPUT = 'input.ts';
            
            // Create empty file
            await ffmpeg.writeFile(VIRTUAL_INPUT, new Uint8Array(0));
            
            // Append buffers one by one using a trick in ffmpeg.wasm:
            // Read existing, concat new, write back (not perfectly efficient but avoids single gigantic JS allocation upfront)
            // Wait, ffmpegwasm v0.12+ doesn't have an append method directly, 
            // the best way is to create a concat list.
            
            let concatList = '';
            for (let i = 0; i < buffers.length; i++) {
                const chunkName = `chunk_${i}.ts`;
                await ffmpeg.writeFile(chunkName, new Uint8Array(buffers[i]));
                concatList += `file '${chunkName}'\n`;
            }
            
            await ffmpeg.writeFile('list.txt', concatList);
            
            ui.setStatus("Converting... Please wait.");
            
            // Run conversion using the concat demuxer which tells FFmpeg to stitch them and convert to MP4
            await ffmpeg.exec(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', '-movflags', 'faststart', 'output.mp4']);
            
            ui.setStatus("Finalizing MP4 file...");
            const data = await ffmpeg.readFile('output.mp4');
            finalBlob = new Blob([data.buffer], { type: 'video/mp4' });
            
            // Clean up memory
            ffmpeg.terminate();

        } catch (err) {
            console.error("FFmpeg Conversion failed, forcing raw combined MP4 save fallback:", err);
            ui.setStatus("Conversion error. Saving raw stream as MP4...");
            await new Promise(r => setTimeout(r, 1500));
            // Force save as MP4 even if it's technically TS inside.
            finalBlob = new Blob(buffers, { type: 'video/mp4' });
        }

        ui.setStatus("Download ready! Saving file...");
        // Ensure filename ends strictly with .mp4
        filename = filename.replace(/\.(ts|m3u8|mp4)$/i, '');
        filename += '.mp4';

        const blobUrl = URL.createObjectURL(finalBlob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        setTimeout(() => {
            URL.revokeObjectURL(blobUrl);
            ui.close();
            isDownloading = false;
        }, 5000);

    } catch (err) {
        console.error("HLS Download Error:", err);
        ui.setStatus(`Error: ${err.message}`);
        ui.showCloseBtn();
        isDownloading = false;
    }
}

// Helper to create a nice floating UI
function createFloatingUI(filename) {
    const container = document.createElement('div');
    container.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 340px;
        background: #1e293b;
        color: #f8fafc;
        border-radius: 12px;
        box-shadow: 0 10px 15px -3px rgba(0,0,0,0.5), 0 4px 6px -2px rgba(0,0,0,0.3);
        padding: 16px;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        border: 1px solid #334155;
        transition: all 0.3s ease;
    `;

    const titleDiv = document.createElement('div');
    titleDiv.style.cssText = `
        font-weight: 600;
        font-size: 14px;
        margin-bottom: 8px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    `;
    titleDiv.textContent = `Downloading: ${filename}`;
    container.appendChild(titleDiv);

    const statusDiv = document.createElement('div');
    statusDiv.style.cssText = `
        font-size: 13px;
        color: #94a3b8;
        margin-bottom: 12px;
    `;
    statusDiv.textContent = "Starting...";
    container.appendChild(statusDiv);

    const progressContainer = document.createElement('div');
    progressContainer.style.cssText = `
        width: 100%;
        height: 8px;
        background: #334155;
        border-radius: 4px;
        overflow: hidden;
        display: none;
    `;
    const progressBar = document.createElement('div');
    progressBar.style.cssText = `
        width: 0%;
        height: 100%;
        background: #3b82f6;
        transition: width 0.2s ease;
    `;
    progressContainer.appendChild(progressBar);
    container.appendChild(progressContainer);
    
    // UI Area for variants
    const variantsContainer = document.createElement('div');
    variantsContainer.style.display = 'none';
    variantsContainer.style.flexDirection = 'column';
    variantsContainer.style.gap = '8px';
    variantsContainer.style.marginTop = '12px';
    variantsContainer.style.maxHeight = '200px';
    variantsContainer.style.overflowY = 'auto';
    // hide scrollbar but keep functionality
    variantsContainer.style.scrollbarWidth = 'none';
    
    container.appendChild(variantsContainer);

    const closeBtn = document.createElement('button');
    closeBtn.textContent = "Close";
    closeBtn.style.cssText = `
        margin-top: 12px;
        width: 100%;
        padding: 6px;
        background: #ef4444;
        color: white;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 500;
        display: none;
    `;
    closeBtn.addEventListener('click', () => {
        container.remove();
        isDownloading = false;
    });
    container.appendChild(closeBtn);

    return {
        container,
        setStatus: (text) => { statusDiv.textContent = text; },
        setProgress: (done, total) => {
            progressContainer.style.display = 'block';
            const pct = Math.round((done / total) * 100);
            progressBar.style.width = `${pct}%`;
            statusDiv.textContent = `Downloading segments: ${done} / ${total} (${pct}%)`;
        },
        showVariantSelection: (variants, onSelect, onCancel) => {
            progressContainer.style.display = 'none';
            statusDiv.textContent = "Select Video Quality:";
            variantsContainer.style.display = 'flex';
            variantsContainer.innerHTML = '';
            
            variants.forEach(variant => {
                const btn = document.createElement('button');
                btn.style.cssText = `
                    background: #334155;
                    color: white;
                    border: 1px solid #475569;
                    padding: 10px;
                    border-radius: 6px;
                    cursor: pointer;
                    display: flex;
                    justify-content: space-between;
                    font-size: 13px;
                    transition: all 0.2s ease;
                `;
                btn.innerHTML = `<span style="font-weight: 600;">${variant.resolution === 'Unknown' ? 'Video Stream' : variant.resolution}</span> <span style="color:#94a3b8; font-size: 12px;">${variant.displaySize}</span>`;
                
                btn.onmouseover = () => { btn.style.background = '#475569'; btn.style.borderColor = '#64748b'; };
                btn.onmouseout = () => { btn.style.background = '#334155'; btn.style.borderColor = '#475569'; };
                
                btn.onclick = () => {
                    variantsContainer.style.display = 'none';
                    progressContainer.style.display = 'block';
                    onSelect(variant);
                };
                variantsContainer.appendChild(btn);
            });
            
            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = "Cancel";
            cancelBtn.style.cssText = `
                background: transparent;
                color: #94a3b8;
                border: 1px solid #475569;
                padding: 10px;
                border-radius: 6px;
                cursor: pointer;
                font-size: 13px;
                margin-top: 4px;
            `;
            cancelBtn.onmouseover = () => cancelBtn.style.color = '#f8fafc';
            cancelBtn.onmouseout = () => cancelBtn.style.color = '#94a3b8';
            cancelBtn.onclick = onCancel;
            variantsContainer.appendChild(cancelBtn);
        },
        showCloseBtn: () => {
            closeBtn.style.display = 'block';
            progressContainer.style.display = 'none';
        },
        close: () => {
            container.style.opacity = '0';
            setTimeout(() => container.remove(), 300);
        }
    };
}
