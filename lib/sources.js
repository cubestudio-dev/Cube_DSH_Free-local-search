/**
 * Public search-result adapters.
 *
 * Every adapter reads a public HTML results page, never a paid API. They share
 * one output contract — `{ url, title, snippet }` with `url` required — and
 * differ only in how a results page is read and how its next page is reached.
 *
 * Adapters are pure functions over a fetched page, so a source can be added,
 * replaced, or reordered by configuration without touching the search pipeline.
 *
 * @module cube-dsh-free/sources
 */

import { absoluteUrl, collapseWhitespace, innerOfFirst, regions, toText } from './html.js'

/**
 * @typedef {object} SearchHit
 * @property {string} url - absolute http(s) result URL.
 * @property {string} title - result title.
 * @property {string} snippet - result summary, possibly empty.
 */

/**
 * @typedef {object} SourcePage
 * @property {SearchHit[]} hits - parsed results in page order.
 * @property {string | undefined} nextUrl - the source's own next-page URL.
 */

/**
 * Read a results page and, when the source exposes one, its next-page URL.
 *
 * A source's optional warm-up: visiting its landing page first is what makes
 * the search request look like a session rather than a cold bot hit, and it is
 * what issues the session cookies the search then carries.
 *
 * @typedef {object} SearchSource
 * @property {string} id - stable source key used by configuration.
 * @property {string} label - human name used in failure messages.
 * @property {string[]} hosts - hosts this source reads, used for cookie import.
 * @property {string[]} warmUp - landing pages to visit before the first search.
 * @property {(query: string, page: number) => string} pageUrl - build a page URL.
 * @property {(html: string, pageUrl: string) => SourcePage} parse - read a page.
 */

/**
 * Build the URL for one page of results.
 *
 * @param {string} template - URL prefix, with `{query}` and `{offset}` slots.
 * @param {string} query - raw query text.
 * @param {number} offset - zero-based result offset.
 * @returns {string} the page URL.
 */
function fill(template, query, offset) {
  return template.replace('{query}', encodeURIComponent(query)).replace('{offset}', String(offset))
}

/**
 * Verification walls, captchas, and consent gates. These mean "this source will
 * not serve you"; retrying the same source is pointless.
 */
const BLOCK_MARKERS = [
  /安全验证/,
  /请输入验证码/,
  /人机验证/,
  /访问过于频繁/,
  /异常请求/,
  /verify you are human/i,
  /unusual traffic/i,
  /are you a robot/i,
  /请完成下方验证/i,
  /antispider/i,
  /captcha/i,
]

/**
 * Transient source-side error pages: the source answered, but with its own
 * "try again" document rather than results. Distinct from a block because the
 * caller's right move is to retry later, not to change source.
 */
const TRANSIENT_MARKERS = [
  /网络不给力/,
  /请稍后重试/,
  /系统繁忙/,
  /暂时无法访问/,
  /try again later/i,
  /service unavailable/i,
]

/**
 * Classify a page that yielded no results.
 *
 * Called only after parsing produced nothing, which is what keeps these broad
 * markers from misfiring on an article that merely mentions "captcha": a page
 * is only a wall when it also carries no result blocks.
 *
 * @param {string} html - the page.
 * @returns {'blocked' | 'request' | undefined} the classification, or undefined
 *   when the page is a normal results page with nothing to show.
 */
export function classifyInterstitial(html) {
  // A results page always carries result blocks; markers inside one are noise.
  if (html.length > 20000 && /<h[23]\b/i.test(html) && /class\s*=\s*"[^"]*(?:result|res-list|b_algo|vrwrap)/i.test(html)) {
    return undefined
  }
  for (const pattern of BLOCK_MARKERS) {
    if (pattern.test(html)) return 'blocked'
  }
  for (const pattern of TRANSIENT_MARKERS) {
    if (pattern.test(html)) return 'request'
  }
  if (html.length < 4096) return 'request'
  return undefined
}

/**
 * Read the first anchor inside an `<h2>`/`<h3>` heading of a result block.
 *
 * @param {string} block - one result's outer HTML.
 * @param {string[]} headingTags - heading tags to try, in order.
 * @returns {{ url: string | undefined, title: string }} the heading anchor.
 */
