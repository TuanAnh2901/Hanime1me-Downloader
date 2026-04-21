## Hanime Download Tool (Dev)

Tiện ích Userscript giúp trích xuất link tải video từ `hanime1.me` và hỗ trợ tải nhanh.

### New Features
- Bulk crawl and download now supports /search?query=... pages (e.g., https://hanime1.me/search?query=デモデモン), similar to /maker/. Crawls pagination, extracts all video links, then streams—like IwaraDownloadTool style.
- Added persistent settings for preferred resolution (highest, 1080p, etc.), saved via GM_setValue. Fixed "Settings" button (green) to open panel and choose/save.
- Downloads (single/bulk/per-video buttons) now select stream matching preferred res; fallback to highest if no match.
- For m3u8, downloads .ts (convert with ffmpeg).

### Troubleshooting
- If no streams: Enable debug `HanimeDLSetDebug(true)`, check logs. API fallback should handle most cases.
- Hang fixed: Optimized observers/recursion/delays.

### Cài đặt
- `npm i` & `npm run build` for `dist/HanimeDownloadTool.user.js`.

### Sử dụng
- Video page: "Get Download Links" for panel.
- Maker/Search page: "Bulk Download Videos" for all, per-video "Download" buttons (uses preferred res).
- Settings: "Settings" button to choose resolution (saved across sessions).

### Ghi chú
- Crawl uses same selectors as maker; works for search as structure similar.
- Add more settings later if needed (e.g., format).