/**
 * The local backend's HTTP client: browser-shaped requests, charset decoding,
 * byte/character caps, and failure classification.
 *
 * One policy point, because both operations share it and because the
 * classification is what separates `request` from `blocked` from `parse`.
 *
 * @module cube-dsh-free/transport
 */

import { failure } from './errors.js'

/** A current desktop browser UA: many sources serve a stripped page to bots. */
export const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

/** How each operation presents itself. */
export const PROFILES = Object.freeze({
  /** A top-level navigation, as if a person typed the URL. */
  document: {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    language: 'zh-CN,zh;q=0.9,en;q=0.8',
    secFetchDest: 'document',
    secFetchMode: 'navigate',
    secFetchSite: 'none',
  },
  /** A same-site fetch from a results page the user is browsing. */
  search: {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    language: 'zh-CN,zh;q=0.9,en;q=0.8',
    secFetchDest: 'document',
    secFetchMode: 'navigate',
    secFetchSite: 'same-origin',
  },
})

/** Statuses that mean "we will not serve you this content". */
const BLOCKING_STATUSES = new Set([401, 403, 407, 429, 451])

/** Statuses that are a server or edge problem rather than a refusal. */
const SERVER_STATUSES = new Set([500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526])

/**
 * @typedef {object} FetchOutcome
 * @property {string} url - final URL after redirects.
 * @property {number} status - HTTP status.
 * @property {string} contentType - lowercased media type without parameters.
 * @property {string} text - decoded body.
 * @property {boolean} truncated - whether a size or character cap cut the body.
 */

/**
 * Request one URL as a browser would, decode it, and classify the failures.
 *
 * A non-2xx status throws: the search layer needs the failure kind, and the
 * fetch layer treats a non-2xx as "no content to extract" rather than
 * re-exposing an unparsed error page as the page's body.
 *
 * @param {string} url - absolute HTTP(S) URL.
 * @param {object} options - request shape and bounds.
 * @param {'document' | 'search'} options.profile - header profile.
 * @param {number} options.timeoutMs - whole-request deadline.
 * @param {number} options.maxBytes - response byte cap.
 * @param {number} options.maxChars - decoded character cap.
 * @param {string} [options.source] - label used in failure messages.
 * @param {AbortSignal} [options.signal] - caller cancellation.
 * @param {import('./cookies.js').CookieJar} [options.jar] - session jar to read
 *   and update, so the source sees one continuous session.
 * @returns {Promise<FetchOutcome>} the decoded response.
 */
export async function requestPage(url, options) {
  const profile = PROFILES[options.profile] ?? PROFILES.document
  const source = options.source
  const controller = new AbortController()
  const detach = attachAbort(controller, options.signal)
  const timer = setTimeout(
    () => controller.abort(new Error(`timeout after ${options.timeoutMs}ms`)),
    options.timeoutMs,
  )
  try {
    const cookie = options.jar?.header(url)
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': BROWSER_USER_AGENT,
        accept: profile.accept,
        'accept-language': profile.language,
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        'sec-fetch-dest': profile.secFetchDest,
        'sec-fetch-mode': profile.secFetchMode,
        'sec-fetch-site': profile.secFetchSite,
        'upgrade-insecure-requests': '1',
        ...cookie === undefined ? {} : { cookie },
      },
    })
    // Feed the response's cookies back so the next page of the same source
    // continues the session instead of starting a new one.
    options.jar?.absorb(response, response.url === '' ? url : response.url)
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw classifyStatus(response.status, url, source)
    }
    const contentTypeHeader = response.headers.get('content-type') ?? ''
    const contentType = contentTypeHeader.split(';')[0].trim().toLowerCase()
    const charset = parseCharset(contentTypeHeader) ?? 'utf-8'
    const { bytes, truncated } = await readCapped(response, options.maxBytes, url, source)
    const text = decodeBody(bytes, charset, url, source)
    const body = text.length > options.maxChars ? text.slice(0, options.maxChars) : text
    return {
      url: response.url === '' ? url : response.url,
      status: response.status,
      contentType,
      text: body,
      truncated: truncated || body.length !== text.length,
    }
  } catch (error) {
    if (options.signal?.aborted === true) throw error
    if (isClassified(error)) throw error
    throw failure('request', `无法访问 ${url}：${describeNetworkError(error)}`, { cause: error, source })
  } finally {
    clearTimeout(timer)
    detach()
  }
}

/**
 * Relay an outer cancellation signal onto the request's own controller.
 *
 * @param {AbortController} controller - the request controller.
 * @param {AbortSignal | undefined} signal - caller signal.
 * @returns {() => void} detaches the relay.
 */
