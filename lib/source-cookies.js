/**
 * Per-source cookie configuration: recognising which engine a pasted cookie
 * belongs to, and building one jar per source.
 *
 * Why per-source rather than one global header: a `Cookie` header is scoped to
 * a host. Pasting Baidu's `BAIDUID` into a request to Bing sends a cookie that
 * the receiving site ignores at best and reads as a forged session at worst.
 * Each engine also needs different names — Baidu answers to `BAIDUID`/`BDUSS`,
 * Sogou to `SUID`/`SUV`, Bing to `MUID`/`_EDGE_S`, 360 to `QiHooGUID`. Sending
 * all of them everywhere is noise; sending the right subset to each host is what
 * makes the session real.
 *
 * The recogniser reads only names and shapes, never values, and its verdict is
 * always shown to the user before it is used.
 *
 * @module cube-dsh-free/source-cookies
 */

import { CookieJar, parseCookieHeader } from './cookies.js'

/**
 * Marker cookies per source, strongest first.
 *
 * These names are stable across the engines' login and anonymous sessions and
 * are never set by the others, so a single match identifies the origin. The
 * list is deliberately short: a long list of weak guesses turns a confident
 * match into a coin flip.
 */
export const MARKERS = Object.freeze({
  baidu: Object.freeze(['BAIDUID', 'BAIDUID_BFESS', 'BDUSS', 'BDUSS_BFESS', 'STOKEN', 'PSTM', 'ZFY']),
  sogou: Object.freeze(['SUID', 'SUV', 'SNUID', 'IPLOC', 'PPUV']),
  bing: Object.freeze(['MUID', '_EDGE_S', '_EDGE_CD', 'SRCHHPGUSR', '_U', 'SUID_BING']),
  360: Object.freeze(['QiHooGUID', 'QH_SESSION_ID', '__guid', 'count']),
  duckduckgo: Object.freeze(['duckduckgo', 'vqd', 'dcr', 'ah']),
})

/**
 * Hosts each source owns, for assigning a cookie to a jar.
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const SOURCE_HOSTS = Object.freeze({
  baidu: Object.freeze(['baidu.com', 'www.baidu.com']),
  sogou: Object.freeze(['sogou.com', 'www.sogou.com']),
  bing: Object.freeze(['bing.com', 'cn.bing.com', 'www.bing.com']),
  360: Object.freeze(['so.com', 'www.so.com']),
  duckduckgo: Object.freeze(['duckduckgo.com', 'html.duckduckgo.com']),
})

/**
 * @typedef {object} CookieVerdict
 * @property {string | undefined} source - recognised source id, or undefined.
 * @property {number} matched - how many marker names hit.
 * @property {string[]} names - cookie names the input contained, in order.
 * @property {string} reason - a sentence the settings page can show.
 */

/**
 * Recognise which engine a pasted `Cookie` header came from.
 *
 * Scores every source by how many of its marker names appear, and returns the
 * strongest when it is unambiguous. A tie is reported as unrecognised rather
 * than guessed, because assigning a session to the wrong host silently produces
 * a request that looks logged in and is not.
 *
 * @param {string} header - a `Cookie` header value (`a=1; b=2`).
 * @returns {CookieVerdict} the verdict.
 */
export function recogniseSource(header) {
  const names = cookieNames(header)
  if (names.length === 0) {
    return { source: undefined, matched: 0, names, reason: '没有识别出 cookie 名' }
  }

  /** @type {Array<{ id: string, hits: number }>} */
  const scored = []
  for (const [id, markers] of Object.entries(MARKERS)) {
    const hits = names.filter(name => markers.includes(name)).length
    if (hits > 0) scored.push({ id, hits })
  }
  scored.sort((a, b) => b.hits - a.hits)

  if (scored.length === 0) {
    return { source: undefined, matched: 0, names, reason: '这些 cookie 名不属于任何已知搜索源' }
  }
  const [best, second] = scored
  if (second !== undefined && second.hits === best.hits) {
    return {
      source: undefined,
      matched: best.hits,
      names,
      reason: `同时像 ${labelOf(best.id)} 和 ${labelOf(second.id)}，无法确定来源`,
    }
  }
  return {
    source: best.id,
    matched: best.hits,
    names,
    reason: `识别为 ${labelOf(best.id)}（命中 ${best.hits} 个特征 cookie）`,
  }
}

/**
 * Recognise a header, falling back to the source whose host appears in a
 * full URL or `Cookie:` line pasted by mistake.
 *
 * Users paste three different things: a bare header, a `cookie:` line copied
 * from DevTools, and occasionally a whole request line. Accepting all three
 * removes the most common failure without weakening the marker check.
 *
 * @param {string} input - whatever the user pasted.
 * @returns {CookieVerdict} the verdict.
 */
export function recogniseInput(input) {
  const text = input.trim()
  if (text === '') return { source: undefined, matched: 0, names: [], reason: '输入为空' }

  // A `Cookie:` line (case-insensitive) carries the header after the colon.
  const labelled = /^cookie\s*:\s*(.+)$/is.exec(text)
  const header = labelled === null ? text : labelled[1]

  const verdict = recogniseSource(header)
  if (verdict.source !== undefined) return verdict

  // No marker matched: try the hosts named in the text.
  const lower = text.toLowerCase()
  for (const [id, hosts] of Object.entries(SOURCE_HOSTS)) {
    if (hosts.some(host => lower.includes(host))) {
      return {
        source: id,
        matched: 0,
        names: verdict.names,
        reason: `cookie 名无特征，但文本里出现了 ${labelOf(id)} 的域名`,
      }
    }
  }
  return verdict
}

