# Hanime Download Tool - Project Documentation

## Overview

**Project Type:** Tampermonkey/Greasemonkey Userscript
**Build System:** esbuild + TypeScript
**Output:** Standalone `.user.js` file installable in browser user script managers

This project is a browser extension (userscript) that runs on `hanime1.me` to extract and download video content. It is NOT an Electron app, Node.js CLI tool, or website scraper.

---

## Project Type Comparison

| Attribute | Value |
|-----------|-------|
| Platform | Browser (Tampermonkey/Greasemonkey) |
| Language | TypeScript (compiled to JS) |
| Runtime | Browser extension API (GM_ APIs) |
| Distribution | Single `.user.js` file |
| Installation | Via Tampermonkey dashboard |

---

## Dependencies

### Dev Dependencies (Build-time only)

| Package | Version | Purpose |
|---------|---------|---------|
| **esbuild** | ^0.23.0 | Bundles TypeScript into a single IIFE userscript file |
| **typescript** | ^5.4.0 | TypeScript compiler / type checking |

### No Runtime Dependencies

Everything is vanilla JavaScript using native DOM APIs and Tampermonkey GM APIs.

---

## File Structure

```
HanimeDownloadTool-dev/
├── README.md                        # Project documentation (Vietnamese)
├── package.json                     # Project config, scripts, devDependencies
├── tsconfig.json                    # TypeScript config (target ES2020, DOM lib)
│
├── build/
│   ├── build.ts                     # esbuild build script (TypeScript source)
│   └── build.js                     # Compiled build script (executed during build)
│
├── src/
│   ├── main.ts                      # MAIN LOGIC - Core of the app (~1135 lines)
│   ├── env.ts                       # Utility helpers
│   ├── logger.ts                    # Logger class with debug levels & GM storage
│   ├── downloader.ts                # M3U8 segment downloader
│   └── mata/
│       └── userjs.mata              # Tampermonkey metadata block template
│
└── dist/
    └── HanimeDownloadTool.user.js   # BUILT OUTPUT - Installable userscript
```

---

## Main Entry Points

| File | Purpose |
|------|---------|
| `src/main.ts` | Core logic - defines UI buttons, stream extraction, bulk crawling, settings, observers |
| `build/build.js` | Build script entry - runs esbuild to produce the `.user.js` |
| `src/mata/userjs.mata` | Metadata template - prepended to output (`==UserScript==` block with GM grants) |

---

## Core Functionality

### 1. Stream Extraction

The script extracts video download URLs from multiple sources (in priority order):

- **Nuxt.js State (`window.__NUXT__`)** - Server-side rendered state containing stream data
- **Inline JSON Scripts** - `<script type="application/json">` tags with `streams` or `videos_manifest`
- **DOM Elements** - `.plyr__video-wrapper > video > source` selectors
- **API Fallback** - `/api/v8/video?id=<slug>` endpoint

The `extractStreamsFromState` function recursively walks objects/arrays (up to depth 10) to find stream URLs.

### 2. Single Video Download

- "Get Download Links" button appears on video pages
- Shows a panel with all found streams (sorted by quality)
- Each stream has "Copy" and "Download" buttons
- Supports multiple quality levels (1080p, 720p, 480p, 360p)

### 3. Bulk Crawl & Download

Available on `/maker/` and `/search?query=...` pages:

- "Bulk Download Videos" button
- Crawls all pagination pages to collect video URLs
- Opens each video in a new tab with `?auto_dl=1` query parameter
- Automatic sequential processing with progress tracking

### 4. Per-Video Download Buttons

On listing pages (browse, search, maker):
- "Download" buttons injected into video cards
- Each button triggers download for that specific video

### 5. M3U8 / HLS Download

When an `.m3u8` HLS stream is detected:

1. Fetches and parses the M3U8 playlist
2. Downloads all `.ts` (Transport Stream) segments concurrently
3. Merges segments into a single `.ts` blob
4. Triggers download via temporary anchor element

> Note: Output is `.ts` format. Users convert to MP4 using external tools like ffmpeg.

### 6. Settings Persistence

Preferred resolution stored via `GM_setValue`:
- `highest` - Best available quality
- `1080p`, `720p`, `480p`, `360p` - Specific resolutions

### 7. Auto-Download Mode

When a page is opened with `?auto_dl=1` parameter:
1. Automatically extracts the best available stream
2. Starts download immediately
3. Closes the tab after download begins

### 8. Debug Logger

Enable verbose logging by running in browser console:
```javascript
HanimeDLSetDebug(true)
```

Logs are persisted via GM storage and show detailed extraction progress.

### 9. Download Queue Management

`DownloadQueue` class manages:
- Sequential downloads to avoid overwhelming the server
- Progress callbacks
- Error handling and retry logic

### 10. Future Support (Stubbed)

`DownloadType` enum includes unused cases:
- `Aria2` - RPC download support (not implemented)
- `IwaraDownloader` - Iwara site support (not implemented)

---

## Architecture & Patterns

### Tampermonkey GM APIs Used