function attachAbort(controller, signal) {
  if (signal === undefined) return () => {}
  if (signal.aborted) {
    controller.abort(signal.reason)
    return () => {}
  }
  const abort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  return () => signal.removeEventListener('abort', abort)
}

/**
 * Turn an HTTP status into a classified failure.
 *
 * @param {number} status - HTTP status.
 * @param {string} url - request URL.
 * @param {string} [source] - source label.
 * @returns {Error} the failure.
 */
function classifyStatus(status, url, source) {
  if (BLOCKING_STATUSES.has(status)) {
    return failure('blocked', `${url} 返回 HTTP ${status}（来源拒绝或要求验证）`, { source })
  }
  if (SERVER_STATUSES.has(status)) {
    return failure('request', `${url} 返回 HTTP ${status}（服务端错误）`, { source })
  }
  return failure('request', `${url} 返回 HTTP ${status}`, { source })
}

/**
 * Read a response body with a byte cap.
 *
 * A declared `Content-Length` far beyond the cap is refused up front instead of
 * downloading it; a stream that grows past the cap is cut short, so a server
 * that under-reports still yields a bounded usable body.
 *
 * @param {Response} response - the response.
 * @param {number} maxBytes - byte cap.
 * @param {string} url - request URL.
 * @param {string} [source] - source label.
 * @returns {Promise<{ bytes: Uint8Array, truncated: boolean }>} the bytes.
 */
async function readCapped(response, maxBytes, url, source) {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const length = Number(declared)
    if (Number.isFinite(length) && length > maxBytes * 8) {
      await response.body?.cancel().catch(() => {})
      throw failure('blocked', `${url} 响应体过大（声明 ${length} 字节）`, { source })
    }
  }
  if (response.body === null) return { bytes: new Uint8Array(0), truncated: false }
  const chunks = []
  let total = 0
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      chunks.push(value)
      total += value.byteLength
      if (total >= maxBytes) return { bytes: concat(chunks, maxBytes), truncated: true }
    }
  } finally {
    reader.releaseLock?.()
  }
  return { bytes: concat(chunks, Number.POSITIVE_INFINITY), truncated: false }
}

/**
 * Join byte chunks, optionally cutting at a maximum length.
 *
 * @param {Uint8Array[]} chunks - received chunks.
 * @param {number} max - maximum bytes to keep.
 * @returns {Uint8Array} the joined bytes.
 */
function concat(chunks, max) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const length = Math.min(total, max)
  const out = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    if (offset >= length) break
    const take = Math.min(chunk.byteLength, length - offset)
    out.set(chunk.subarray(0, take), offset)
    offset += take
  }
  return out
}

/**
 * Decode bytes with the declared charset, falling back to UTF-8.
 *
 * Chinese sources still emit GBK occasionally, and an unknown label throws in
 * `TextDecoder`; both cases fall back rather than failing the page.
 *
 * @param {Uint8Array} bytes - response bytes.
 * @param {string} charset - declared charset label.
 * @param {string} url - request URL.
 * @param {string} [source] - source label.
 * @returns {string} decoded text.
 */
function decodeBody(bytes, charset, url, source) {
  const labels = [charset, 'utf-8']
  for (const label of labels) {
    try {
      return new TextDecoder(label, { fatal: false }).decode(bytes)
    } catch {
      // Try the next label.
    }
  }
  throw failure('parse', `${url} 的字节无法解码为文本（声明 charset=${charset}）`, { source })
}

/**
 * Read `charset=` from a Content-Type header.
 *
 * @param {string} header - the header value.
 * @returns {string | undefined} the charset label.
 */
function parseCharset(header) {
  const match = /charset\s*=\s*"?([^";,\s]+)"?/i.exec(header)
  return match === null ? undefined : match[1].toLowerCase()
}

/**
 * Whether a caught value is one of this plugin's classified failures.
 *
 * @param {unknown} error - caught value.
 * @returns {boolean} true for a classified failure.
 */
function isClassified(error) {
  const code = /** @type {any} */ (error)?.code
  return typeof code === 'string' && code.startsWith('CUBE_WEB_')
}

/**
 * Render a fetch failure without leaking stack noise into the model's error.
 *
 * @param {unknown} error - caught value.
 * @returns {string} a short reason.
 */
export function describeNetworkError(error) {
  if (error instanceof Error) {
    const code = /** @type {any} */ (error).cause?.code ?? /** @type {any} */ (error).code
    if (typeof code === 'string' && code !== '') return `${code}（${error.message}）`
    return error.message === '' ? error.name : error.message
  }
  return String(error)
}