/**
 * Extract cookie names from a header without touching values.
 *
 * @param {string} header - a `Cookie` header value.
 * @returns {string[]} the names, in order.
 */
export function cookieNames(header) {
  /** @type {string[]} */
  const names = []
  for (const chunk of header.split(';')) {
    const separator = chunk.indexOf('=')
    if (separator <= 0) continue
    const name = chunk.slice(0, separator).trim()
    if (name !== '' && !names.includes(name)) names.push(name)
  }
  return names
}

/**
 * Display name for a source id.
 *
 * @param {string} id - source id.
 * @returns {string} the label.
 */
export function labelOf(id) {
  return { baidu: '百度', sogou: '搜狗', bing: '必应', 360: '360 搜索', duckduckgo: 'DuckDuckGo' }[id] ?? id
}

/**
 * Split a multi-source pasted blob into one header per source.
 *
 * Users sometimes paste cookies for several engines in one line. Names are
 * unique enough to split on markers, so each engine receives only its own
 * cookies instead of a header that partly belongs to another host.
 *
 * @param {string} header - the pasted header.
 * @returns {Map<string, string>} source id → header for that source.
 */
export function splitBySource(header) {
  /** @type {Map<string, string[]>} */
  const buckets = new Map()
  /** @type {string[]} */
  const unassigned = []

  for (const chunk of header.split(';')) {
    const separator = chunk.indexOf('=')
    if (separator <= 0) continue
    const name = chunk.slice(0, separator).trim()
    if (name === '') continue
    const pair = chunk.trim()

    /** @type {string | undefined} */
    let owner
    for (const [id, markers] of Object.entries(MARKERS)) {
      if (markers.includes(name)) {
        owner = id
        break
      }
    }
    if (owner === undefined) {
      unassigned.push(pair)
      continue
    }
    const list = buckets.get(owner) ?? []
    list.push(pair)
    buckets.set(owner, list)
  }

  // Cookies no marker claimed go to the single source in the input, if there is
  // exactly one — that is the common case of one engine with a few unknown
  // auxiliary cookies, and dropping them would lose the session.
  if (unassigned.length > 0 && buckets.size === 1) {
    const [id, list] = [...buckets.entries()][0]
    buckets.set(id, [...list, ...unassigned])
  }

  const out = new Map()
  for (const [id, list] of buckets) out.set(id, list.join('; '))
  return out
}

/**
 * Build one jar per source from the per-source cookie configuration.
 *
 * @param {object} config - resolved cookie config.
 * @param {Record<string, string>} config.cookiesBySource - pasted header per source id.
 * @param {string} config.cookieHeader - the legacy single header, applied to
 *   every source that has no entry of its own.
 * @param {readonly string[]} sources - the sources that will be used.
 * @returns {Map<string, CookieJar>} source id → jar.
 */
export function jarsBySource(config, sources) {
  /** @type {Map<string, CookieJar>} */
  const jars = new Map()
  const legacy = (config.cookieHeader ?? '').trim()
  const legacyBuckets = legacy === '' ? new Map() : splitBySource(legacy)
  // When the legacy header names no engine at all, it is genuinely generic and
  // may go to every source. When it does name engines, each source receives only
  // its own slice: sending BAIDUID to Bing looks like a forged session and is
  // the exact problem per-source cookies exist to remove.
  const legacyIsLabelled = legacyBuckets.size > 0

  for (const id of sources) {
    const jar = new CookieJar()
    const own = (config.cookiesBySource?.[id] ?? '').trim()
    const hosts = SOURCE_HOSTS[id] ?? []

    if (own !== '') {
      for (const host of hosts) jar.import(parseCookieHeader(own, host))
    } else if (legacy !== '') {
      const bucket = legacyBuckets.get(id)
      const value = legacyIsLabelled ? (bucket ?? '') : legacy
      if (value !== '') for (const host of hosts) jar.import(parseCookieHeader(value, host))
    }
    jars.set(id, jar)
  }
  return jars
}

/**
 * Which sources currently have a usable cookie, for the settings summary.
 *
 * @param {Record<string, string>} cookiesBySource - per-source headers.
 * @param {string} cookieHeader - the legacy header.
 * @param {readonly string[]} sources - configured sources.
 * @returns {Array<{ id: string, label: string, set: boolean, names: number }>} the summary.
 */
export function cookieSummary(cookiesBySource, cookieHeader, sources) {
  return sources.map(id => {
    const own = (cookiesBySource?.[id] ?? '').trim()
    const names = own === '' ? 0 : cookieNames(own).length
    const inherited = own === '' && (cookieHeader ?? '').trim() !== ''
    return {
      id,
      label: labelOf(id),
      set: own !== '' || inherited,
      names: own !== '' ? names : inherited ? cookieNames(cookieHeader).length : 0,
    }
  })
}
