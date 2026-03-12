# HH Video Downloader

A powerful Google Chrome extension designed to detect and download various types of videos from web pages, with a special focus on intercepting and perfectly converting HLS (`.m3u8` / `.ts`) stream fragments into standard, playable `.mp4` files.

## Features
- **Smart Detection**: Detects MP4, WEBM, OGG, and HLS (m3u8) streams.
- **Auto-Filtering**: Automatically filters out ad segments, tiny fragments, and tracking pixels.
- **Stream Quality Selector**: Fetches master HLS playlists, estimates file sizes, and lets you choose the exact resolution.
- **In-Browser FFmpeg Conversion**: Downloads hundreds of `.ts` stream fragments and seamlessly converts them into a single, standard `.mp4` file before saving.
- **Notification Badge**: Shows the number of detectable videos on the extension icon in real-time.

## Installation / How to Load
1. Open Google Chrome.
2. Navigate to `chrome://extensions/` in the URL bar.
3. Toggle on **Developer mode** in the top-right corner.
4. Click **Load unpacked** in the top-left corner.
5. Select the `HH_downloader` folder on your computer.

## Technologies and Libraries Used
This extension is completely standalone and runs 100% inside your Chrome browser. **It does not install any system-level software, background services, or native applications on your Mac/PC.**

Included Third-Party Libraries (located in the `vendor/` folder):

1. **[ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm)** 
   - **What it is**: A WebAssembly (WASM) port of the world-class FFmpeg video processing tool.
   - **Why it's here**: It allows the extension to perform true video format conversion (from MPEG-TS fragments to an MP4 container) entirely inside the browser's memory. It guarantees the final download is a valid `.mp4` file that any player can read.
   - **Is it installed on my computer?**: No. It is simply a cluster of Javascript and WebAssembly files (`ffmpeg.js`, `ffmpeg-core.js`, `ffmpeg-core.wasm`) bundled inside the extension. It only runs safely inside Chrome's sandbox when you click download.

*Note: During development, Node.js and `npm` were briefly used to download the ffmpeg.wasm distribution files, which generated the `package.json`, `package-lock.json`, and `node_modules` folders. These are not required for the extension to run and can be ignored.*

## Usage
- Go to any web page containing a video.
- The extension icon will show a red badge with the number of videos found.
- Click the extension icon to view the list.
- Click **Download Full Stream** or **Download Video**. 
- Follow the on-screen progress bar as the extension downloads and converts the file.