function headingAnchor(block, headingTags) {
  for (const tag of headingTags) {
    const heading = innerOfFirst(block, tag)
    if (heading === undefined) continue
    const match = /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(heading.inner)
    if (match === null) continue
    const href = /href\s*=\s*"([^"]*)"/i.exec(match[1])?.[1] ?? /href\s*=\s*'([^']*)'/i.exec(match[1])?.[1]
    return { url: href === undefined ? undefined : absoluteUrl(href, undefined), title: toText(match[2]) }
  }
  return { url: undefined, title: '' }
}

/**
 * Read every anchor's href in a block, for sources that publish the real target
 * in a data attribute rather than in `href`.
 *
 * @param {string} block - one result's outer HTML.
 * @returns {string[]} absolute URLs found.
 */
function allHrefs(block) {
  /** @type {string[]} */
  const out = []
  for (const match of block.matchAll(/href\s*=\s*"([^"]+)"/gi)) {
    const url = absoluteUrl(match[1], undefined)
    if (url !== undefined) out.push(url)
  }
  return out
}

/** Bing: `li.b_algo`, title in `h2 a`, summary in `.b_caption`. */
/** @type {SearchSource} */
export const bing = {
  id: 'bing',
  label: '必应',
  hosts: ['bing.com', 'cn.bing.com', 'www.bing.com'],
  warmUp: ['https://www.bing.com/'],
  pageUrl: (query, offset) => fill('https://www.bing.com/search?q={query}&count=30&first={offset}', query, offset + 1),
  parse(html, pageUrl) {
    /** @type {SearchHit[]} */
    const hits = []
    for (const block of regions(html, tag => tag.name === 'li' && /(^|\s)b_algo(\s|$)/.test(tag.attributes.class ?? ''))) {
      const anchor = headingAnchor(block, ['h2'])
      if (anchor.url === undefined) continue
      // The summary lives in `.b_caption` (usually its `<p>`); sites that only
      // publish a byline still get the caption text as the snippet.
      const caption = innerOfFirst(block, 'div')
      const captionText = caption === undefined ? '' : toText(caption.inner)
      const paragraph = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block)
      const snippet = paragraph === null ? captionText : toText(paragraph[1])
      hits.push({ url: anchor.url, title: anchor.title, snippet: snippet.length > 0 ? snippet : captionText })
    }
    const next = /<a\b[^>]*class\s*=\s*"[^"]*sb_pagN[^"]*"[^>]*href\s*=\s*"([^"]+)"/i.exec(html)
      ?? /<a\b[^>]*href\s*=\s*"([^"]+)"[^>]*class\s*=\s*"[^"]*sb_pagN[^"]*"/i.exec(html)
    const nextUrl = next === null ? undefined : absoluteUrl(next[1].replace(/&amp;/g, '&'), pageUrl)
    return { hits, nextUrl }
  },
}

/** 360 搜索: `li.res-list`, title in `h3 a`, real target in `data-mdurl`. */
/** @type {SearchSource} */
export const so360 = {
  id: '360',
  label: '360 搜索',
  hosts: ['so.com', 'www.so.com'],
  warmUp: ['https://www.so.com/'],
  pageUrl: (query, offset) => fill('https://www.so.com/s?q={query}&pn={offset}', query, Math.floor(offset / 10) + 1),
  parse(html, pageUrl) {
    /** @type {SearchHit[]} */
    const hits = []
    for (const block of regions(html, tag => tag.name === 'li' && /(^|\s)res-list(\s|$)/.test(tag.attributes.class ?? ''))) {
      const heading = innerOfFirst(block, 'h3')
      if (heading === undefined) continue
      const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(heading.inner)
      if (anchor === null) continue
      // The anchor href is a redirector; `data-mdurl` carries the target.
      const target = /data-mdurl\s*=\s*"([^"]+)"/i.exec(anchor[1])?.[1]
      const url = target === undefined
        ? allHrefs(block).find(candidate => !isRedirectHost(candidate, ['so.com']))
        : absoluteUrl(target, pageUrl)
      if (url === undefined || isRedirectHost(url, ['so.com'])) continue
      const title = toText(anchor[2])
      hits.push({ url, title, snippet: fallbackSnippet(block, title) })
    }
    const next = /<a\b[^>]*id\s*=\s*"snext"[^>]*href\s*=\s*"([^"]+)"/i.exec(html)
    return { hits, nextUrl: next === null ? undefined : absoluteUrl(next[1].replace(/&amp;/g, '&'), pageUrl) }
  },
}

