import { logger } from './logger'
import { delay } from './env'

export async function downloadM3u8(m3u8Url: string, filename: string, concurrent = 5) {
    try {
        logger.info(`Starting M3U8 download for ${filename}`)
        const m3u8Text = await fetch(m3u8Url).then(res => res.text())
        const lines = m3u8Text.split('\n')
        const segments: string[] = []
        let baseUrl = m3u8Url.slice(0, m3u8Url.lastIndexOf('/') + 1)
        for (let line of lines) {
            line = line.trim()
            if (line && !line.startsWith('#') && line.endsWith('.ts')) {
                const absUrl = line.startsWith('http') ? line : baseUrl + line
                segments.push(absUrl)
            }
        }
        logger.info(`Found ${segments.length} segments`)

        const blobs: Blob[] = []
        const chunks = Array.from({ length: Math.ceil(segments.length / concurrent) }, (_, i) =>
            segments.slice(i * concurrent, (i + 1) * concurrent)
        )
        for (const chunk of chunks) {
            const promises = chunk.map(async url => {
                const res = await fetch(url)
                if (!res.ok) throw new Error(`Failed to fetch segment ${url}`)
                return await res.blob()
            })
            const chunkBlobs = await Promise.all(promises)
            blobs.push(...chunkBlobs)
            await delay(500) // Throttle to avoid rate limits
        }

        const fullBlob = new Blob(blobs, { type: 'video/mp2t' })
        const dlUrl = URL.createObjectURL(fullBlob)
        const a = document.createElement('a')
        a.href = dlUrl
        a.download = `${filename}.ts` // Download as .ts, user can convert to mp4 with ffmpeg -i input.ts -c copy output.mp4
        a.click()
        URL.revokeObjectURL(dlUrl)
        logger.info(`Downloaded ${filename}.ts`)
    } catch (err) {
        logger.error(`M3U8 download failed: ${err}`)
    }
}

function sanitizeFilename(name: string): string {
    return (name || 'video').replace(/[^a-z0-9]/gi, '_').toLowerCase()
}