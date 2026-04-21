import { isNullOrUndefined, isObject, delay } from './env'
import { logger } from './logger'
import { downloadM3u8 } from './downloader'

// @ts-expect-error Tampermonkey global
declare const GM_download: (url: string, name: string) => void;
// @ts-expect-error Tampermonkey global
declare const GM_setValue: (key: string, value: any) => void;
// @ts-expect-error Tampermonkey global
declare const GM_getValue: (key: string, defaultValue?: any) => any;
// @ts-expect-error Tampermonkey global
declare const GM_openInTab: (url: string, options?: { active?: boolean, insert?: boolean, setParent?: boolean }) => void;

async function downloadBlob(url: string, filename: string): Promise<void> {
    try {
        logger.info(`Downloading blob: ${filename} from ${url}`)
        const response = await fetch(url)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const blob = await response.blob()
        const blobUrl = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = blobUrl
        a.download = filename
        a.click()
        URL.revokeObjectURL(blobUrl)
        logger.info(`Blob download completed: ${filename}`)
    } catch (err) {
        logger.error(`Blob download failed: ${err}`)
        throw err
    }
}

// Download types enum
enum DownloadType {
    Browser = 'browser',
    Aria2 = 'aria2',
    IwaraDownloader = 'iwaraDownloader',
    Others = 'others'
}

// Download queue management
class DownloadQueue {
    private queue: Array<{id: string, url: string, title: string, artist: string, streams: Stream[]}> = []
    private processing = false
    private currentIndex = 0
    private totalCount = 0
    private progressCallback?: (current: number, total: number, title: string) => void

    add(item: {id: string, url: string, title: string, artist: string, streams: Stream[]}) {
        this.queue.push(item)
        this.totalCount = this.queue.length
    }

    async process(downloadType: DownloadType = DownloadType.Browser) {
        if (this.processing) return
        this.processing = true
        this.currentIndex = 0

        logger.info(`Starting download queue processing: ${this.totalCount} items`)

        for (const item of this.queue) {
            this.currentIndex++
            logger.info(`Processing ${this.currentIndex}/${this.totalCount}: ${item.title}`)
            
            if (this.progressCallback) {
                this.progressCallback(this.currentIndex, this.totalCount, item.title)
            }

            try {
                await this.downloadItem(item, downloadType)
                await delay(2000)
            } catch (error) {
                logger.error(`Failed to download ${item.title}:`, error)
            }
        }

        this.processing = false
        logger.info('Download queue completed')
    }

    private async downloadItem(item: {id: string, url: string, title: string, artist: string, streams: Stream[]}, downloadType: DownloadType) {
        const stream = getPreferredStream(item.streams)
        if (!stream) {
            logger.warn(`No suitable stream found for ${item.title}`)
            return
        }

        const datetime = item.uploadDate || getCurrentDatetime()
        const filename = formatFilename(filenameTemplate, { title: item.title, artist: item.artist, datetime })
        
        switch (downloadType) {
            case DownloadType.Browser:
                await this.browserDownload(stream, filename)
                break
            case DownloadType.Aria2:
                await this.aria2Download(stream, filename)
                break
            default:
                await this.browserDownload(stream, filename)
                break
        }
    }

    private async browserDownload(stream: Stream, filename: string) {
        if (stream.url.endsWith('.m3u8')) {
            await downloadM3u8(stream.url, filename)
        } else {
            await downloadBlob(stream.url, `${filename}.mp4`)
        }
    }

    private async aria2Download(stream: Stream, filename: string) {
        logger.info(`Aria2 download: ${filename} from ${stream.url}`)
    }

    setProgressCallback(callback: (current: number, total: number, title: string) => void) {
        this.progressCallback = callback
    }

    clear() {
        this.queue = []
        this.totalCount = 0
        this.currentIndex = 0
    }

    get length() {
        return this.queue.length
    }
}

// Global download queue
const downloadQueue = new DownloadQueue()

type Stream = {
    url: string
    type?: string
    resolution?: string | number
}

type VideoInfo = {
    title: string
    artist?: string
    uploadDate?: string
    url: string
    streams: Stream[]
}

type LooseObject = Record<string, unknown>;

let currentStreams: Stream[] = []
let btnInited = false
let bulkBtnInited = false
let settingsBtnInited = false
let preferredRes: string = GM_getValue('hanime_preferred_res', 'highest')
let filenameTemplate: string = GM_getValue('hanime_filename_template', '%title%')
let warnedNoStreams = false

function getNuxtState(dom: Document = document): LooseObject | undefined {
    const w = window as any
    if (w.__NUXT__) {
        logger.debug('Found __NUXT__ on window')
        return w.__NUXT__ as LooseObject
    }
    // fallback: tìm script JSON có chứa streams or videos_manifest
    const scripts = Array.from(dom.querySelectorAll('script[type="application/json"]'))
    for (const s of scripts) {
        try {
            const raw = s.textContent || 'null'
            logger.debug('Scanning JSON script, length=', raw.length)
            if (raw.includes('streams') || raw.includes('videos_manifest')) {
                const data = JSON.parse(raw)
                return data as LooseObject
            }
        } catch (_) {}
    }
    return undefined
}

