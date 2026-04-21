// ==UserScript==
// @name         Hanime Download Tool (Dev)
// @namespace    https://github.com/yourname/hanime-download-tool
// @version      0.0.7
// @description  Trích xuất link tải video từ hanime1.me và hỗ trợ tải nhanh, with bulk download for makers
// @author       You
// @match        https://hanime1.me/*
// @grant        GM_download
// @grant        GM_openInTab
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-end
// @updateURL    https://raw.githubusercontent.com/yourname/hanime-download-tool/dev/dist/HanimeDownloadTool.user.js
// @downloadURL  https://raw.githubusercontent.com/yourname/hanime-download-tool/dev/dist/HanimeDownloadTool.user.js
// ==/UserScript==

"use strict";
(() => {
  // src/env.ts
  var isNull = (obj) => obj === null;
  var isUndefined = (obj) => typeof obj === "undefined";
  var isNullOrUndefined = (obj) => isUndefined(obj) || isNull(obj);
  var isObject = (obj) => !isNullOrUndefined(obj) && typeof obj === "object";
  function delay(time) {
    return new Promise((resolve) => setTimeout(resolve, time));
  }

  // src/logger.ts
  function now() {
    const d = /* @__PURE__ */ new Date();
    return d.toISOString();
  }
  function readFlag() {
    try {
      if (typeof GM_getValue === "function") {
        const v = GM_getValue("hanime-dl-debug", false);
        return !!v;
      }
    } catch (_) {
    }
    try {
      const v = localStorage.getItem("hanime-dl-debug");
      return v === "true";
    } catch (_) {
    }
    return false;
  }
  function writeFlag(v) {
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue("hanime-dl-debug", v);
        return;
      }
    } catch (_) {
    }
    try {
      localStorage.setItem("hanime-dl-debug", v ? "true" : "false");
    } catch (_) {
    }
  }
  var Logger = class {
    constructor() {
      this.enabled = readFlag();
    }
    setEnabled(v) {
      this.enabled = v;
      writeFlag(v);
    }
    isEnabled() {
      return this.enabled;
    }
    fmt(level, msg) {
      return [`[HanimeDL][${level.toUpperCase()}][${now()}]`, ...msg];
    }
    debug(...msg) {
      if (this.enabled) console.debug(...this.fmt("debug", msg));
    }
    info(...msg) {
      console.info(...this.fmt("info", msg));
    }
    warn(...msg) {
      console.warn(...this.fmt("warn", msg));
    }
    error(...msg) {
      console.error(...this.fmt("error", msg));
    }
    group(label) {
      if (this.enabled) console.group(`[HanimeDL] ${label}`);
    }
    groupEnd() {
      if (this.enabled) console.groupEnd();
    }
  };
  var logger = new Logger();
  window.HanimeDLLogger = logger;
  window.HanimeDLSetDebug = (v) => logger.setEnabled(v);

  // src/downloader.ts
  async function downloadM3u8(m3u8Url, filename, concurrent = 5) {
    try {
      logger.info(`Starting M3U8 download for ${filename}`);
      const m3u8Text = await fetch(m3u8Url).then((res) => res.text());
      const lines = m3u8Text.split("\n");
      const segments = [];
      let baseUrl = m3u8Url.slice(0, m3u8Url.lastIndexOf("/") + 1);
      for (let line of lines) {
        line = line.trim();
        if (line && !line.startsWith("#") && line.endsWith(".ts")) {
          const absUrl = line.startsWith("http") ? line : baseUrl + line;
          segments.push(absUrl);
        }
      }
      logger.info(`Found ${segments.length} segments`);
      const blobs = [];
      const chunks = Array.from(
        { length: Math.ceil(segments.length / concurrent) },
        (_, i) => segments.slice(i * concurrent, (i + 1) * concurrent)
      );
      for (const chunk of chunks) {
        const promises = chunk.map(async (url) => {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`Failed to fetch segment ${url}`);
          return await res.blob();
        });
        const chunkBlobs = await Promise.all(promises);
        blobs.push(...chunkBlobs);
        await delay(500);
      }
      const fullBlob = new Blob(blobs, { type: "video/mp2t" });
      const dlUrl = URL.createObjectURL(fullBlob);
      const a = document.createElement("a");
      a.href = dlUrl;
      a.download = `${filename}.ts`;
      a.click();
      URL.revokeObjectURL(dlUrl);
      logger.info(`Downloaded ${filename}.ts`);
    } catch (err) {
      logger.error(`M3U8 download failed: ${err}`);
    }
  }

  // src/main.ts
  async function downloadBlob(url, filename) {
    try {
      logger.info(`Downloading blob: ${filename} from ${url}`);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(blobUrl);
      logger.info(`Blob download completed: ${filename}`);
    } catch (err) {
      logger.error(`Blob download failed: ${err}`);
      throw err;
    }
  }
  var DownloadQueue = class {
    constructor() {
      this.queue = [];
      this.processing = false;
      this.currentIndex = 0;
      this.totalCount = 0;
    }
    add(item) {
      this.queue.push(item);
      this.totalCount = this.queue.length;
    }
    async process(downloadType = "browser" /* Browser */) {
      if (this.processing) return;
      this.processing = true;
      this.currentIndex = 0;
      logger.info(`Starting download queue processing: ${this.totalCount} items`);
      for (const item of this.queue) {
        this.currentIndex++;
        logger.info(`Processing ${this.currentIndex}/${this.totalCount}: ${item.title}`);
        if (this.progressCallback) {
          this.progressCallback(this.currentIndex, this.totalCount, item.title);
        }
        try {
          await this.downloadItem(item, downloadType);
          await delay(2e3);
        } catch (error) {
          logger.error(`Failed to download ${item.title}:`, error);
        }
      }
      this.processing = false;
      logger.info("Download queue completed");
    }
    async downloadItem(item, downloadType) {
      const stream = getPreferredStream(item.streams);
      if (!stream) {
        logger.warn(`No suitable stream found for ${item.title}`);
        return;
      }
      const datetime = item.uploadDate || getCurrentDatetime();
      const filename = formatFilename(filenameTemplate, { title: item.title, artist: item.artist, datetime });
      switch (downloadType) {
        case "browser" /* Browser */:
          await this.browserDownload(stream, filename);
          break;
        case "aria2" /* Aria2 */:
          await this.aria2Download(stream, filename);
          break;
        default:
          await this.browserDownload(stream, filename);
          break;
      }
    }
    async browserDownload(stream, filename) {
      if (stream.url.endsWith(".m3u8")) {
        await downloadM3u8(stream.url, filename);
      } else {
        await downloadBlob(stream.url, `${filename}.mp4`);
      }
    }
    async aria2Download(stream, filename) {
      logger.info(`Aria2 download: ${filename} from ${stream.url}`);
    }
    setProgressCallback(callback) {
      this.progressCallback = callback;
    }
    clear() {
      this.queue = [];
      this.totalCount = 0;
      this.currentIndex = 0;
    }
    get length() {
      return this.queue.length;
    }
  };
  var downloadQueue = new DownloadQueue();
  var currentStreams = [];
  var btnInited = false;
  var bulkBtnInited = false;
  var settingsBtnInited = false;
  var preferredRes = GM_getValue("hanime_preferred_res", "highest");
  var filenameTemplate = GM_getValue("hanime_filename_template", "%title%");
  var warnedNoStreams = false;
  function getNuxtState(dom = document) {
    const w = window;
    if (w.__NUXT__) {
      logger.debug("Found __NUXT__ on window");
      return w.__NUXT__;
    }
    const scripts = Array.from(dom.querySelectorAll('script[type="application/json"]'));
    for (const s of scripts) {
      try {
        const raw = s.textContent || "null";
        logger.debug("Scanning JSON script, length=", raw.length);
        if (raw.includes("streams") || raw.includes("videos_manifest")) {
          const data = JSON.parse(raw);
          return data;
        }
      } catch (_) {
      }
    }
    return void 0;
  }
  function extractStreamsFromState(state) {
    const results = [];
    if (!isObject(state)) return results;
    const findStreams = (obj, depth = 0) => {
      if (depth > 10) return;
      if (isObject(obj)) {
        const loose = obj;
        if (Array.isArray(loose.streams)) {
          for (const it of loose.streams) {
            if (isObject(it) && it.url) {
              results.push({
                url: it.url,
                type: it.format || it.mime,
                resolution: it.height || it.quality
              });
            }
          }
        }
        if (typeof loose.videos_manifest === "string") {
          try {
            const manifest = JSON.parse(loose.videos_manifest);
            findStreams(manifest, depth + 1);
          } catch (e) {
            logger.debug("Failed to parse videos_manifest string: " + e);
          }
        }
        if (isObject(loose.videos_manifest) && Array.isArray(loose.videos_manifest.servers)) {
          for (const server of loose.videos_manifest.servers) {
            if (isObject(server)) {
              const serverLoose = server;
              if (Array.isArray(serverLoose.streams)) {
                for (const it of serverLoose.streams) {
                  if (isObject(it) && it.url) {
                    results.push({
                      url: it.url,
                      type: it.format || it.mime,
                      resolution: it.height || it.quality
                    });
                  }
                }
              }
            }
          }
        }
        for (const k of Object.keys(loose)) findStreams(loose[k], depth + 1);
      } else if (Array.isArray(obj)) {
        for (const it of obj) findStreams(it, depth + 1);
      }
    };
    findStreams(state);
    logger.info("Extracted streams count:", results.length);
    return uniqueByUrl(results);
  }
  function extractTitleFromState(state) {
    let title = "unknown";
    const findTitle = (obj, depth = 0) => {
      if (depth > 10) return;
      if (isObject(obj)) {
        const loose = obj;
        if (typeof loose.name === "string") {
          title = loose.name;
        } else if (isObject(loose.video) && typeof loose.video.name === "string") {
          title = loose.video.name;
        }
        for (const k of Object.keys(loose)) findTitle(loose[k], depth + 1);
      } else if (Array.isArray(obj)) {
        for (const it of obj) findTitle(it, depth + 1);
      }
    };
    findTitle(state);
    return title;
  }
  function uniqueByUrl(list) {
    const s = /* @__PURE__ */ new Set();
    const out = [];
    for (const it of list) {
      if (!s.has(it.url)) {
        s.add(it.url);
        out.push(it);
      }
    }
    return out;
  }
  function attachUI(streams) {
    logger.debug("Attach UI with streams:", streams.length);
    currentStreams = streams;
    ensureButton();
    updateButtonLabel();
  }
  function showPanel(streams) {
    const panelId = "hanime-dl-panel";
    let panel = document.getElementById(panelId);
    if (panel) panel.remove();
    panel = document.createElement("div");
    panel.id = panelId;
    panel.style.position = "fixed";
    panel.style.right = "16px";
    panel.style.bottom = "60px";
    panel.style.width = "420px";
    panel.style.maxHeight = "50vh";
    panel.style.overflow = "auto";
    panel.style.background = "#111827";
    panel.style.color = "#e5e7eb";
    panel.style.padding = "12px";
    panel.style.borderRadius = "8px";
    panel.style.boxShadow = "0 4px 16px rgba(0,0,0,.4)";
    const title = document.createElement("div");
    title.textContent = "Download Streams";
    title.style.fontWeight = "bold";
    title.style.marginBottom = "8px";
    panel.appendChild(title);
    const list = document.createElement("div");
    for (const s of streams) {
      const item = document.createElement("div");
      item.style.display = "flex";
      item.style.alignItems = "center";
      item.style.gap = "8px";
      item.style.margin = "6px 0";
      const a = document.createElement("a");
      a.href = s.url;
      a.textContent = `${s.resolution ?? ""} ${s.type ?? ""}`.trim() || "download";
      a.style.color = "#93c5fd";
      a.target = "_blank";
      const copy = document.createElement("button");
      copy.textContent = "Copy";
      copy.style.padding = "4px 8px";
      copy.style.background = "#374151";
      copy.style.color = "#fff";
      copy.style.border = "none";
      copy.style.borderRadius = "4px";
      copy.style.cursor = "pointer";
      copy.onclick = () => {
        logger.info("Copy link", s.url);
        navigator.clipboard.writeText(s.url);
      };
      const dl = document.createElement("button");
      dl.textContent = "Download";
      dl.style.padding = "4px 8px";
      dl.style.background = "#2563eb";
      dl.style.color = "#fff";
      dl.style.border = "none";
      dl.style.borderRadius = "4px";
      dl.style.cursor = "pointer";
      dl.onclick = () => {
        const datetime = extractUploadDate() || getCurrentDatetime();
        const { artist, title: title2 } = extractArtistAndTitle();
        const fname = formatFilename(filenameTemplate, { title: title2, artist, datetime });
        if (s.url.endsWith(".m3u8")) {
          downloadM3u8(s.url, fname);
        } else {
          downloadBlob(s.url, `${fname}.mp4`);
        }
      };
      item.appendChild(a);
      item.appendChild(copy);
      item.appendChild(dl);
      list.appendChild(item);
    }
    panel.appendChild(list);
    const close = document.createElement("button");
    close.textContent = "Close";
    close.style.marginTop = "8px";
    close.style.background = "#6b7280";
    close.style.color = "#fff";
    close.style.border = "none";
    close.style.borderRadius = "4px";
    close.style.padding = "6px 10px";
    close.onclick = () => {
      logger.info("Close panel");
      panel?.remove();
    };
    panel.appendChild(close);
    document.body.appendChild(panel);
  }
  async function getPageDom(url) {
    const text = await fetch(url).then((res) => res.text());
    return new DOMParser().parseFromString(text, "text/html");
  }
  async function tryExtractFromUrl(url) {
    const text = await fetch(url).then((res) => res.text());
    const dom = new DOMParser().parseFromString(text, "text/html");
    let state = getNuxtState(dom);
    let streams = state ? extractStreamsFromState(state) : [];
    let title = state ? extractTitleFromState(state) : "unknown";
    const uploadDate = extractUploadDateFromPageHtml(text);
    if (streams.length === 0) {
      logger.debug("No streams from DOM, trying API fallback");
      const slug = extractVideoSlug(url);
      if (slug) {
        try {
          const apiUrl = `/api/v8/video?id=${slug}`;
          const response = await fetch(apiUrl);
          if (response.ok) {
            const json = await response.json();
            streams = extractStreamsFromState(json);
            title = extractTitleFromState(json) || title;
            logger.info(`API fallback extracted ${streams.length} streams for slug ${slug}`);
          }
        } catch (e) {
          logger.error("API fallback error:", e);
        }
      }
    }
    logger.debug("Extracted from " + url + ": streams=" + streams.length + ", title=" + title + ", uploadDate=" + uploadDate);
    return { streams, title, uploadDate };
  }
  function extractVideoSlug(url) {
    try {
      const urlObj = new URL(url, location.origin);
      const vParam = urlObj.searchParams.get("v");
      if (vParam) return vParam;
      const match = url.match(/\/watch\/(\d+)/);
      if (match) return match[1];
      const videoMatch = url.match(/\/video\/(\d+)/);
      if (videoMatch) return videoMatch[1];
    } catch (_) {
    }
    return null;
  }
  function extractFromDom() {
    const results = [];
    const wrapper = document.querySelector(".plyr__video-wrapper");
    if (wrapper) {
      logger.debug("Found plyr__video-wrapper");
      const video = wrapper.querySelector("video");
      if (video) {
        if (video.src && video.src.endsWith(".m3u8")) {
          results.push({ url: video.src, type: "application/x-mpegURL", resolution: "HLS" });
        }
        const sources = video.querySelectorAll("source");
        for (const s of Array.from(sources)) {
          const res = s.getAttribute("size") || s.getAttribute("data-quality") || s.getAttribute("label") || "unknown";
          if (s.src) results.push({ url: s.src, type: s.type, resolution: res });
        }
      }
    } else {
      logger.debug("No plyr__video-wrapper found");
    }
    return results;
  }
  function tryExtract() {
    let fromNuxt = [];
    const state = getNuxtState();
    if (state) {
      fromNuxt = extractStreamsFromState(state);
    }
    if (fromNuxt.length > 0) return fromNuxt;
    const fromDom = extractFromDom();
    if (fromDom.length > 0) return fromDom;
    if (!warnedNoStreams) {
      logger.warn("No streams extracted from __NUXT__ or DOM");
      warnedNoStreams = true;
    }
    return [];
  }
  function ensureButton() {
    if (btnInited) return;
    let btn = document.getElementById("hanime-dl-btn");
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "hanime-dl-btn";
      btn.textContent = "Get Download Links";
      btn.style.position = "fixed";
      btn.style.right = "20px";
      btn.style.bottom = "80px";
      btn.style.zIndex = "999999";
      btn.style.padding = "10px 16px";
      btn.style.background = "#ff4500";
      btn.style.color = "#fff";
      btn.style.borderRadius = "8px";
      btn.style.border = "2px solid #fff";
      btn.style.cursor = "pointer";
      btn.onclick = () => {
        logger.info("Open panel clicked");
        showPanel(currentStreams);
      };
      document.body.appendChild(btn);
      logger.info("Download button added to page");
    }
    btnInited = true;
  }
  function updateButtonLabel() {
    const btn = document.getElementById("hanime-dl-btn");
    if (!btn) return;
    const n = currentStreams.length;
    btn.textContent = n > 0 ? `Get Download Links (${n})` : "Get Download Links (Parse)";
  }
  async function crawlVideos(startUrl) {
    let currentUrl = startUrl;
    const allVideoUrls = /* @__PURE__ */ new Set();
    while (currentUrl) {
      logger.debug("Crawling page: " + currentUrl);
      const dom = await getPageDom(currentUrl);
      const selectors = [
        'a[href*="/watch?v="]',
        // hanime1.me format: /watch?v=123456
        'a[href*="watch?v="]',
        // Full URL format: https://hanime1.me/watch?v=123456
        'a[href^="/watch/"]',
        // Iwara format: /watch/123456
        'a[href*="/video/"]'
        // Alternative format: /video/123456
      ];
      for (const selector of selectors) {
        const links = dom.querySelectorAll(selector);
        for (const a of Array.from(links)) {
          const href = a.href;
          if (href.match(/[?&]v=\d+/) || href.match(/\/watch\/\d+/) || href.match(/\/video\/\d+/)) {
            allVideoUrls.add(new URL(href, location.origin).href);
            logger.debug("Found video link: " + href);
          }
        }
      }
      const nextSelectors = [
        ".pagination .next a",
        ".pagination-next a",
        'a[rel="next"]',
        ".next-page a"
      ];
      let nextLink = null;
      for (const selector of nextSelectors) {
        nextLink = dom.querySelector(selector);
        if (nextLink) break;
      }
      currentUrl = nextLink ? new URL(nextLink.href, location.origin).toString() : "";
      await delay(500);
    }
    logger.info(`Found ${allVideoUrls.size} unique video URLs`);
    const sortedUrls = Array.from(allVideoUrls).sort((a, b) => {
      const idA = extractVideoId(a) || 0;
      const idB = extractVideoId(b) || 0;
      return idA - idB;
    });
    if (sortedUrls.length > 0) {
      logger.info("Video URLs found (oldest first):");
      sortedUrls.forEach((url, index) => {
        logger.info(`${index + 1}. ${url}`);
      });
    } else {
      logger.warn("No video URLs found! Check if the page structure has changed.");
    }
    return sortedUrls;
  }
  function extractVideoId(url) {
    const match = url.match(/\/(\d+)(?:\?|$|\/)/);
    if (match) {
      return parseInt(match[1]);
    }
    const numMatch = url.match(/(\d+)(?:\?|$)/);
    if (numMatch) {
      return parseInt(numMatch[1]);
    }
    return null;
  }
  function extractUploadDateFromPageHtml(html) {
    const match1 = html.match(/觀看次數[^\d]*(\d{4}-\d{2}-\d{2})/);
    if (match1) return match1[1].replace(/-/g, "");
    const match2 = html.match(/Release Date:\s*(\d{4})\/(\d{2})\/(\d{2})/);
    if (match2) return `${match2[1]}${match2[2]}${match2[3]}`;
    const match3 = html.match(/">(\d{4})-(\d{2})-(\d{2})</);
    if (match3) return `${match3[1]}${match3[2]}${match3[3]}`;
    const match4 = html.match(/">(\d{4})\/(\d{2})\/(\d{2})</);
    if (match4) return `${match4[1]}${match4[2]}${match4[3]}`;
    return null;
  }
  function getPreferredStream(streams) {
    if (preferredRes === "highest") {
      return getHighestResStream(streams);
    }
    const target = parseInt(preferredRes);
    return streams.find((s) => parseInt(s.resolution) === target) || getHighestResStream(streams);
  }
  function getHighestResStream(streams) {
    if (streams.length === 0) return void 0;
    return streams.sort((a, b) => (parseInt(b.resolution) || 0) - (parseInt(a.resolution) || 0))[0];
  }
  function sanitizeFilename(name) {
    return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  }
  function extractArtistFromUrl(url) {
    try {
      const urlObj = new URL(url, location.origin);
      const query = urlObj.searchParams.get("query");
      if (query) return query;
      const pathMatch = url.match(/\/search\?query=([^&]+)/);
      if (pathMatch) return decodeURIComponent(pathMatch[1]);
    } catch (_) {
    }
    return "unknown";
  }
  function formatFilename(template, data) {
    let result = template;
    result = result.replace(/%title%/g, data.title);
    result = result.replace(/%artist%/g, data.artist);
    result = result.replace(/%datetime%/g, data.datetime);
    return sanitizeFilename(result);
  }
  function getCurrentDatetime() {
    const now2 = /* @__PURE__ */ new Date();
    const pad = (n) => n.toString().padStart(2, "0");
    return `${now2.getFullYear()}-${pad(now2.getMonth() + 1)}-${pad(now2.getDate())}_${pad(now2.getHours())}-${pad(now2.getMinutes())}-${pad(now2.getSeconds())}`;
  }
  function extractUploadDate() {
    const descPanel = document.querySelector(".video-description-panel");
    if (descPanel) {
      const text = descPanel.textContent || "";
      const match1 = text.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (match1) return `${match1[1]}${match1[2]}${match1[3]}`;
      const match2 = text.match(/Release Date:\s*(\d{4})\/(\d{2})\/(\d{2})/);
      if (match2) return `${match2[1]}${match2[2]}${match2[3]}`;
      const match3 = text.match(/(\d{4})\/(\d{2})\/(\d{2})/);
      if (match3) return `${match3[1]}${match3[2]}${match3[3]}`;
    }
    return getCurrentDatetime().replace(/-/g, "").replace(/_/g, "");
  }
  function extractArtistFromDOM() {
    const el = document.querySelector("#video-artist-name");
    if (el) {
      return el.textContent?.trim() || el.innerText?.trim() || "";
    }
    return "";
  }
  function extractTitleFromDOM() {
    const el = document.querySelector("#shareBtn-title");
    if (el) {
      return el.textContent?.trim() || el.innerText?.trim() || "";
    }
    return "";
  }
  function extractArtistAndTitle() {
    return {
      artist: extractArtistFromDOM() || extractArtistFromUrl(location.href),
      title: extractTitleFromDOM() || document.title.split("|")[0].trim() || "video"
    };
  }
  var bulkProgressPanel = null;
  function showBulkProgressPanel(totalVideos) {
    const panelId = "hanime-bulk-progress-panel";
    let panel = document.getElementById(panelId);
    if (panel) panel.remove();
    panel = document.createElement("div");
    panel.id = panelId;
    panel.style.position = "fixed";
    panel.style.left = "50%";
    panel.style.top = "50%";
    panel.style.transform = "translate(-50%, -50%)";
    panel.style.width = "500px";
    panel.style.background = "#111827";
    panel.style.color = "#e5e7eb";
    panel.style.padding = "20px";
    panel.style.borderRadius = "8px";
    panel.style.boxShadow = "0 4px 16px rgba(0,0,0,.4)";
    panel.style.zIndex = "1000000";
    const title = document.createElement("div");
    title.textContent = "Bulk Download Progress";
    title.style.fontWeight = "bold";
    title.style.marginBottom = "16px";
    title.style.fontSize = "18px";
    panel.appendChild(title);
    const progressContainer = document.createElement("div");
    progressContainer.style.marginBottom = "16px";
    const progressBar = document.createElement("div");
    progressBar.style.width = "100%";
    progressBar.style.height = "20px";
    progressBar.style.background = "#374151";
    progressBar.style.borderRadius = "10px";
    progressBar.style.overflow = "hidden";
    const progressFill = document.createElement("div");
    progressFill.style.height = "100%";
    progressFill.style.background = "#2563eb";
    progressFill.style.width = "0%";
    progressFill.style.transition = "width 0.3s ease";
    progressFill.id = "bulk-progress-fill";
    progressBar.appendChild(progressFill);
    progressContainer.appendChild(progressBar);
    panel.appendChild(progressContainer);
    const statusText = document.createElement("div");
    statusText.id = "bulk-status-text";
    statusText.textContent = `Processing videos... 0/${totalVideos}`;
    statusText.style.marginBottom = "16px";
    panel.appendChild(statusText);
    const currentVideoText = document.createElement("div");
    currentVideoText.id = "bulk-current-video";
    currentVideoText.textContent = "Preparing...";
    currentVideoText.style.fontSize = "14px";
    currentVideoText.style.color = "#9ca3af";
    panel.appendChild(currentVideoText);
    document.body.appendChild(panel);
    bulkProgressPanel = panel;
  }
  function updateBulkProgress(current, total, currentVideo) {
    const progressFill = document.getElementById("bulk-progress-fill");
    const statusText = document.getElementById("bulk-status-text");
    const currentVideoText = document.getElementById("bulk-current-video");
    if (progressFill) {
      const percentage = current / total * 100;
      progressFill.style.width = `${percentage}%`;
    }
    if (statusText) {
      statusText.textContent = `Processing videos... ${current}/${total}`;
    }
    if (currentVideoText && currentVideo) {
      currentVideoText.textContent = `Current: ${currentVideo}`;
    }
    if (current >= total) {
      setTimeout(() => {
        if (bulkProgressPanel) {
          bulkProgressPanel.remove();
          bulkProgressPanel = null;
        }
      }, 2e3);
    }
  }
  function addDownloadButtonsToVideos() {
    const selectors = [
      'a[href*="/watch?v="]',
      // hanime1.me format: /watch?v=123456
      'a[href*="watch?v="]',
      // Full URL format: https://hanime1.me/watch?v=123456
      'a[href^="/watch/"]',
      // Iwara format: /watch/123456
      'a[href*="/video/"]'
      // Alternative format: /video/123456
    ];
    const allVideoLinks = [];
    for (const selector of selectors) {
      const links = document.querySelectorAll(selector);
      for (const a of Array.from(links)) {
        const href = a.href;
        if (href.match(/[?&]v=\d+/) || href.match(/\/watch\/\d+/) || href.match(/\/video\/\d+/)) {
          allVideoLinks.push(a);
        }
      }
    }
    for (const a of allVideoLinks) {
      const card = a.closest(".card") || a.closest(".video-item") || a.parentElement;
      if (!card || card.querySelector(".hanime-dl-video-btn")) continue;
      const btn = document.createElement("button");
      btn.className = "hanime-dl-video-btn";
      btn.textContent = "Download";
      btn.style.display = "block";
      btn.style.margin = "8px auto";
      btn.style.padding = "6px 10px";
      btn.style.background = "#2563eb";
      btn.style.color = "#fff";
      btn.style.border = "none";
      btn.style.borderRadius = "4px";
      btn.style.cursor = "pointer";
      btn.onclick = async () => {
        const url = a.href;
        const { streams, title } = await tryExtractFromUrl(url);
        if (streams.length) {
          const stream = getPreferredStream(streams);
          if (stream) {
            const card2 = a.closest(".card") || a.closest(".video-item") || a.parentElement;
            const cardArtist = card2?.querySelector('#video-artist-name, [id*="artist"]')?.textContent?.trim() || "";
            const cardTitle = card2?.querySelector('#shareBtn-title, [id*="title"]')?.textContent?.trim() || title || "video";
            let cardDate = "";
            if (card2) {
              const cardText = card2.textContent || "";
              const dateMatch = cardText.match(/(\d{4})[/-](\d{2})[/-](\d{2})/);
              if (dateMatch) cardDate = `${dateMatch[1]}${dateMatch[2]}${dateMatch[3]}`;
            }
            const datetime = cardDate || extractUploadDate() || getCurrentDatetime();
            const artist = cardArtist || extractArtistFromUrl(location.href);
            const videoTitle = cardTitle || title || "video";
            const fname = formatFilename(filenameTemplate, { title: videoTitle, artist, datetime });
            logger.info("Downloading " + fname + " from " + stream.url);
            if (stream.url.endsWith(".m3u8")) {
              await downloadM3u8(stream.url, fname);
            } else {
              await downloadBlob(stream.url, `${fname}.mp4`);
            }
          } else {
            logger.warn("No matching stream for preferred res in " + url);
            alert("No stream matching preferred resolution.");
          }
        } else {
          logger.warn("No streams found for " + url);
          alert("No download links found for this video.");
        }
      };
      card.appendChild(btn);
    }
  }
  function ensureBulkButton() {
    if (bulkBtnInited) return;
    if (!location.pathname.startsWith("/maker/") && !location.pathname.startsWith("/search")) return;
    let btn = document.getElementById("hanime-bulk-btn");
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "hanime-bulk-btn";
      btn.textContent = "Bulk Download Videos";
      btn.style.position = "fixed";
      btn.style.right = "20px";
      btn.style.bottom = "140px";
      btn.style.zIndex = "999999";
      btn.style.padding = "10px 16px";
      btn.style.background = "#dc2626";
      btn.style.color = "#fff";
      btn.style.borderRadius = "8px";
      btn.style.border = "2px solid #fff";
      btn.style.cursor = "pointer";
      btn.onclick = async () => {
        logger.info("Bulk download started");
        const videoUrls = await crawlVideos(location.href);
        logger.info(`Found ${videoUrls.length} videos to process`);
        downloadQueue.clear();
        showBulkProgressPanel(videoUrls.length);
        for (let i = 0; i < videoUrls.length; i++) {
          const vurl = videoUrls[i];
          logger.info(`Processing video ${i + 1}/${videoUrls.length}: ${vurl}`);
          updateBulkProgress(i + 1, videoUrls.length, `Opening tab for: ${vurl}`);
          const autoUrl = vurl + (vurl.includes("?") ? "&" : "?") + "auto_dl=1";
          GM_openInTab(autoUrl, { active: false, insert: true, setParent: true });
          logger.info(`Opened tab for auto-download: ${autoUrl}`);
          await delay(1500);
        }
        logger.info(`Opened ${videoUrls.length} tabs for auto-download`);
        updateBulkProgress(videoUrls.length, videoUrls.length, "All tabs opened - downloads will start automatically");
      };
      document.body.appendChild(btn);
      logger.info("Bulk button added to page");
    }
    bulkBtnInited = true;
  }
  function ensureSettingsButton() {
    if (settingsBtnInited) return;
    let btn = document.getElementById("hanime-settings-btn");
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "hanime-settings-btn";
      btn.textContent = "Settings";
      btn.style.position = "fixed";
      btn.style.right = "20px";
      btn.style.bottom = "200px";
      btn.style.zIndex = "999999";
      btn.style.padding = "8px 12px";
      btn.style.background = "#4caf50";
      btn.style.color = "#fff";
      btn.style.borderRadius = "8px";
      btn.style.border = "2px solid #fff";
      btn.style.cursor = "pointer";
      btn.onclick = showSettingsPanel;
      document.body.appendChild(btn);
      logger.info("Settings button added to page");
    }
    settingsBtnInited = true;
  }
  function showSettingsPanel() {
    const panelId = "hanime-settings-panel";
    let panel = document.getElementById(panelId);
    if (panel) panel.remove();
    panel = document.createElement("div");
    panel.id = panelId;
    panel.style.position = "fixed";
    panel.style.right = "20px";
    panel.style.bottom = "250px";
    panel.style.width = "300px";
    panel.style.background = "#111827";
    panel.style.color = "#e5e7eb";
    panel.style.padding = "12px";
    panel.style.borderRadius = "8px";
    panel.style.boxShadow = "0 4px 16px rgba(0,0,0,.4)";
    const title = document.createElement("div");
    title.textContent = "Download Settings";
    title.style.fontWeight = "bold";
    title.style.marginBottom = "8px";
    panel.appendChild(title);
    const resLabel = document.createElement("label");
    resLabel.textContent = "Preferred Resolution:";
    resLabel.style.display = "block";
    resLabel.style.marginBottom = "4px";
    panel.appendChild(resLabel);
    const resSelect = document.createElement("select");
    resSelect.style.width = "100%";
    resSelect.style.marginBottom = "8px";
    const options = ["highest", "1080", "720", "480", "360"];
    for (const opt of options) {
      const option = document.createElement("option");
      option.value = opt;
      option.textContent = opt === "highest" ? "Highest Available" : `${opt}p`;
      if (opt === preferredRes) option.selected = true;
      resSelect.appendChild(option);
    }
    panel.appendChild(resSelect);
    const templateLabel = document.createElement("label");
    templateLabel.textContent = "Filename Template:";
    templateLabel.style.display = "block";
    templateLabel.style.marginBottom = "4px";
    templateLabel.style.marginTop = "8px";
    panel.appendChild(templateLabel);
    const templateInput = document.createElement("input");
    templateInput.type = "text";
    templateInput.value = filenameTemplate;
    templateInput.placeholder = "%title%";
    templateInput.style.width = "100%";
    templateInput.style.marginBottom = "4px";
    templateInput.style.padding = "4px";
    templateInput.style.background = "#374151";
    templateInput.style.color = "#fff";
    templateInput.style.border = "1px solid #6b7280";
    templateInput.style.borderRadius = "4px";
    panel.appendChild(templateInput);
    const templateHint = document.createElement("div");
    templateHint.style.fontSize = "11px";
    templateHint.style.color = "#9ca3af";
    templateHint.style.marginBottom = "8px";
    templateHint.textContent = "Variables: %title%, %artist%, %datetime%";
    panel.appendChild(templateHint);
    const saveBtn = document.createElement("button");
    saveBtn.textContent = "Save";
    saveBtn.style.padding = "6px 10px";
    saveBtn.style.background = "#2563eb";
    saveBtn.style.color = "#fff";
    saveBtn.style.border = "none";
    saveBtn.style.borderRadius = "4px";
    saveBtn.style.cursor = "pointer";
    saveBtn.onclick = () => {
      preferredRes = resSelect.value;
      GM_setValue("hanime_preferred_res", preferredRes);
      filenameTemplate = templateInput.value || "%title%";
      GM_setValue("hanime_filename_template", filenameTemplate);
      logger.info("Saved settings - resolution:", preferredRes, ", template:", filenameTemplate);
      panel?.remove();
    };
    panel.appendChild(saveBtn);
    const close = document.createElement("button");
    close.textContent = "Close";
    close.style.marginLeft = "8px";
    close.style.padding = "6px 10px";
    close.style.background = "#6b7280";
    close.style.color = "#fff";
    close.style.border = "none";
    close.style.borderRadius = "4px";
    close.style.cursor = "pointer";
    close.onclick = () => panel?.remove();
    panel.appendChild(close);
    document.body.appendChild(panel);
  }
  function debounce(fn, ms) {
    let timeout;
    return () => {
      clearTimeout(timeout);
      timeout = setTimeout(fn, ms);
    };
  }
  function setupObservers() {
    const debouncedCallback = debounce(() => {
      try {
        logger.debug("DOM mutated, try extract again");
        const s = tryExtract();
        if (s.length) attachUI(s);
        else if (!warnedNoStreams) updateButtonLabel();
        if (location.pathname.startsWith("/maker/") || location.pathname.startsWith("/search")) {
          addDownloadButtonsToVideos();
        }
      } catch (e) {
        logger.error("Mutation callback error:", e);
      }
    }, 300);
    const mo = new MutationObserver(debouncedCallback);
    mo.observe(document.body, { childList: true, subtree: true });
    if (location.pathname.startsWith("/watch/")) {
      setTimeout(() => mo.disconnect(), 5e3);
    }
    const wrap = (target, name) => {
      const orig = target[name];
      target[name] = function(...args) {
        const r = orig.apply(this, args);
        logger.info("History changed:", name);
        setTimeout(() => {
          const s = tryExtract();
          if (s.length) attachUI(s);
          else updateButtonLabel();
          ensureBulkButton();
          if (location.pathname.startsWith("/maker/") || location.pathname.startsWith("/search")) {
            addDownloadButtonsToVideos();
          }
        }, 100);
        return r;
      };
    };
    try {
      wrap(history, "pushState");
      wrap(history, "replaceState");
    } catch (_) {
    }
    const origFetch = window.fetch;
    window.fetch = async (...args) => {
      const res = await origFetch(...args);
      try {
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("application/json")) {
          const clone = res.clone();
          const json = await clone.json().catch(() => void 0);
          if (json) {
            const extra = extractStreamsFromState(json);
            if (extra.length) {
              logger.info("Captured streams via fetch:", extra.length);
              const urls = new Set(currentStreams.map((x) => x.url));
              for (const it of extra) if (!urls.has(it.url)) currentStreams.push(it);
              updateButtonLabel();
            }
          }
        } else {
          const url = (res.url || "").toString();
          if (url.includes(".m3u8")) {
            logger.info("Captured m3u8 via fetch:", url);
            if (!currentStreams.some((x) => x.url === url)) currentStreams.push({ url, type: "m3u8" });
            updateButtonLabel();
          }
        }
      } catch (_) {
      }
      return res;
    };
  }
  async function autoDownloadIfNeeded() {
    const urlParams = new URLSearchParams(location.search);
    if (urlParams.has("auto_dl")) {
      logger.info("Auto-download mode detected");
      await delay(3e3);
      const playBtn = document.querySelector(".plyr__control--overlaid, .plyr__control--play");
      if (playBtn) {
        playBtn.click();
        logger.info("Simulated play click to load streams");
        await delay(2e3);
      }
      let streams = tryExtract();
      let title = document.title || "unknown";
      if (streams.length === 0) {
        logger.info("No streams found in DOM, trying API fallback");
        const slug = urlParams.get("v");
        if (slug) {
          try {
            const apiUrl = `/api/v8/video?id=${slug}`;
            const response = await fetch(apiUrl);
            if (response.ok) {
              const json = await response.json();
              streams = extractStreamsFromState(json);
              title = extractTitleFromState(json) || title;
              logger.info(`API fallback found ${streams.length} streams`);
            }
          } catch (error) {
            logger.error("API fallback failed:", error);
          }
        }
      }
      if (streams.length > 0) {
        const stream = getPreferredStream(streams);
        if (stream) {
          const { artist, title: videoTitle } = extractArtistAndTitle();
          const datetime = extractUploadDate() || getCurrentDatetime();
          const fname = formatFilename(filenameTemplate, { title: videoTitle, artist, datetime });
          logger.info(`Starting download: ${fname} (${stream.resolution}) from ${stream.url}`);
          try {
            if (stream.url.endsWith(".m3u8")) {
              await downloadM3u8(stream.url, fname);
            } else {
              await downloadBlob(stream.url, `${fname}.mp4`);
            }
            logger.info(`Download started for: ${fname}`);
            setTimeout(() => {
              logger.info("Closing auto-download tab");
              window.close();
            }, 5e3);
          } catch (error) {
            logger.error(`Download failed for ${fname}:`, error);
            setTimeout(() => window.close(), 2e3);
          }
        } else {
          logger.warn("No matching stream for preferred resolution, closing tab");
          setTimeout(() => window.close(), 2e3);
        }
      } else {
        logger.warn("No streams found, closing tab");
        setTimeout(() => window.close(), 2e3);
      }
    }
  }
  function mount() {
    logger.group("Mount Hanime Download Tool");
    ensureButton();
    ensureBulkButton();
    ensureSettingsButton();
    const streams = tryExtract();
    if (streams.length) attachUI(streams);
    else {
      logger.warn("No UI attached due to empty streams");
      updateButtonLabel();
    }
    if (location.pathname.startsWith("/maker/") || location.pathname.startsWith("/search")) {
      addDownloadButtonsToVideos();
    }
    autoDownloadIfNeeded();
    setupObservers();
    logger.groupEnd();
    logger.info("Script fully mounted - check for button in bottom-right. If not visible, scroll or zoom out.");
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