- `GM_download` - Cross-origin downloads
- `GM_openInTab` - Open URLs in new tabs
- `GM_setValue` / `GM_getValue` - Persistent storage
- `GM_xmlhttpRequest` - Advanced HTTP requests (potential future use)

### DOM Observation

**MutationObserver** watches for dynamic content loading:
- Detects new video cards on listing pages
- Re-triggers extraction when content updates

### SPA Navigation Handling

**History API Interception:**
- Wraps `pushState` and `replaceState` methods
- Re-extracts streams on client-side navigation
- Ensures functionality works with Single Page Applications

### Fetch Interception

- Patches `window.fetch` to capture JSON responses
- Detects `.m3u8` URLs in responses
- Enables stream detection without page reload

### Debouncing

Prevents rapid repeated extraction on DOM mutations using configurable debounce intervals.

### URL Deduplication

`uniqueByUrl` function prevents duplicate stream entries in the results panel.

### File Naming

Sanitizes filenames by stripping non-alphanumeric characters:
```
Hanime1.me Video - Episode 1.mp4 → Hanime1meVideoEpisode1.mp4
```

### Blob Download Pattern

For M3U8 downloads:
```javascript
const blob = new Blob(segments, { type: 'video/mp2t' });
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url;
a.download = filename;
a.click();
URL.revokeObjectURL(url);
```

---

## Build Process

### Build Command

```bash
npm run build
```

### Build Script Logic (`build/build.js`)

1. Runs esbuild to bundle `src/main.ts` and its imports
2. Output format: **IIFE** (Immediately Invoked Function Expression)
3. Target: **ES2020**
4. Prepends userscript metadata from `src/mata/userjs.mata`
5. Writes final output to `dist/HanimeDownloadTool.user.js`

### Output File Structure

```javascript
// ==UserScript==
// @name         Hanime Download Tool
// @namespace    ...
// @version      ...
// @description  ...
// @grant        GM_download
// @grant        GM_openInTab
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(function() {
    // Bundled code from src/main.ts
})();
```

---

## Configuration Files

### package.json

```json
{
  "name": "hanime-download-tool",
  "version": "dev",
  "scripts": {
    "build": "node build/build.js"
  },
  "devDependencies": {
    "esbuild": "^0.23.0",
    "typescript": "^5.4.0"
  }
}
```

### tsconfig.json

- Target: ES2020
- DOM library included
- Strict mode enabled
- Output to dist/

---

## Installation

1. Install **Tampermonkey** browser extension
2. Open `dist/HanimeDownloadTool.user.js` in a text editor
3. Copy all content
4. In Tampermonkey dashboard, click "+ Create new script"
5. Paste the content and save
6. Visit `hanime1.me` - the UI will appear automatically

---

## Key Files Detail

### src/main.ts (~1135 lines)

**Contains:**
- Stream extraction logic
- UI generation and button creation
- Bulk crawling functionality
- Settings management
- MutationObserver setup
- History API wrapping
- Fetch interception

### src/env.ts

**Utility functions:**
- `isNull(val)` - Null check
- `isObject(val)` - Object type check
- `delay(ms)` - Promise-based delay
- `UUID()` - Generate unique IDs

### src/logger.ts

**Logger class:**
- Debug levels: `log`, `warn`, `error`
- GM storage persistence
- `HanimeDLSetDebug(true)` global setter
- Timestamped output

### src/downloader.ts

**M3U8Downloader class:**
- Fetches and parses `.m3u8` playlists
- Downloads `.ts` segments with concurrency control
- Merges segments into downloadable blob
- Progress tracking

### src/mata/userjs.mata

**Tampermonkey metadata block template:**
```javascript
// ==UserScript==
// @name         Hanime Download Tool
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Download videos from hanime1.me
// @author       You
// @match        https://hanime1.me/*
// @grant        GM_download
// @grant        GM_openInTab
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==
```

---

## Technologies & Libraries Summary

| Technology | Usage |
|-----------|-------|
| TypeScript | Type-safe development |
| esbuild | Fast bundling |
| Tampermonkey GM APIs | Browser extension capabilities |
| DOM APIs | HTML parsing and manipulation |
| Fetch API | HTTP requests |
| MutationObserver | Dynamic content detection |
| History API | SPA navigation tracking |
| Blob API | File assembly for download |
| GM Storage | Persistent settings |
| GM Download | Cross-origin downloads |

---

## Usage Scenarios

### Single Download
1. Open any video page on hanime1.me
2. Click "Get Download Links" button
3. Select desired quality
4. Click Download or Copy URL

### Bulk Download
1. Go to `/maker/` or `/search?query=...`
2. Click "Bulk Download Videos" button
3. Wait for crawl to complete
4. Each video opens in new tab and auto-downloads

### Auto-Download
1. Use bookmarklet or external tool to open:
   ```
   https://hanime1.me/video/{slug}?auto_dl=1
   ```
2. Video downloads automatically
3. Tab closes

---

## Notes & Limitations

- M3U8 downloads produce `.ts` files (not MP4)
- Users need external tools (ffmpeg) to convert `.ts` to MP4
- Some stream sources may be blocked by CORS
- Bulk download opens many tabs (browser may block popups)
- Download quality depends on available streams from the server