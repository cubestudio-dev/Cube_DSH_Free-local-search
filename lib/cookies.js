/**
 * Cookie handling for the local backend: a live in-memory jar, a warm-up visit,
 * and optional import from a browser's cookie store.
 *
 * Why a jar rather than a single static header: public search engines gate
 * anonymous traffic by session. A first visit issues cookies (`BAIDUID`,
 * `MUID`, `_EDGE_S`, …) that the search request then carries, which is the
 * difference between a results page and a verification wall — measured on
 * Baidu, where the same query without the warm-up cookies returns
 * 「百度安全验证」 and with them returns normal results.
 *
 * The jar is process-local and never persisted. Browser import is opt-in, read
 * only for the configured engines' hosts, and dropped as soon as the process
 * exits: those cookies are the user's own login sessions for unrelated
 * sites, so nothing beyond the named hosts is read, copied, or stored.
 *
 * @module cube-dsh-free/cookies
 */

import { failure } from './errors.js'

/** One stored cookie. */
/**
 * @typedef {object} StoredCookie
 * @property {string} name
 * @property {string} value
 * @property {string} domain - leading-dot domain or exact host.
 * @property {string} path
 * @property {boolean} hostOnly
 * @property {number} [expires] - epoch seconds; absent for session cookies.
 */

/**
 * A small cookie jar with domain/path matching and expiry.
 */
export class CookieJar {
  /** @type {Map<string, StoredCookie>} */
  #cookies = new Map()

  /**
   * Store one cookie, replacing an identical name/domain/path triple.
   *
   * @param {StoredCookie} cookie - the cookie.
   * @returns {void}
   */
  set(cookie) {
    if (cookie.expires !== undefined && cookie.expires * 1000 <= Date.now()) {
      this.#cookies.delete(keyOf(cookie))
      return
    }
    this.#cookies.set(keyOf(cookie), cookie)
  }

  /**
   * Absorb the `Set-Cookie` headers of a response.
   *
   * @param {Response} response - the response.
   * @param {string} requestUrl - the URL the response came from.
   * @returns {void}
   */
  absorb(response, requestUrl) {
    const headers = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : splitCombined(response.headers.get('set-cookie'))
    for (const header of headers) {
      const cookie = parseSetCookie(header, requestUrl)
      if (cookie !== undefined) this.set(cookie)
    }
  }

  /**
   * Build the `cookie` request header for a URL.
   *
   * @param {string} url - the request URL.
   * @returns {string | undefined} the header value, or undefined when empty.
   */
  header(url) {
    let target
    try {
      target = new URL(url)
    } catch {
      return undefined
    }
    const now = Date.now()
    /** @type {string[]} */
    const parts = []
    for (const cookie of this.#cookies.values()) {
      if (cookie.expires !== undefined && cookie.expires * 1000 <= now) continue
      if (!domainMatches(cookie, target.hostname)) continue
      if (!pathMatches(cookie.path, target.pathname)) continue
      parts.push(`${cookie.name}=${cookie.value}`)
    }
    return parts.length === 0 ? undefined : parts.join('; ')
  }

  /**
   * Merge cookies imported from another jar (browser import).
   *
   * @param {StoredCookie[]} cookies - the imported cookies.
   * @returns {number} how many were stored.
   */
  import(cookies) {
    let count = 0
    for (const cookie of cookies) {
      this.set(cookie)
      count += 1
    }
    return count
  }

  /**
   * Number of live cookies, for diagnostics.
   *
   * @returns {number} the count.
   */
  get size() {
    const now = Date.now()
    let live = 0
    for (const cookie of this.#cookies.values()) {
      if (cookie.expires === undefined || cookie.expires * 1000 > now) live += 1
    }
    return live
  }
}

/**
 * Identity of a cookie within the jar.
 *
 * @param {StoredCookie} cookie - the cookie.
 * @returns {string} the key.
 */
function keyOf(cookie) {
  return `${cookie.domain}\u0000${cookie.path}\u0000${cookie.name}`
}