function extractStreamsFromState(state: unknown): Stream[] {
    const results: Stream[] = []
    if (!isObject(state)) return results

    const findStreams = (obj: unknown, depth = 0): void => {
        if (depth > 10) return; // Prevent deep recursion stack overflow
        if (isObject(obj)) {
            const loose = obj as LooseObject
            if (Array.isArray(loose.streams)) {
                for (const it of loose.streams as unknown[]) {
                    if (isObject(it) && (it as LooseObject).url) {
                        results.push({
                            url: (it as LooseObject).url as string,
                            type: (it as LooseObject).format as string || (it as LooseObject).mime as string,
                            resolution: (it as LooseObject).height as string || (it as LooseObject).quality as string
                        })
                    }
                }
            }
            // Handle stringified videos_manifest
            if (typeof loose.videos_manifest === 'string') {
                try {
                    const manifest = JSON.parse(loose.videos_manifest as string)
                    findStreams(manifest, depth + 1)
                } catch (e) {
                    logger.debug('Failed to parse videos_manifest string: ' + e)
                }
            }
            // Additional check for nested structures like videos_manifest.servers[0].streams
            if (isObject(loose.videos_manifest) && Array.isArray((loose.videos_manifest as LooseObject).servers)) {
                for (const server of (loose.videos_manifest as LooseObject).servers as unknown[]) {
                    if (isObject(server)) {
                        const serverLoose = server as LooseObject
                        if (Array.isArray(serverLoose.streams)) {
                            for (const it of serverLoose.streams as unknown[]) {
                                if (isObject(it) && (it as LooseObject).url) {
                                    results.push({
                                        url: (it as LooseObject).url as string,
                                        type: (it as LooseObject).format as string || (it as LooseObject).mime as string,
                                        resolution: (it as LooseObject).height as string || (it as LooseObject).quality as string
                                    })
                                }
                            }
                        }
                    }
                }
            }
            for (const k of Object.keys(loose)) findStreams(loose[k], depth + 1)
        } else if (Array.isArray(obj)) {
            for (const it of obj) findStreams(it, depth + 1)
        }
    }
    findStreams(state)
    logger.info('Extracted streams count:', results.length)
    return uniqueByUrl(results)
}

function extractTitleFromState(state: unknown): string {
    let title = 'unknown'
    const findTitle = (obj: unknown, depth = 0): void => {
        if (depth > 10) return;
        if (isObject(obj)) {
            const loose = obj as LooseObject
            if (typeof loose.name === 'string') {
                title = loose.name
            } else if (isObject(loose.video) && typeof (loose.video as LooseObject).name === 'string') {
                title = (loose.video as LooseObject).name
            }
            for (const k of Object.keys(loose)) findTitle(loose[k], depth + 1)
        } else if (Array.isArray(obj)) {
            for (const it of obj) findTitle(it, depth + 1)
        }
    }
    findTitle(state)
    return title
}

function uniqueByUrl(list: Stream[]): Stream[] {
    const s = new Set<string>()
    const out: Stream[] = []
    for (const it of list) {
        if (!s.has(it.url)) { s.add(it.url); out.push(it) }
    }
    return out
}

function attachUI(streams: Stream[]) {
    logger.debug('Attach UI with streams:', streams.length)
    currentStreams = streams
    ensureButton()
    updateButtonLabel()
}

function showPanel(streams: Stream[]) {
    const panelId = 'hanime-dl-panel'
    let panel = document.getElementById(panelId)
    if (panel) panel.remove()
    panel = document.createElement('div')
    panel.id = panelId
    panel.style.position = 'fixed'
    panel.style.right = '16px'
    panel.style.bottom = '60px'
    panel.style.width = '420px'
    panel.style.maxHeight = '50vh'
    panel.style.overflow = 'auto'
    panel.style.background = '#111827'
    panel.style.color = '#e5e7eb'
    panel.style.padding = '12px'
    panel.style.borderRadius = '8px'
    panel.style.boxShadow = '0 4px 16px rgba(0,0,0,.4)'

    const title = document.createElement('div')
    title.textContent = 'Download Streams'
    title.style.fontWeight = 'bold'
    title.style.marginBottom = '8px'
    panel.appendChild(title)

    const list = document.createElement('div')
    for (const s of streams) {
        const item = document.createElement('div')
        item.style.display = 'flex'
        item.style.alignItems = 'center'
        item.style.gap = '8px'
        item.style.margin = '6px 0'
        const a = document.createElement('a')
        a.href = s.url
        a.textContent = `${s.resolution ?? ''} ${s.type ?? ''}`.trim() || 'download'
        a.style.color = '#93c5fd'
        a.target = '_blank'
        const copy = document.createElement('button')
        copy.textContent = 'Copy'
        copy.style.padding = '4px 8px'
        copy.style.background = '#374151'
        copy.style.color = '#fff'
        copy.style.border = 'none'
        copy.style.borderRadius = '4px'
        copy.style.cursor = 'pointer'
        copy.onclick = () => { logger.info('Copy link', s.url); navigator.clipboard.writeText(s.url) }
        const dl = document.createElement('button')
        dl.textContent = 'Download'
        dl.style.padding = '4px 8px'
        dl.style.background = '#2563eb'
        dl.style.color = '#fff'
        dl.style.border = 'none'
        dl.style.borderRadius = '4px'
        dl.style.cursor = 'pointer'
        dl.onclick = () => {
            const datetime = extractUploadDate() || getCurrentDatetime()
            const { artist, title } = extractArtistAndTitle()
            const fname = formatFilename(filenameTemplate, { title, artist, datetime })
            if (s.url.endsWith('.m3u8')) {
                downloadM3u8(s.url, fname)
            } else {
                downloadBlob(s.url, `${fname}.mp4`)
            }
        }
        item.appendChild(a)
        item.appendChild(copy)
        item.appendChild(dl)
        list.appendChild(item)
    }
    panel.appendChild(list)

    const close = document.createElement('button')
    close.textContent = 'Close'
    close.style.marginTop = '8px'
    close.style.background = '#6b7280'
    close.style.color = '#fff'
    close.style.border = 'none'
    close.style.borderRadius = '4px'
    close.style.padding = '6px 10px'
    close.onclick = () => { logger.info('Close panel'); panel?.remove() }
    panel.appendChild(close)

    document.body.appendChild(panel)
}

async function getPageDom(url: string): Promise<Document> {
    const text = await fetch(url).then(res => res.text())
    return new DOMParser().parseFromString(text, 'text/html')
}

async function tryExtractFromUrl(url: string): Promise<{streams: Stream[], title: string, uploadDate?: string}> {
    const text = await fetch(url).then(res => res.text())
    const dom = new DOMParser().parseFromString(text, 'text/html')
    let state = getNuxtState(dom)
    let streams = state ? extractStreamsFromState(state) : []
    let title = state ? extractTitleFromState(state) : 'unknown'
    const uploadDate = extractUploadDateFromPageHtml(text)

    // Nếu không tìm thấy streams, thử API fallback
    if (streams.length === 0) {
        logger.debug('No streams from DOM, trying API fallback')
        const slug = extractVideoSlug(url)
        if (slug) {
            try {
                const apiUrl = `/api/v8/video?id=${slug}`
                const response = await fetch(apiUrl)
                if (response.ok) {
                    const json = await response.json()
                    streams = extractStreamsFromState(json)
                    title = extractTitleFromState(json) || title
                    logger.info(`API fallback extracted ${streams.length} streams for slug ${slug}`)
                }
            } catch (e) {
                logger.error('API fallback error:', e)
            }
        }
    }

    logger.debug('Extracted from ' + url + ': streams=' + streams.length + ', title=' + title + ', uploadDate=' + uploadDate)
    return {streams, title, uploadDate}
}