/** 百度: result blocks carry the real target in `mu="…"`. */
/** @type {SearchSource} */
export const baidu = {
  id: 'baidu',
  label: '百度',
  hosts: ['baidu.com', 'www.baidu.com'],
  warmUp: ['https://www.baidu.com/'],
  pageUrl: (query, offset) => fill('https://www.baidu.com/s?wd={query}&rn=10&pn={offset}', query, offset),
  parse(html, pageUrl) {
    /** @type {SearchHit[]} */
    const hits = []
    const blocks = regions(
      html,
      tag => tag.name === 'div' && /(^|\s)(result-molecule|result-op|c-container)(\s|$)/.test(tag.attributes.class ?? ''),
    )
    for (const block of blocks) {
      const heading = innerOfFirst(block, 'h3')
      if (heading === undefined) continue
      const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(heading.inner)
      if (anchor === null) continue
      const declared = /\bmu\s*=\s*"([^"]+)"/i.exec(anchor[1])?.[1] ?? /\bmu\s*=\s*"([^"]+)"/i.exec(block)?.[1]
      const url = declared === undefined
        ? allHrefs(block).find(candidate => !isRedirectHost(candidate, ['baidu.com']))
        : absoluteUrl(declared, pageUrl)
      if (url === undefined || isRedirectHost(url, ['baidu.com'])) continue
      const title = toText(anchor[2])
      // Baidu hashes its class names, so the summary selector is unreliable;
      // the generic longest-run heuristic is stable across redesigns.
      hits.push({ url, title, snippet: fallbackSnippet(block, title) })
    }
    return { hits, nextUrl: undefined }
  },
}

/** 搜狗: `div.vrwrap`, title in `h3 a`. Interstitials are common. */
/** @type {SearchSource} */
export const sogou = {
  id: 'sogou',
  label: '搜狗',
  hosts: ['sogou.com', 'www.sogou.com'],
  warmUp: ['https://www.sogou.com/'],
  pageUrl: (query, offset) => fill('https://www.sogou.com/web?query={query}&page={offset}', query, Math.floor(offset / 10) + 1),
  parse(html, pageUrl) {
    /** @type {SearchHit[]} */
    const hits = []
    for (const block of regions(html, tag => tag.name === 'div' && /(^|\s)vrwrap(\s|$)/.test(tag.attributes.class ?? ''))) {
      const anchor = headingAnchor(block, ['h3', 'h2'])
      if (anchor.url === undefined || isRedirectHost(anchor.url, ['sogou.com'])) continue
      hits.push({ url: anchor.url, title: anchor.title, snippet: fallbackSnippet(block, anchor.title) })
    }
    return { hits, nextUrl: undefined }
  },
}

/** DuckDuckGo HTML endpoint: `a.result__a`, summary in `.result__snippet`. */
/** @type {SearchSource} */
export const duckduckgo = {
  id: 'duckduckgo',
  label: 'DuckDuckGo',
  hosts: ['duckduckgo.com', 'html.duckduckgo.com'],
  warmUp: [],
  pageUrl: (query, offset) => fill('https://html.duckduckgo.com/html/?q={query}&s={offset}', query, offset),
  parse(html, pageUrl) {
    /** @type {SearchHit[]} */
    const hits = []
    for (const block of regions(html, tag => tag.name === 'div' && /(^|\s)result(\s|$)/.test(tag.attributes.class ?? ''))) {
      const anchor = /<a\b[^>]*class\s*=\s*"[^"]*result__a[^"]*"[^>]*href\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
      if (anchor === null) continue
      const url = decodeDuckDuckGoTarget(anchor[1])
      if (url === undefined) continue
      const snippet = /class\s*=\s*"[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
      hits.push({ url, title: toText(anchor[2]), snippet: snippet === null ? '' : toText(snippet[1]) })
    }
    const next = /<a\b[^>]*class\s*=\s*"[^"]*result__a[^"]*"[^>]*href\s*=\s*"([^"]+)"[\s\S]*?nav-link/i.exec(html)
    return { hits, nextUrl: next === null ? undefined : absoluteUrl(next[1].replace(/&amp;/g, '&'), 'https://html.duckduckgo.com') }
  },
}