/**
 * Split a combined `Set-Cookie` header. Only used when the runtime lacks
 * `getSetCookie()`; splitting on commas inside `Expires` is avoided by
 * requiring a cookie-name shape after each comma.
 *
 * @param {string | null} header - the header value.
 * @returns {string[]} individual cookie strings.
 */
function splitCombined(header) {
  if (header === null || header === '') return []
  return header.split(/,(?=\s*[^;,=\s]+\s*=)/)
}

/**
 * Parse one `Set-Cookie` header into a stored cookie.
 *
 * @param {string} header - the header value.
 * @param {string} requestUrl - the URL the response came from.
 * @returns {StoredCookie | undefined} the cookie, or undefined when malformed.
 */
export function parseSetCookie(header, requestUrl) {
  const parts = header.split(';')
  const pair = parts[0]
  const separator = pair.indexOf('=')
  if (separator <= 0) return undefined
  const name = pair.slice(0, separator).trim()
  const value = pair.slice(separator + 1).trim()
  if (name === '') return undefined
  let host
  try {
    host = new URL(requestUrl).hostname.toLowerCase()
  } catch {
    return undefined
  }
  let domain = host
  let hostOnly = true
  let path = defaultPath(requestUrl)
  let expires
  for (const raw of parts.slice(1)) {
    const index = raw.indexOf('=')
    const attribute = (index === -1 ? raw : raw.slice(0, index)).trim().toLowerCase()
    const attributeValue = index === -1 ? '' : raw.slice(index + 1).trim()
    if (attribute === 'domain' && attributeValue !== '') {
      domain = attributeValue.replace(/^\./, '').toLowerCase()
      hostOnly = false
    } else if (attribute === 'path' && attributeValue.startsWith('/')) {
      path = attributeValue
    } else if (attribute === 'max-age') {
      const seconds = Number(attributeValue)
      if (Number.isFinite(seconds)) expires = Math.floor(Date.now() / 1000) + seconds
    } else if (attribute === 'expires' && expires === undefined) {
      const parsed = Date.parse(attributeValue)
      if (Number.isFinite(parsed)) expires = Math.floor(parsed / 1000)
    }
  }
  return { name, value, domain, path, hostOnly, ...expires === undefined ? {} : { expires } }
}

/**
 * The default cookie path for a request URL: the directory of the path.
 *
 * @param {string} url - the request URL.
 * @returns {string} the path.
 */
function defaultPath(url) {
  try {
    const path = new URL(url).pathname
    if (!path.startsWith('/')) return '/'
    const lastSlash = path.lastIndexOf('/')
    return lastSlash <= 0 ? '/' : path.slice(0, lastSlash)
  } catch {
    return '/'
  }
}

/**
 * Whether a cookie's domain covers a host.
 *
 * @param {StoredCookie} cookie - the cookie.
 * @param {string} hostname - the request hostname.
 * @returns {boolean} true when the cookie applies.
 */
function domainMatches(cookie, hostname) {
  const host = hostname.toLowerCase()
  if (cookie.hostOnly) return host === cookie.domain
  return host === cookie.domain || host.endsWith(`.${cookie.domain}`)
}

/**
 * Whether a cookie's path covers a request path.
 *
 * @param {string} cookiePath - the cookie's path.
 * @param {string} requestPath - the request pathname.
 * @returns {boolean} true when the cookie applies.
 */
function pathMatches(cookiePath, requestPath) {
  if (cookiePath === '/' || cookiePath === '') return true
  if (requestPath === cookiePath) return true
  if (!requestPath.startsWith(cookiePath)) return false
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/'
}

/**
 * Normalize a manually supplied `Cookie` header string into stored cookies for
 * one host, so the user can paste what their browser sends without the plugin
 * needing a browser import.
 *
 * @param {string} header - a `Cookie` header value (`a=1; b=2`).
 * @param {string} host - the host the cookies belong to.
 * @returns {StoredCookie[]} the cookies.
 */
export function parseCookieHeader(header, host) {
  /** @type {StoredCookie[]} */
  const cookies = []
  const normalizedHost = host.toLowerCase().replace(/^\./, '')
  for (const chunk of header.split(';')) {
    const separator = chunk.indexOf('=')
    if (separator <= 0) continue
    const name = chunk.slice(0, separator).trim()
    const value = chunk.slice(separator + 1).trim()
    if (name === '') continue
    cookies.push({ name, value, domain: normalizedHost, path: '/', hostOnly: false })
  }
  return cookies
}

