import { build } from 'esbuild'
import fs from 'fs'
import path from 'path'

const projectRoot = path.resolve(process.cwd())
const srcDir = path.join(projectRoot, 'src')
const distDir = path.join(projectRoot, 'dist')

function ensureDir(p) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true })
}

function readMetaTemplate() {
    const metaPath = path.join(srcDir, 'mata', 'userjs.mata')
    return fs.existsSync(metaPath) ? fs.readFileSync(metaPath, 'utf-8') : ''
}

function writeUserscriptHeader(code) {
    const meta = readMetaTemplate()
    return `${meta}\n${code}`
}

async function run() {
    ensureDir(distDir)
    await build({
        entryPoints: [path.join(srcDir, 'main.ts')],
        bundle: true,
        format: 'iife',
        target: ['es2020'],
        outfile: path.join(distDir, 'HanimeDownloadTool.user.js'),
        platform: 'browser',
        sourcemap: false,
        logLevel: 'info',
        banner: { js: writeUserscriptHeader('') },
        define: { global: 'window' } // For browser compatibility
    })
}

run().catch(err => {
    console.error(err)
    process.exit(1)
})