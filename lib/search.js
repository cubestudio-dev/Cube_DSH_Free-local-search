/**
 * The free local search backend.
 *
 * Contract: one query in, `{ sources }` out with at least one result, or a
 * classified failure. Never an empty list — "no results" is a failure the
 * caller can route on, because a silent empty list reads to the model as "the
 * web has nothing", which is a different and false statement.
 *
 * Session handling: before a source's first request, its landing page is
 * visited once so the cookie jar receives that source's session cookies, and
 * every request in the chain carries the jar and feeds new cookies back. This
 * is what turns a verification wall into results on sources that gate cold
 * traffic (measured on Baidu).
 *
 * Paging: a source's own next-page link is followed when it publishes one
 * (Bing's pager link carries the session token its `first=` parameter needs);
 * otherwise the source's documented offset parameter advances. Results are
 * de-duplicated by URL across pages, so a source that ignores its offset
 * parameter yields one page's worth rather than the same page repeated.
 *
 * @module cube-dsh-free/search
 */

import { failure } from './errors.js'
import { classifyInterstitial, normalizeHit, sourceById } from './sources.js'
import { requestPage } from './transport.js'
import { warmUp } from './cookies.js'

/**
 * @typedef {object} SearchOptions
 * @property {readonly string[]} sourceIds - adapters to try, in order.
 * @property {number} maxResults - the caller's source cap.
 * @property {number} maxPages - page cap per source.
 * @property {number} timeoutMs - per-request deadline.
 * @property {number} maxBytes - response byte cap.
 * @property {number} maxChars - decoded character cap.
 * @property {number} [pageSize] - results per page, used to advance offsets.
 * @property {import('./cookies.js').CookieJar} [jar] - shared session jar (used when jarsBySource is absent).
 * @property {Map<string, import('./cookies.js').CookieJar>} [jarsBySource] - one jar per source id, so each engine searches with its own session.
 * @property {Map<string, import('./sources.js').SearchSource>} [customAdapters] - user-declared sources, by id.
 * @property {boolean} [warmUp] - visit each source's landing page first.
 */

/**
 * @typedef {object} SearchOutcome
 * @property {Array<{ url: string, title: string, snippet?: string }>} sources - results.
 * @property {boolean} truncated - whether the cap cut results.
 * @property {string} sourceId - the adapter that produced the results.
 */

/**
 * Run one query through the configured source chain.
 *
 * Each source is tried in order. A source that fails is recorded and the next
 * one is attempted; when every source fails, the error names each source's own
 * outcome so the caller can tell a block from an outage from an empty page.
 *
 * @param {string} query - the query text.
 * @param {SearchOptions} options - sources and bounds.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<SearchOutcome>} the results.
 */
export async function searchLocal(query, options, signal) {
  const trimmed = query.trim()
  if (trimmed === '') throw failure('empty', '查询为空', { source: '本地搜索' })
  /** @type {string[]} */
  const attempts = []
  let sawEmpty = false
  let sawBlocked = false
  let sawParse = false
  for (const sourceId of options.sourceIds) {
    // A custom source may not shadow a built-in id (config rejects that), so the
    // order here only decides who answers for an id, and it is never ambiguous.
    const source = options.customAdapters?.get(sourceId) ?? sourceById(sourceId)
    if (source === undefined) {
      attempts.push(`${sourceId}: 未实现的搜索源`)
      sawParse = true
      continue
    }
    const attempt = await runSource(source, trimmed, options, signal)
    if (attempt.ok) return attempt.outcome
    attempts.push(`${source.label} ${attempt.reason}`)
    if (attempt.code === 'CUBE_WEB_EMPTY') sawEmpty = true
    if (attempt.code === 'CUBE_WEB_BLOCKED') sawBlocked = true
    if (attempt.code === 'CUBE_WEB_UNPARSABLE') sawParse = true
  }
  // The composed failure takes the *most actionable* classification: an
  // outright block outranks an empty page, which outranks a parse problem.
  const kind = sawBlocked ? 'blocked' : sawEmpty ? 'empty' : sawParse ? 'parse' : 'request'
  const anyJar = options.jar !== undefined || (options.jarsBySource !== undefined && options.jarsBySource.size > 0)
  const hint = sawBlocked && !anyJar
    ? '（未启用 cookie；可开启 cookieBrowser 或提供 cookieHeader 以使用带会话的请求）'
    : ''
  throw failure(
    kind,
    `“${trimmed}”在所有搜索源都没有拿到结果 —— ${attempts.join('；')}${hint}`,
    { source: '本地搜索' },
  )
}

/**
 * Try one source: warm it up once, then page through it until the cap is
 * reached or it stops producing new URLs.
 *
 * @param {import('./sources.js').SearchSource} source - the adapter.
 * @param {string} query - the query text.
 * @param {SearchOptions} options - bounds.
 * @param {AbortSignal | undefined} signal - caller cancellation.
 * @returns {Promise<{ ok: true, outcome: SearchOutcome } | { ok: false, code: string, reason: string }>}
 *   the attempt's result.
 */