/**
 * @typedef {object} BrowserImportOptions
 * @property {string[]} browsers - browser ids to try, in order.
 * @property {string[]} hosts - hosts whose cookies to import.
 */

/**
 * Read cookies for the given hosts from an installed browser.
 *
 * Only the named hosts are queried, and the returned cookies live in the
 * process-local jar. This is best-effort: a browser that is running holds an
 * exclusive lock on its cookie database, and Chromium's cookie encryption is
 * bound to the browser's own profile (v20 app-bound encryption cannot be
 * decrypted outside it), so failure is reported, never worked around.
 *
 * @param {BrowserImportOptions} options - browsers and hosts.
 * @returns {Promise<{ cookies: StoredCookie[], browser: string } | { error: string }>} the import.
 */
export async function importBrowserCookies(options) {
  const { readCookieDatabase } = await import('./browser-cookies.js')
  /** @type {string[]} */
  const reasons = []
  for (const browser of options.browsers) {
    const result = await readCookieDatabase(browser, options.hosts)
    if ('cookies' in result) return { cookies: result.cookies, browser }
    reasons.push(`${browser}: ${result.error}`)
  }
  return { error: reasons.join('；') }
}

/**
 * Turn a cookie configuration into a ready jar.
 *
 * @param {object} config - cookie-related config fields.
 * @param {string} config.cookieBrowser - browser id, or `none`.
 * @param {string} config.cookieHeader - literal `Cookie` header, or empty.
 * @param {string[]} config.sourceHosts - hosts to import for.
 * @returns {Promise<CookieJar>} the jar.
 */
export async function createJar(config) {
  const jar = new CookieJar()
  if (config.cookieBrowser !== 'none') {
    const imported = await importBrowserCookies({ browsers: [config.cookieBrowser], hosts: config.sourceHosts })
    if ('cookies' in imported) jar.import(imported.cookies)
  }
  if (config.cookieHeader.trim() !== '') {
    for (const host of config.sourceHosts) jar.import(parseCookieHeader(config.cookieHeader, host))
  }
  return jar
}

/**
 * Perform a source's warm-up visit so the jar receives its session cookies.
 *
 * A warm-up failure is not a search failure: the search request is still
 * attempted, and its own classification decides the outcome.
 *
 * @param {CookieJar} jar - the jar to populate.
 * @param {string} url - the page to visit.
 * @param {object} options - request bounds.
 * @param {number} options.timeoutMs - deadline.
 * @param {AbortSignal} [options.signal] - caller cancellation.
 * @returns {Promise<void>} settlement after the visit.
 */
export async function warmUp(jar, url, options) {
  const controller = new AbortController()
  const detach = options.signal === undefined ? () => {} : attach(options.signal, controller)
  const timer = setTimeout(() => controller.abort(new Error('warm-up timeout')), Math.min(options.timeoutMs, 8000))
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'upgrade-insecure-requests': '1',
      },
    })
    jar.absorb(response, response.url === '' ? url : response.url)
    await response.body?.cancel().catch(() => {})
  } catch (error) {
    if (options.signal?.aborted === true) throw error
    // Warm-up is opportunistic.
  } finally {
    clearTimeout(timer)
    detach()
  }
}

/**
 * Relay an outer signal onto a controller.
 *
 * @param {AbortSignal} signal - the caller's signal.
 * @param {AbortController} controller - the controller to abort.
 * @returns {() => void} detaches the relay.
 */
function attach(signal, controller) {
  if (signal.aborted) {
    controller.abort(signal.reason)
    return () => {}
  }
  const abort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  return () => signal.removeEventListener('abort', abort)
}

/**
 * Failure for a cookie configuration that cannot work, so it is reported once
 * instead of as a mysterious verification wall.
 *
 * @param {string} detail - what is wrong.
 * @returns {Error} the failure.
 */
export function cookieFailure(detail) {
  return failure('blocked', detail, { source: 'Cookie' })
}