function extractVideoSlug(url: string): string | null {
    // Trích xuất slug từ URL video
    // Patterns: /watch?v=123456, /watch/123456, /video/123456
    try {
        const urlObj = new URL(url, location.origin)
        const vParam = urlObj.searchParams.get('v')
        if (vParam) return vParam
        const match = url.match(/\/watch\/(\d+)/)
        if (match) return match[1]
        const videoMatch = url.match(/\/video\/(\d+)/)
        if (videoMatch) return videoMatch[1]
    } catch (_) {}
    return null
}

function extractFromDom(): Stream[] {
    const results: Stream[] = []
    const wrapper = document.querySelector('.plyr__video-wrapper')
    if (wrapper) {
        logger.debug('Found plyr__video-wrapper')
        const video = wrapper.querySelector('video')
        if (video) {
            if (video.src && video.src.endsWith('.m3u8')) {
                results.push({ url: video.src, type: 'application/x-mpegURL', resolution: 'HLS' })
            }
            const sources = video.querySelectorAll('source') as NodeListOf<HTMLSourceElement>
            for (const s of Array.from(sources)) {
                const res = s.getAttribute('size') || s.getAttribute('data-quality') || s.getAttribute('label') || 'unknown'
                if (s.src) results.push({ url: s.src, type: s.type, resolution: res })
            }
        }
    } else {
        logger.debug('No plyr__video-wrapper found')
    }
    return results
}

function tryExtract(): Stream[] {
    let fromNuxt: Stream[] = []
    const state = getNuxtState()
    if (state) {
        fromNuxt = extractStreamsFromState(state)
    }
    if (fromNuxt.length > 0) return fromNuxt
    const fromDom = extractFromDom()
    if (fromDom.length > 0) return fromDom
    if (!warnedNoStreams) {
        logger.warn('No streams extracted from __NUXT__ or DOM')
        warnedNoStreams = true // Limit to one warn per load
    }
    return []
}

function ensureButton() {
    if (btnInited) return
    let btn = document.getElementById('hanime-dl-btn') as HTMLButtonElement | null
    if (!btn) {
        btn = document.createElement('button')
        btn.id = 'hanime-dl-btn'
        btn.textContent = 'Get Download Links'
        btn.style.position = 'fixed'
        btn.style.right = '20px' // Adjusted for better visibility
        btn.style.bottom = '80px' // Raised higher to avoid overlap with site elements
        btn.style.zIndex = '999999'
        btn.style.padding = '10px 16px' // Larger for visibility
        btn.style.background = '#ff4500' // Brighter color to stand out on dark site
        btn.style.color = '#fff'
        btn.style.borderRadius = '8px'
        btn.style.border = '2px solid #fff' // Border for contrast
        btn.style.cursor = 'pointer'
        btn.onclick = () => { logger.info('Open panel clicked'); showPanel(currentStreams) }
        document.body.appendChild(btn)
        logger.info('Download button added to page')
    }
    btnInited = true
}

function updateButtonLabel() {
    const btn = document.getElementById('hanime-dl-btn') as HTMLButtonElement | null
    if (!btn) return
    const n = currentStreams.length
    btn.textContent = n > 0 ? `Get Download Links (${n})` : 'Get Download Links (Parse)'
}

async function crawlVideos(startUrl: string): Promise<string[]> {
    let currentUrl = startUrl
    const allVideoUrls: Set<string> = new Set()
    while (currentUrl) {
        logger.debug('Crawling page: ' + currentUrl)
        const dom = await getPageDom(currentUrl)
        
        // Tìm tất cả các link video với nhiều pattern khác nhau
        const selectors = [
            'a[href*="/watch?v="]',  // hanime1.me format: /watch?v=123456
            'a[href*="watch?v="]',   // Full URL format: https://hanime1.me/watch?v=123456
            'a[href^="/watch/"]',    // Iwara format: /watch/123456
            'a[href*="/video/"]'     // Alternative format: /video/123456
        ]
        
        for (const selector of selectors) {
            const links = dom.querySelectorAll(selector) as NodeListOf<HTMLAnchorElement>
            for (const a of Array.from(links)) {
                const href = a.href
                // Chỉ lấy các link có chứa video ID (số)
                if (href.match(/[?&]v=\d+/) || href.match(/\/watch\/\d+/) || href.match(/\/video\/\d+/)) {
                    allVideoUrls.add(new URL(href, location.origin).href)
                    logger.debug('Found video link: ' + href)
                }
            }
        }
        
        // Tìm link trang tiếp theo
        const nextSelectors = [
            '.pagination .next a',
            '.pagination-next a', 
            'a[rel="next"]',
            '.next-page a'
        ]
        
        let nextLink: HTMLAnchorElement | null = null
        for (const selector of nextSelectors) {
            nextLink = dom.querySelector(selector) as HTMLAnchorElement | null
            if (nextLink) break
        }
        
        currentUrl = nextLink ? new URL(nextLink.href, location.origin).toString() : ''
        await delay(500) // Reduced throttle for faster crawl without overload
    }
    
    logger.info(`Found ${allVideoUrls.size} unique video URLs`)
    
    // Sắp xếp URL theo thứ tự cũ nhất → mới nhất (theo video ID)
    // Video ID thường nằm ở cuối URL, ta extract và sort
    const sortedUrls = Array.from(allVideoUrls).sort((a, b) => {
        const idA = extractVideoId(a) || 0
        const idB = extractVideoId(b) || 0
        return idA - idB // Ascending = cổ nhất trước
    })

    // Debug: Log tất cả URLs tìm thấy
    if (sortedUrls.length > 0) {
        logger.info('Video URLs found (oldest first):')
        sortedUrls.forEach((url, index) => {
            logger.info(`${index + 1}. ${url}`)
        })
    } else {
        logger.warn('No video URLs found! Check if the page structure has changed.')
    }
    
    return sortedUrls
}