async function runSource(source, query, options, signal) {
  // Per-source jars win over the shared one: sending Baidu cookies to Bing is
  // not a session, it is noise the other engine may read as a forged request.
  const jar = options.jarsBySource?.get(source.id) ?? options.jar
  if (options.warmUp === true && jar !== undefined) {
    for (const url of source.warmUp) {
      await warmUp(jar, url, { timeoutMs: options.timeoutMs, signal })
    }
  }
  /** @type {Map<string, { url: string, title: string, snippet?: string }>} */
  const collected = new Map()
  const pageSize = options.pageSize ?? 10
  let pageUrl = source.pageUrl(query, 0)
  let pages = 0
  /** @type {{ code: string, reason: string } | undefined} */
  let lastFailure
  while (pages < options.maxPages && collected.size < options.maxResults) {
    let page
    try {
      page = await requestPage(pageUrl, {
        profile: 'search',
        timeoutMs: options.timeoutMs,
        maxBytes: options.maxBytes,
        maxChars: options.maxChars,
        source: source.label,
        signal,
        jar,
      })
    } catch (error) {
      if (signal?.aborted === true) throw error
      lastFailure = classifyAttempt(error)
      break
    }
    if (!looksLikeHtml(page)) {
      lastFailure = { code: 'CUBE_WEB_UNPARSABLE', reason: `响应类型 ${page.contentType || 'unknown'} 不是 HTML` }
      break
    }
    let parsed
    try {
      parsed = source.parse(page.text, pageUrl)
    } catch (error) {
      lastFailure = { code: 'CUBE_WEB_UNPARSABLE', reason: shortMessage(error) }
      break
    }
    if (parsed.hits.length === 0) {
      // No blocks at all: the page is either a wall, a source-side error, or a
      // genuine no-results page. Classify before deciding what to report.
      const interstitial = classifyInterstitial(page.text)
      if (interstitial === 'blocked') {
        lastFailure = { code: 'CUBE_WEB_BLOCKED', reason: `返回了验证/拦截页（HTTP ${page.status}）` }
        break
      }
      if (interstitial === 'request') {
        lastFailure = { code: 'CUBE_WEB_REQUEST_FAILED', reason: '来源返回了它自己的错误页（可重试）' }
        break
      }
    }
    let added = 0
    for (const hit of parsed.hits) {
      const normalized = normalizeHit(hit)
      if (normalized === undefined) continue
      if (collected.has(normalized.url)) continue
      collected.set(normalized.url, normalized)
      added += 1
      if (collected.size >= options.maxResults) break
    }
    pages += 1
    if (collected.size >= options.maxResults) break
    // A page that contributed nothing new means the source exhausted its
    // results (or ignored the offset); either way another page is futile.
    if (added === 0) break
    const nextUrl = parsed.nextUrl ?? offsetUrl(source, query, pages * pageSize)
    if (nextUrl === undefined || nextUrl === pageUrl) break
    pageUrl = nextUrl
  }
  if (collected.size === 0) {
    if (lastFailure !== undefined) return { ok: false, ...lastFailure }
    return { ok: false, code: 'CUBE_WEB_EMPTY', reason: '解析成功但没有结果' }
  }
  return {
    ok: true,
    outcome: {
      sources: [...collected.values()].slice(0, options.maxResults),
      truncated: collected.size >= options.maxResults,
      sourceId: source.id,
    },
  }
}

/**
 * Build a next-page URL from the source's offset parameter.
 *
 * @param {import('./sources.js').SearchSource} source - the adapter.
 * @param {string} query - the query text.
 * @param {number} offset - absolute result offset.
 * @returns {string | undefined} the next page URL.
 */
function offsetUrl(source, query, offset) {
  try {
    const url = source.pageUrl(query, offset)
    return url === '' ? undefined : url
  } catch {
    return undefined
  }
}

/**
 * Whether a response is plausibly an HTML document.
 *
 * @param {{ contentType: string, text: string }} page - the fetched page.
 * @returns {boolean} true for HTML.
 */
function looksLikeHtml(page) {
  if (page.contentType === '' || page.contentType.includes('html') || page.contentType.includes('xml')) return true
  const head = page.text.slice(0, 512).trimStart().toLowerCase()
  return head.startsWith('<!doctype') || head.startsWith('<html') || head.includes('<body') || head.includes('<div')
}

/**
 * Map a thrown failure to the attempt vocabulary.
 *
 * @param {unknown} error - caught value.
 * @returns {{ code: string, reason: string }} the classification.
 */
function classifyAttempt(error) {
  const code = /** @type {any} */ (error)?.code
  return {
    code: typeof code === 'string' && code.startsWith('CUBE_WEB_') ? code : 'CUBE_WEB_REQUEST_FAILED',
    reason: shortMessage(error),
  }
}

/**
 * One-line message for a failure, bounded.
 *
 * @param {unknown} error - caught value.
 * @returns {string} a short reason.
 */
function shortMessage(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 180 ? `${message.slice(0, 180)}…` : message
}