/**
 * DuckDuckGo wraps results in `/l/?uddg=…`; unwrap to the target.
 *
 * @param {string} href - raw href.
 * @returns {string | undefined} the target URL.
 */
function decodeDuckDuckGoTarget(href) {
  const absolute = absoluteUrl(href, 'https://html.duckduckgo.com')
  if (absolute === undefined) return undefined
  try {
    const url = new URL(absolute)
    const wrapped = url.searchParams.get('uddg')
    if (wrapped !== null) return absoluteUrl(decodeURIComponent(wrapped), undefined)
    return absolute
  } catch {
    return undefined
  }
}

/**
 * Whether a URL points at a search engine's own redirector.
 *
 * @param {string} url - candidate URL.
 * @param {string[]} hosts - redirector registrable hosts.
 * @returns {boolean} true for a redirector URL.
 */
function isRedirectHost(url, hosts) {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return hosts.some(candidate => host === candidate || host.endsWith(`.${candidate}`))
  } catch {
    return true
  }
}

/**
 * Pick a summary from a result block when the source's own summary selector is
 * unknown or absent.
 *
 * Sites hash their class names, so a selector-based summary breaks on every
 * redesign. Instead every text run in the block is a candidate, the title's own
 * text is dropped, and the longest remaining prose run wins — a summary is by
 * construction the longest non-title text a result block carries.
 *
 * @param {string} block - one result's outer HTML.
 * @param {string} title - the result title, excluded from candidates.
 * @returns {string} the chosen summary, possibly empty.
 */
function fallbackSnippet(block, title) {
  const normalizedTitle = collapseWhitespace(title)
  /** @type {string[]} */
  const candidates = []
  for (const match of block.matchAll(/<(p|span|div|em|cite|font)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = toText(match[2])
    if (text.length < 16 || text.length > 480) continue
    if (text === normalizedTitle || normalizedTitle.includes(text)) continue
    if (/^(https?:\/\/|www\.)/i.test(text)) continue
    candidates.push(text)
  }
  if (candidates.length === 0) {
    const whole = toText(block)
    const stripped = normalizedTitle === '' ? whole : whole.replace(normalizedTitle, '').trim()
    return stripped.slice(0, 320)
  }
  candidates.sort((left, right) => right.length - left.length)
  return candidates[0]
}

/** Every adapter, keyed by its configuration id. */
export const SOURCES = Object.freeze({
  bing,
  '360': so360,
  baidu,
  sogou,
  duckduckgo,
})

/** Source ids in the order a fallback chain should try them by default. */
export const DEFAULT_SOURCE_ORDER = Object.freeze(['bing', '360', 'baidu', 'duckduckgo', 'sogou'])

/**
 * Resolve a configured source id to its adapter.
 *
 * @param {string} id - configured id.
 * @returns {SearchSource | undefined} the adapter.
 */
export function sourceById(id) {
  return SOURCES[id]
}

/**
 * Every host the configured sources read, for cookie import.
 *
 * @param {readonly string[]} sourceIds - configured source ids.
 * @param {Map<string, SearchSource>} [customAdapters] - user-declared sources.
 * @returns {string[]} the hosts.
 */
export function sourceHosts(sourceIds, customAdapters) {
  /** @type {string[]} */
  const hosts = []
  for (const id of sourceIds) {
    // A user-declared source carries its own hosts; without this, a browser
    // import and the per-source cookie jar would both skip it.
    const source = customAdapters?.get(id) ?? SOURCES[id]
    if (source === undefined) continue
    for (const host of source.hosts) if (!hosts.includes(host)) hosts.push(host)
  }
  return hosts
}

/**
 * Normalize one hit: require an http(s) URL, collapse text, and drop empty
 * titles down to the hostname so the model always has a label.
 *
 * @param {SearchHit} hit - parsed hit.
 * @returns {SearchHit | undefined} the normalized hit, or undefined to drop.
 */
export function normalizeHit(hit) {
  const url = absoluteUrl(hit.url, undefined)
  if (url === undefined) return undefined
  const title = collapseWhitespace(hit.title)
  const snippet = collapseWhitespace(hit.snippet).slice(0, 320)
  let label = title
  if (label === '') {
    try {
      label = new URL(url).hostname
    } catch {
      label = url
    }
  }
  return { url, title: label, snippet }
}