function extractVideoId(url: string): number | null {
    // Trích xuất video ID từ URL - thường là số cuối cùng trong path
    // Patterns: /watch?v=123456, /watch/123456, /video/123456
    const match = url.match(/\/(\d+)(?:\?|$|\/)/)
    if (match) {
        return parseInt(match[1])
    }
    // Fallback: lấy số cuối cùng trong URL
    const numMatch = url.match(/(\d+)(?:\?|$)/)
    if (numMatch) {
        return parseInt(numMatch[1])
    }
    return null
}

function extractUploadDateFromPageHtml(html: string): string | null {
    // Trích xuất date từ HTML đã fetch sẵn - không cần parse DOM
    // Format 1: 2024-03-31 (từ phần view count như "觀看次數：26萬次  2024-03-31")
    const match1 = html.match(/觀看次數[^\d]*(\d{4}-\d{2}-\d{2})/)
    if (match1) return match1[1].replace(/-/g, '')
    // Format 2: Release Date: 2024/03/31
    const match2 = html.match(/Release Date:\s*(\d{4})\/(\d{2})\/(\d{2})/)
    if (match2) return `${match2[1]}${match2[2]}${match2[3]}`
    // Format 3: ">2024-03-31<" trực tiếp
    const match3 = html.match(/">(\d{4})-(\d{2})-(\d{2})</)
    if (match3) return `${match3[1]}${match3[2]}${match3[3]}`
    // Format 4: ">2024/03/31<" 
    const match4 = html.match(/">(\d{4})\/(\d{2})\/(\d{2})</)
    if (match4) return `${match4[1]}${match4[2]}${match4[3]}`
    return null
}

async function bulkExtractStreams(videoUrls: string[]): Promise<VideoInfo[]> {
    const allVideos: VideoInfo[] = []
    for (const vurl of videoUrls) {
        logger.debug('Extracting from ' + vurl)
        const {streams, title, uploadDate} = await tryExtractFromUrl(vurl)
        if (streams.length) {
            const artist = extractArtistFromDOM() || extractArtistFromUrl(location.href)
            allVideos.push({title, artist, uploadDate, url: vurl, streams})
        }
        await delay(500)
    }
    // Sắp xếp theo upload date (cũ nhất trước)
    allVideos.sort((a, b) => {
        const dateA = a.uploadDate || ''
        const dateB = b.uploadDate || ''
        return dateA.localeCompare(dateB)
    })
    return allVideos
}

function showBulkPanel(videos: VideoInfo[]) {
    const panelId = 'hanime-bulk-panel'
    let panel = document.getElementById(panelId)
    if (panel) panel.remove()
    panel = document.createElement('div')
    panel.id = panelId
    panel.style.position = 'fixed'
    panel.style.left = '50%'
    panel.style.top = '50%'
    panel.style.transform = 'translate(-50%, -50%)'
    panel.style.width = '600px'
    panel.style.maxHeight = '80vh'
    panel.style.overflow = 'auto'
    panel.style.background = '#111827'
    panel.style.color = '#e5e7eb'
    panel.style.padding = '16px'
    panel.style.borderRadius = '8px'
    panel.style.boxShadow = '0 4px 16px rgba(0,0,0,.4)'

    const titleEl = document.createElement('div')
    titleEl.textContent = `Bulk Downloads (${videos.length} videos)`
    titleEl.style.fontWeight = 'bold'
    titleEl.style.marginBottom = '12px'
    panel.appendChild(titleEl)

    const downloadAllBtn = document.createElement('button')
    downloadAllBtn.textContent = 'Download All (Sequential Tabs)'
    downloadAllBtn.style.marginBottom = '12px'
    downloadAllBtn.style.padding = '6px 10px'
    downloadAllBtn.style.background = '#2563eb'
    downloadAllBtn.style.color = '#fff'
    downloadAllBtn.style.border = 'none'
    downloadAllBtn.style.borderRadius = '4px'
    downloadAllBtn.style.cursor = 'pointer'
    downloadAllBtn.onclick = async () => {
        logger.info(`Starting bulk download of ${videos.length} videos`)
        
        // Show progress panel
        showBulkProgressPanel(videos.length)
        
        // Process videos by opening tabs and auto-downloading
        for (let i = 0; i < videos.length; i++) {
            const video = videos[i]
            logger.info(`Processing video ${i + 1}/${videos.length}: ${video.title}`)
            
            // Update progress
            updateBulkProgress(i + 1, videos.length, `Opening tab for: ${video.title}`)
            
            // Mở tab với auto-download parameter
            const autoUrl = video.url + (video.url.includes('?') ? '&' : '?') + 'auto_dl=1'
            GM_openInTab(autoUrl, { active: false, insert: true, setParent: true })
            logger.info(`Opened tab for auto-download: ${autoUrl}`)
            
            // Delay giữa các tab để tránh quá tải
            await delay(3000) // 3 giây delay giữa các tab
        }
        
        logger.info(`Opened ${videos.length} tabs for auto-download`)
        updateBulkProgress(videos.length, videos.length, 'All tabs opened - downloads will start automatically')
        
        // Đóng panel sau 2 giây
        setTimeout(() => {
            panel?.remove()
        }, 2000)
    }
    panel.appendChild(downloadAllBtn)

    const list = document.createElement('div')
    for (const video of videos) {
        const videoItem = document.createElement('div')
        videoItem.style.margin = '8px 0'
        videoItem.style.padding = '8px'
        videoItem.style.background = '#1f2937'
        videoItem.style.borderRadius = '4px'

        const videoTitle = document.createElement('div')
        videoTitle.textContent = video.title || video.url
        videoTitle.style.fontWeight = 'bold'
        videoItem.appendChild(videoTitle)

        const streamList = document.createElement('div')
        for (const s of video.streams) {
            const item = document.createElement('div')
            item.style.display = 'flex'
            item.style.alignItems = 'center'
            item.style.gap = '8px'
            item.style.margin = '4px 0'
            const a = document.createElement('a')
            a.href = s.url
            a.textContent = `${s.resolution ?? ''} ${s.type ?? ''}`.trim() || 'download'
            a.style.color = '#93c5fd'
            a.target = '_blank'
            const copy = document.createElement('button')
            copy.textContent = 'Copy'
            copy.onclick = () => navigator.clipboard.writeText(s.url)
            const dl = document.createElement('button')
            dl.textContent = 'Download'
            dl.onclick = () => {
                const datetime = video.uploadDate || getCurrentDatetime()
                const artist = extractArtistFromDOM() || extractArtistFromUrl(video.url)
                const title = video.title || 'video'
                const fname = formatFilename(filenameTemplate, { title, artist, datetime })
                if (s.url.endsWith('.m3u8')) {
                    downloadM3u8(s.url, fname)
                } else {
                    downloadBlob(s.url, `${fname}.mp4`)
                }
            }
            item.appendChild(a)
            item.appendChild(copy)
            item.appendChild(dl)
            streamList.appendChild(item)
        }
        videoItem.appendChild(streamList)
        list.appendChild(videoItem)
    }
    panel.appendChild(list)

    const close = document.createElement('button')
    close.textContent = 'Close'
    close.style.marginTop = '12px'
    close.style.background = '#6b7280'
    close.style.color = '#fff'
    close.style.border = 'none'
    close.style.borderRadius = '4px'
    close.style.padding = '6px 10px'
    close.onclick = () => panel?.remove()
    panel.appendChild(close)

    document.body.appendChild(panel)
}

function getPreferredStream(streams: Stream[]): Stream | undefined {
    if (preferredRes === 'highest') {
        return getHighestResStream(streams)
    }
    const target = parseInt(preferredRes)
    return streams.find(s => parseInt(s.resolution as string) === target) || getHighestResStream(streams)
}

function getHighestResStream(streams: Stream[]): Stream | undefined {
    if (streams.length === 0) return undefined
    return streams.sort((a, b) => (parseInt(b.resolution as string) || 0) - (parseInt(a.resolution as string) || 0))[0]
}

function sanitizeFilename(name: string): string {
    // Chỉ remove các ký tự invalid cho filename, giữ lại chữ CJK và Unicode
    return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim()
}

function extractArtistFromUrl(url: string): string {
    try {
        const urlObj = new URL(url, location.origin)
        const query = urlObj.searchParams.get('query')
        if (query) return query
        const pathMatch = url.match(/\/search\?query=([^&]+)/)
        if (pathMatch) return decodeURIComponent(pathMatch[1])
    } catch (_) {}
    return 'unknown'
}

function formatFilename(template: string, data: { title: string, artist: string, datetime: string }): string {
    let result = template
    result = result.replace(/%title%/g, data.title)
    result = result.replace(/%artist%/g, data.artist)
    result = result.replace(/%datetime%/g, data.datetime)
    return sanitizeFilename(result)
}

function getCurrentDatetime(): string {
    const now = new Date()
    const pad = (n: number) => n.toString().padStart(2, '0')
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
}

function extractUploadDate(): string {
    // Tìm date từ format "觀看次數：26萬次  2024-03-31" hoặc "Release Date: 2024/03/31"
    const descPanel = document.querySelector('.video-description-panel')
    if (descPanel) {
        const text = descPanel.textContent || ''
        // Format 1: 2024-03-31 (từ phần view count)
        const match1 = text.match(/(\d{4})-(\d{2})-(\d{2})/)
        if (match1) return `${match1[1]}${match1[2]}${match1[3]}`
        // Format 2: Release Date: 2024/03/31
        const match2 = text.match(/Release Date:\s*(\d{4})\/(\d{2})\/(\d{2})/)
        if (match2) return `${match2[1]}${match2[2]}${match2[3]}`
        // Format 3: 2024/03/31
        const match3 = text.match(/(\d{4})\/(\d{2})\/(\d{2})/)
        if (match3) return `${match3[1]}${match3[2]}${match3[3]}`
    }
    return getCurrentDatetime().replace(/-/g, '').replace(/_/g, '')
}

function extractArtistFromDOM(): string {
    const el = document.querySelector('#video-artist-name') as HTMLElement | null
    if (el) {
        return el.textContent?.trim() || el.innerText?.trim() || ''
    }
    return ''
}

function extractTitleFromDOM(): string {
    const el = document.querySelector('#shareBtn-title') as HTMLElement | null
    if (el) {
        return el.textContent?.trim() || el.innerText?.trim() || ''
    }
    return ''
}

function extractArtistAndTitle(): { artist: string, title: string } {
    return {
        artist: extractArtistFromDOM() || extractArtistFromUrl(location.href),
        title: extractTitleFromDOM() || document.title.split('|')[0].trim() || 'video'
    }
}

let bulkProgressPanel: HTMLElement | null = null

function showBulkProgressPanel(totalVideos: number) {
    const panelId = 'hanime-bulk-progress-panel'
    let panel = document.getElementById(panelId)
    if (panel) panel.remove()
    
    panel = document.createElement('div')
    panel.id = panelId
    panel.style.position = 'fixed'
    panel.style.left = '50%'
    panel.style.top = '50%'
    panel.style.transform = 'translate(-50%, -50%)'
    panel.style.width = '500px'
    panel.style.background = '#111827'
    panel.style.color = '#e5e7eb'
    panel.style.padding = '20px'
    panel.style.borderRadius = '8px'
    panel.style.boxShadow = '0 4px 16px rgba(0,0,0,.4)'
    panel.style.zIndex = '1000000'

    const title = document.createElement('div')
    title.textContent = 'Bulk Download Progress'
    title.style.fontWeight = 'bold'
    title.style.marginBottom = '16px'
    title.style.fontSize = '18px'
    panel.appendChild(title)

    const progressContainer = document.createElement('div')
    progressContainer.style.marginBottom = '16px'
    
    const progressBar = document.createElement('div')
    progressBar.style.width = '100%'
    progressBar.style.height = '20px'
    progressBar.style.background = '#374151'
    progressBar.style.borderRadius = '10px'
    progressBar.style.overflow = 'hidden'
    
    const progressFill = document.createElement('div')
    progressFill.style.height = '100%'
    progressFill.style.background = '#2563eb'
    progressFill.style.width = '0%'
    progressFill.style.transition = 'width 0.3s ease'
    progressFill.id = 'bulk-progress-fill'
    
    progressBar.appendChild(progressFill)
    progressContainer.appendChild(progressBar)
    panel.appendChild(progressContainer)

    const statusText = document.createElement('div')
    statusText.id = 'bulk-status-text'
    statusText.textContent = `Processing videos... 0/${totalVideos}`
    statusText.style.marginBottom = '16px'
    panel.appendChild(statusText)

    const currentVideoText = document.createElement('div')
    currentVideoText.id = 'bulk-current-video'
    currentVideoText.textContent = 'Preparing...'
    currentVideoText.style.fontSize = '14px'
    currentVideoText.style.color = '#9ca3af'
    panel.appendChild(currentVideoText)

    document.body.appendChild(panel)
    bulkProgressPanel = panel
}

function updateBulkProgress(current: number, total: number, currentVideo?: string) {
    const progressFill = document.getElementById('bulk-progress-fill')
    const statusText = document.getElementById('bulk-status-text')
    const currentVideoText = document.getElementById('bulk-current-video')
    
    if (progressFill) {
        const percentage = (current / total) * 100
        progressFill.style.width = `${percentage}%`
    }
    
    if (statusText) {
        statusText.textContent = `Processing videos... ${current}/${total}`
    }
    
    if (currentVideoText && currentVideo) {
        currentVideoText.textContent = `Current: ${currentVideo}`
    }
    
    if (current >= total) {
        setTimeout(() => {
            if (bulkProgressPanel) {
                bulkProgressPanel.remove()
                bulkProgressPanel = null
            }
        }, 2000)
    }
}

function addDownloadButtonsToVideos() {
    // Tìm tất cả các link video với nhiều pattern khác nhau
    const selectors = [
        'a[href*="/watch?v="]',  // hanime1.me format: /watch?v=123456
        'a[href*="watch?v="]',   // Full URL format: https://hanime1.me/watch?v=123456
        'a[href^="/watch/"]',    // Iwara format: /watch/123456
        'a[href*="/video/"]'     // Alternative format: /video/123456
    ]
    
    const allVideoLinks: HTMLAnchorElement[] = []
    for (const selector of selectors) {
        const links = document.querySelectorAll(selector) as NodeListOf<HTMLAnchorElement>
        for (const a of Array.from(links)) {
            const href = a.href
            // Chỉ lấy các link có chứa video ID (số)
            if (href.match(/[?&]v=\d+/) || href.match(/\/watch\/\d+/) || href.match(/\/video\/\d+/)) {
                allVideoLinks.push(a)
            }
        }
    }
    
    for (const a of allVideoLinks) {
        const card = a.closest('.card') || a.closest('.video-item') || a.parentElement
        if (!card || card.querySelector('.hanime-dl-video-btn')) continue
        const btn = document.createElement('button')
        btn.className = 'hanime-dl-video-btn'
        btn.textContent = 'Download'
        btn.style.display = 'block'
        btn.style.margin = '8px auto'
        btn.style.padding = '6px 10px'
        btn.style.background = '#2563eb'
        btn.style.color = '#fff'
        btn.style.border = 'none'
        btn.style.borderRadius = '4px'
        btn.style.cursor = 'pointer'
        btn.onclick = async () => {
            const url = a.href
            const {streams, title} = await tryExtractFromUrl(url)
            if (streams.length) {
                const stream = getPreferredStream(streams)
                if (stream) {
                    // Try to get artist/title/date from card DOM first, fallback to URL or page data
                    const card = a.closest('.card') || a.closest('.video-item') || a.parentElement
                    const cardArtist = card?.querySelector('#video-artist-name, [id*="artist"]')?.textContent?.trim() || ''
                    const cardTitle = card?.querySelector('#shareBtn-title, [id*="title"]')?.textContent?.trim() || title || 'video'
                    // Try to find date in card text
                    let cardDate = ''
                    if (card) {
                        const cardText = card.textContent || ''
                        const dateMatch = cardText.match(/(\d{4})[/-](\d{2})[/-](\d{2})/)
                        if (dateMatch) cardDate = `${dateMatch[1]}${dateMatch[2]}${dateMatch[3]}`
                    }
                    const datetime = cardDate || extractUploadDate() || getCurrentDatetime()
                    const artist = cardArtist || extractArtistFromUrl(location.href)
                    const videoTitle = cardTitle || title || 'video'
                    const fname = formatFilename(filenameTemplate, { title: videoTitle, artist, datetime })
                    logger.info('Downloading ' + fname + ' from ' + stream.url)
                    if (stream.url.endsWith('.m3u8')) {
                        await downloadM3u8(stream.url, fname)
                    } else {
                        await downloadBlob(stream.url, `${fname}.mp4`)
                    }
                } else {
                    logger.warn('No matching stream for preferred res in ' + url)
                    alert('No stream matching preferred resolution.')
                }
            } else {
                logger.warn('No streams found for ' + url)
                alert('No download links found for this video.')
            }
        }
        card.appendChild(btn)
    }
}

function ensureBulkButton() {
    if (bulkBtnInited) return
    if (!location.pathname.startsWith('/maker/') && !location.pathname.startsWith('/search')) return
    let btn = document.getElementById('hanime-bulk-btn') as HTMLButtonElement | null
    if (!btn) {
        btn = document.createElement('button')
        btn.id = 'hanime-bulk-btn'
        btn.textContent = 'Bulk Download Videos'
        btn.style.position = 'fixed'
        btn.style.right = '20px'
        btn.style.bottom = '140px' // Positioned above the single download button
        btn.style.zIndex = '999999'
        btn.style.padding = '10px 16px'
        btn.style.background = '#dc2626'
        btn.style.color = '#fff'
        btn.style.borderRadius = '8px'
        btn.style.border = '2px solid #fff'
        btn.style.cursor = 'pointer'
        btn.onclick = async () => {
            logger.info('Bulk download started')
            const videoUrls = await crawlVideos(location.href)
            logger.info(`Found ${videoUrls.length} videos to process`)
            
            // Clear previous queue
            downloadQueue.clear()
            
            // Show progress panel
            showBulkProgressPanel(videoUrls.length)
            
            // Process videos by opening tabs and auto-downloading
            for (let i = 0; i < videoUrls.length; i++) {
                const vurl = videoUrls[i]
                logger.info(`Processing video ${i + 1}/${videoUrls.length}: ${vurl}`)
                
                // Update progress
                updateBulkProgress(i + 1, videoUrls.length, `Opening tab for: ${vurl}`)
                
                // Mở tab với auto-download parameter
                const autoUrl = vurl + (vurl.includes('?') ? '&' : '?') + 'auto_dl=1'
                GM_openInTab(autoUrl, { active: false, insert: true, setParent: true })
                logger.info(`Opened tab for auto-download: ${autoUrl}`)
                
                // Mở tab với auto-download parameter - delay 5s để đảm bảo tab load xong trước khi mở tab tiếp
                await delay(1500) // 1.5 giây delay giữa các tab
            }
            
            logger.info(`Opened ${videoUrls.length} tabs for auto-download`)
            updateBulkProgress(videoUrls.length, videoUrls.length, 'All tabs opened - downloads will start automatically')
        }
        document.body.appendChild(btn)
        logger.info('Bulk button added to page')
    }
    bulkBtnInited = true
}

function ensureSettingsButton() {
    if (settingsBtnInited) return
    let btn = document.getElementById('hanime-settings-btn') as HTMLButtonElement | null
    if (!btn) {
        btn = document.createElement('button')
        btn.id = 'hanime-settings-btn'
        btn.textContent = 'Settings'
        btn.style.position = 'fixed'
        btn.style.right = '20px'
        btn.style.bottom = '200px' // Above bulk
        btn.style.zIndex = '999999'
        btn.style.padding = '8px 12px'
        btn.style.background = '#4caf50'
        btn.style.color = '#fff'
        btn.style.borderRadius = '8px'
        btn.style.border = '2px solid #fff'
        btn.style.cursor = 'pointer'
        btn.onclick = showSettingsPanel
        document.body.appendChild(btn)
        logger.info('Settings button added to page')
    }
    settingsBtnInited = true
}

function showSettingsPanel() {
    const panelId = 'hanime-settings-panel'
    let panel = document.getElementById(panelId)
    if (panel) panel.remove()
    panel = document.createElement('div')
    panel.id = panelId
    panel.style.position = 'fixed'
    panel.style.right = '20px'
    panel.style.bottom = '250px'
    panel.style.width = '300px'
    panel.style.background = '#111827'
    panel.style.color = '#e5e7eb'
    panel.style.padding = '12px'
    panel.style.borderRadius = '8px'
    panel.style.boxShadow = '0 4px 16px rgba(0,0,0,.4)'

    const title = document.createElement('div')
    title.textContent = 'Download Settings'
    title.style.fontWeight = 'bold'
    title.style.marginBottom = '8px'
    panel.appendChild(title)

    const resLabel = document.createElement('label')
    resLabel.textContent = 'Preferred Resolution:'
    resLabel.style.display = 'block'
    resLabel.style.marginBottom = '4px'
    panel.appendChild(resLabel)

    const resSelect = document.createElement('select')
    resSelect.style.width = '100%'
    resSelect.style.marginBottom = '8px'
    const options = ['highest', '1080', '720', '480', '360']
    for (const opt of options) {
        const option = document.createElement('option')
        option.value = opt
        option.textContent = opt === 'highest' ? 'Highest Available' : `${opt}p`
        if (opt === preferredRes) option.selected = true
        resSelect.appendChild(option)
    }
    panel.appendChild(resSelect)

    const templateLabel = document.createElement('label')
    templateLabel.textContent = 'Filename Template:'
    templateLabel.style.display = 'block'
    templateLabel.style.marginBottom = '4px'
    templateLabel.style.marginTop = '8px'
    panel.appendChild(templateLabel)

    const templateInput = document.createElement('input')
    templateInput.type = 'text'
    templateInput.value = filenameTemplate
    templateInput.placeholder = '%title%'
    templateInput.style.width = '100%'
    templateInput.style.marginBottom = '4px'
    templateInput.style.padding = '4px'
    templateInput.style.background = '#374151'
    templateInput.style.color = '#fff'
    templateInput.style.border = '1px solid #6b7280'
    templateInput.style.borderRadius = '4px'
    panel.appendChild(templateInput)

    const templateHint = document.createElement('div')
    templateHint.style.fontSize = '11px'
    templateHint.style.color = '#9ca3af'
    templateHint.style.marginBottom = '8px'
    templateHint.textContent = 'Variables: %title%, %artist%, %datetime%'
    panel.appendChild(templateHint)

    const saveBtn = document.createElement('button')
    saveBtn.textContent = 'Save'
    saveBtn.style.padding = '6px 10px'
    saveBtn.style.background = '#2563eb'
    saveBtn.style.color = '#fff'
    saveBtn.style.border = 'none'
    saveBtn.style.borderRadius = '4px'
    saveBtn.style.cursor = 'pointer'
    saveBtn.onclick = () => {
        preferredRes = resSelect.value
        GM_setValue('hanime_preferred_res', preferredRes)
        filenameTemplate = templateInput.value || '%title%'
        GM_setValue('hanime_filename_template', filenameTemplate)
        logger.info('Saved settings - resolution:', preferredRes, ', template:', filenameTemplate)
        panel?.remove()
    }
    panel.appendChild(saveBtn)

    const close = document.createElement('button')
    close.textContent = 'Close'
    close.style.marginLeft = '8px'
    close.style.padding = '6px 10px'
    close.style.background = '#6b7280'
    close.style.color = '#fff'
    close.style.border = 'none'
    close.style.borderRadius = '4px'
    close.style.cursor = 'pointer'
    close.onclick = () => panel?.remove()
    panel.appendChild(close)

    document.body.appendChild(panel)
}

// Debounce function to prevent rapid calls
function debounce(fn: () => void, ms: number) {
    let timeout: number | undefined
    return () => {
        clearTimeout(timeout)
        timeout = setTimeout(fn, ms)
    }
}

function setupObservers() {
    const debouncedCallback = debounce(() => {
        try {
            logger.debug('DOM mutated, try extract again')
            const s = tryExtract()
            if (s.length) attachUI(s)
            else if (!warnedNoStreams) updateButtonLabel()
            if (location.pathname.startsWith('/maker/') || location.pathname.startsWith('/search')) {
                addDownloadButtonsToVideos()
            }
        } catch (e) {
            logger.error('Mutation callback error:', e)
        }
    }, 300) // Debounce to 300ms to reduce frequency

    const mo = new MutationObserver(debouncedCallback)
    mo.observe(document.body, { childList: true, subtree: true }) // Limited to body for less overhead

    // On /watch?, disconnect after initial to avoid spam
    if (location.pathname.startsWith('/watch/')) {
        setTimeout(() => mo.disconnect(), 5000) // Give time for load, then stop observing to prevent spam
    }

    const wrap = (target: History, name: 'pushState' | 'replaceState') => {
        const orig = target[name]
        target[name] = function(...args: [data: any, unused: string, url?: string | URL | null | undefined]) {
            const r = orig.apply(this, args)
            logger.info('History changed:', name)
            setTimeout(() => { // Async to avoid sync stack issues
                const s = tryExtract()
                if (s.length) attachUI(s)
                else updateButtonLabel()
                ensureBulkButton()
                if (location.pathname.startsWith('/maker/') || location.pathname.startsWith('/search')) {
                    addDownloadButtonsToVideos()
                }
            }, 100) // Slight delay for DOM settle
            return r
        }
    }
    try { wrap(history, 'pushState'); wrap(history, 'replaceState') } catch(_) {}

    const origFetch = window.fetch
    window.fetch = async (...args: Parameters<typeof fetch>) => {
        const res = await origFetch(...args)
        try {
            const ct = res.headers.get('content-type') || ''
            if (ct.includes('application/json')) {
                const clone = res.clone()
                const json = await clone.json().catch(() => undefined)
                if (json) {
                    const extra = extractStreamsFromState(json)
                    if (extra.length) {
                        logger.info('Captured streams via fetch:', extra.length)
                        const urls = new Set(currentStreams.map(x => x.url))
                        for (const it of extra) if (!urls.has(it.url)) currentStreams.push(it)
                        updateButtonLabel()
                    }
                }
            } else {
                const url = (res.url || '').toString()
                if (url.includes('.m3u8')) {
                    logger.info('Captured m3u8 via fetch:', url)
                    if (!currentStreams.some(x => x.url === url)) currentStreams.push({ url, type: 'm3u8' })
                    updateButtonLabel()
                }
            }
        } catch(_) {}
        return res
    }
}

async function autoDownloadIfNeeded() {
    const urlParams = new URLSearchParams(location.search)
    if (urlParams.has('auto_dl')) {
        logger.info('Auto-download mode detected')
        
        // Chờ 3 giây để trang load hoàn toàn
        await delay(3000)
        
        // Simulate play if needed to load streams
        const playBtn = document.querySelector('.plyr__control--overlaid, .plyr__control--play') as HTMLElement | null
        if (playBtn) {
            playBtn.click()
            logger.info('Simulated play click to load streams')
            await delay(2000) // Wait for play to load streams
        }

        let streams = tryExtract()
        let title = document.title || 'unknown'
        
        // Nếu không tìm thấy streams, thử API fallback
        if (streams.length === 0) {
            logger.info('No streams found in DOM, trying API fallback')
            const slug = urlParams.get('v')
            if (slug) {
                try {
                    const apiUrl = `/api/v8/video?id=${slug}`
                    const response = await fetch(apiUrl)
                    if (response.ok) {
                        const json = await response.json()
                        streams = extractStreamsFromState(json)
                        title = extractTitleFromState(json) || title
                        logger.info(`API fallback found ${streams.length} streams`)
                    }
                } catch (error) {
                    logger.error('API fallback failed:', error)
                }
            }
        }
        
        if (streams.length > 0) {
            const stream = getPreferredStream(streams)
            if (stream) {
                const { artist, title: videoTitle } = extractArtistAndTitle()
                const datetime = extractUploadDate() || getCurrentDatetime()
                const fname = formatFilename(filenameTemplate, { title: videoTitle, artist, datetime })
                logger.info(`Starting download: ${fname} (${stream.resolution}) from ${stream.url}`)

                try {
                    if (stream.url.endsWith('.m3u8')) {
                        await downloadM3u8(stream.url, fname)
                    } else {
                        await downloadBlob(stream.url, `${fname}.mp4`)
                    }
                    
                    logger.info(`Download started for: ${fname}`)
                    
                    // Đóng tab sau 5 giây để đảm bảo download đã bắt đầu
                    setTimeout(() => {
                        logger.info('Closing auto-download tab')
                        window.close()
                    }, 5000)
                } catch (error) {
                    logger.error(`Download failed for ${fname}:`, error)
                    setTimeout(() => window.close(), 2000)
                }
            } else {
                logger.warn('No matching stream for preferred resolution, closing tab')
                setTimeout(() => window.close(), 2000)
            }
        } else {
            logger.warn('No streams found, closing tab')
            setTimeout(() => window.close(), 2000)
        }
    }
}

function mount() {
    logger.group('Mount Hanime Download Tool')
    ensureButton()
    ensureBulkButton()
    ensureSettingsButton()
    const streams = tryExtract()
    if (streams.length) attachUI(streams)
    else { logger.warn('No UI attached due to empty streams'); updateButtonLabel() }
    if (location.pathname.startsWith('/maker/') || location.pathname.startsWith('/search')) {
        addDownloadButtonsToVideos()
    }
    autoDownloadIfNeeded() // Check for auto mode
    setupObservers()
    logger.groupEnd()
    logger.info('Script fully mounted - check for button in bottom-right. If not visible, scroll or zoom out.')
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount)
} else {
    mount()
}
