/**
 * The free local fetch backend: one URL in, structured article content out.
 *
 * Output is a JSON-shaped record (`url`, `title`, `content`, links, truncation),
 * not raw HTML: the caller asked for readable content. A non-2xx response is a
 * failure here rather than a "descriptive result", because this layer exists to
 * hand back extracted content and an error page has none.
 *
 * @module cube-dsh-free/fetch
 */

import { failure } from './errors.js'
import { anchors, extractContent } from './html.js'
import { requestPage } from './transport.js'

/**
 * @typedef {object} FetchOptions
 * @property {number} maxChars - body character cap.
 * @property {number} maxBytes - response byte cap.
 * @property {number} timeoutMs - whole-request deadline.
 * @property {number} maxLinks - related-link cap (0 disables).
 * @property {boolean} keepNoise - keep navigation, sidebars, footers.
 */

/**
 * @typedef {object} FetchOutcome
 * @property {'html' | 'text'} kind - whether the body was extracted from HTML.
 * @property {string} url - final URL.
 * @property {number} status - HTTP status.
 * @property {string} title - document title.
 * @property {string} content - readable body.
 * @property {Array<{ url: string, text: string }>} links - related links.
 * @property {boolean} truncated - whether a cap cut the body.
 */

/** Media types that are already text and need no extraction. */
const PLAIN_TYPES = new Set(['text/plain', 'text/markdown', 'text/x-markdown', 'application/json', 'text/csv'])

/**
 * Retrieve one URL and extract readable content.
 *
 * @param {string} url - absolute HTTP(S) URL.
 * @param {FetchOptions} options - bounds.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<FetchOutcome>} the extracted page.
 */
export async function fetchLocal(url, options, signal) {
  const target = parseTarget(url)
  const page = await requestPage(target, {
    profile: 'document',
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    // Extraction needs the whole document, not the returned-body cap: the cap
    // applies to the text handed back, and truncating the source first would
    // cut the article's own main region off.
    maxChars: Math.max(options.maxChars * 6, 500_000),
    source: '本地抓取',
    signal,
  })
  if (PLAIN_TYPES.has(page.contentType)) {
    const content = page.text.length > options.maxChars ? page.text.slice(0, options.maxChars) : page.text
    if (content.trim() === '') throw failure('empty', `${target} 返回空文本`, { source: '本地抓取' })
    return {
      kind: 'text',
      url: page.url,
      status: page.status,
      title: '',
      content,
      links: [],
      truncated: page.truncated || content.length !== page.text.length,
    }
  }
  if (isBinary(page.contentType)) {
    throw failure('parse', `${target} 的内容类型是 ${page.contentType}，不是可提取的文本页面`, { source: '本地抓取' })
  }
  if (!looksLikeMarkup(page.text)) {
    throw failure('parse', `${target} 返回的内容不是 HTML 文档（${page.contentType || 'unknown'}）`, { source: '本地抓取' })
  }
  const extracted = extractContent(page.text, { maxChars: options.maxChars, keepNoise: options.keepNoise })
  if (extracted.text.trim() === '') {
    throw failure(
      'empty',
      `${target} 解析成功但没有可提取的正文（页面可能由 JavaScript 渲染）`,
      { source: '本地抓取' },
    )
  }
  const links = options.maxLinks > 0 ? relatedLinks(page.text, page.url, options.maxLinks) : []
  return {
    kind: 'html',
    url: page.url,
    status: page.status,
    title: extracted.title,
    content: extracted.text,
    links,
    truncated: page.truncated || extracted.truncated,
  }
}

/**
 * Validate the request URL, rejecting anything that is not plain HTTP(S).
 *
 * A fetch tool is not a file reader, and `data:` / `file:` URLs would let a
 * model read local files through this backend.
 *
 * @param {string} url - the requested URL.
 * @returns {string} the normalized URL.
 */
function parseTarget(url) {
  const trimmed = url.trim()
  if (trimmed === '') throw failure('request', 'URL 为空', { source: '本地抓取' })
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch (error) {
    throw failure('request', `不是合法的 URL：${trimmed}`, { cause: error, source: '本地抓取' })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw failure('request', `只支持 http/https，收到 ${parsed.protocol.replace(':', '')}`, { source: '本地抓取' })
  }
  return parsed.toString()
}

/**
 * Whether a media type is a binary payload we cannot turn into text.
 *
 * @param {string} contentType - the media type.
 * @returns {boolean} true for images, archives, media, and documents.
 */
function isBinary(contentType) {
  if (contentType === '') return false
  if (contentType.startsWith('text/')) return false
  if (contentType.includes('html') || contentType.includes('xml') || contentType.includes('json')) return false
  return /^(image|audio|video|font|application\/(pdf|zip|gzip|x-tar|x-7z|octet-stream|vnd\.|msword|epub))/.test(contentType)
}

/**
 * Whether a body looks like markup rather than a plain-text file served with an
 * HTML content type.
 *
 * @param {string} text - the body.
 * @returns {boolean} true when it carries tags.
 */
function looksLikeMarkup(text) {
  const head = text.slice(0, 2048).trimStart().toLowerCase()
  if (head.startsWith('<!doctype') || head.startsWith('<html')) return true
  return /<(p|div|body|head|article|section|main|h1|h2|table|ul|ol)\b/.test(text.slice(0, 8192).toLowerCase())
}

/**
 * Collect links worth showing as related material: absolute HTTP(S) links,
 * de-duplicated, skipping the page's own URL and asset requests.
 *
 * @param {string} html - the document.
 * @param {string} baseUrl - the final URL.
 * @param {number} limit - maximum links.
 * @returns {Array<{ url: string, text: string }>} the links.
 */
function relatedLinks(html, baseUrl, limit) {
  /** @type {Set<string>} */
  const seen = new Set()
  for (const anchor of anchors(html, baseUrl)) {
    if (anchor.url === baseUrl) continue
    if (/\.(png|jpe?g|gif|webp|svg|css|js|ico|woff2?|ttf|eot)(\?|$)/i.test(anchor.url)) continue
    seen.add(anchor.url)
    if (seen.size >= limit) break
  }
  return [...seen].map(url => ({ url, text: '' }))
}