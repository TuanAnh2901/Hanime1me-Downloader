export const isNull = (obj: unknown): obj is null => obj === null
export const isUndefined = (obj: unknown): obj is undefined => typeof obj === 'undefined'
export const isNullOrUndefined = (obj: unknown): obj is null | undefined => isUndefined(obj) || isNull(obj)
export const isString = (obj: unknown): obj is string => !isNullOrUndefined(obj) && typeof obj === 'string'
export const isObject = (obj: unknown): obj is object => !isNullOrUndefined(obj) && typeof obj === 'object'

export function delay(time: number) {
    return new Promise(resolve => setTimeout(resolve, time))
}

export function UUID() {
    return (crypto as any)?.randomUUID ? crypto.randomUUID().replaceAll('-', '') : Array.from({ length: 8 }, () => (((1 + Math.random()) * 0x10000) | 0).toString(16).substring(1)).join('')
}

