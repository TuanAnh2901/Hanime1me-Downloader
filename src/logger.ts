type Level = 'debug' | 'info' | 'warn' | 'error'

function now() {
    const d = new Date()
    return d.toISOString()
}

function readFlag(): boolean {
    try {
        // Tampermonkey
        // @ts-ignore
        if (typeof GM_getValue === 'function') {
            // @ts-ignore
            const v = GM_getValue('hanime-dl-debug', false)
            return !!v
        }
    } catch (_) {}
    try {
        const v = localStorage.getItem('hanime-dl-debug')
        return v === 'true'
    } catch (_) { }
    return false
}

function writeFlag(v: boolean) {
    try {
        // @ts-ignore
        if (typeof GM_setValue === 'function') {
            // @ts-ignore
            GM_setValue('hanime-dl-debug', v)
            return
        }
    } catch (_) {}
    try { localStorage.setItem('hanime-dl-debug', v ? 'true' : 'false') } catch (_) {}
}

class Logger {
    private enabled = readFlag()
    public setEnabled(v: boolean) { this.enabled = v; writeFlag(v) }
    public isEnabled() { return this.enabled }
    private fmt(level: Level, msg: any[]) { return [`[HanimeDL][${level.toUpperCase()}][${now()}]`, ...msg] }
    public debug(...msg: any[]) { if (this.enabled) console.debug(...this.fmt('debug', msg)) }
    public info(...msg: any[]) { console.info(...this.fmt('info', msg)) }
    public warn(...msg: any[]) { console.warn(...this.fmt('warn', msg)) }
    public error(...msg: any[]) { console.error(...this.fmt('error', msg)) }
    public group(label: string) { if (this.enabled) console.group(`[HanimeDL] ${label}`) }
    public groupEnd() { if (this.enabled) console.groupEnd() }
}

export const logger = new Logger()
;(window as any).HanimeDLLogger = logger
;(window as any).HanimeDLSetDebug = (v: boolean) => logger.setEnabled(v)

