/**
 * User-defined search sources.
 *
 * The five built-in adapters are hand-written parsers for pages that were read
 * and tested. A user adding their own engine cannot write a parser, so a custom
 * source is declared as data: a URL template with `{query}`/`{offset}` slots and
 * a small set of CSS-like result selectors. This module turns that declaration
 * into the same `SearchSource` interface the pipeline already consumes, so
 * nothing downstream changes.
 *
 * Why data and not code: the plugin's config lives in a YAML profile patch and
 * is edited from a settings page. Executing user-supplied JavaScript from there
 * would turn a configuration typo into arbitrary code execution inside the host
 * process. A declaration can only describe a page; it cannot run anything.
 *
 * @module cube-dsh-free/custom-sources
 */

import { absoluteUrl, regions, scanTags, toText } from './html.js'
import { failure } from './errors.js'

/**
 * Default selectors, matching the common shape of a results page.
 *
 * They are not guaranteed for any particular engine: a user adding a source is
 * expected to inspect their engine's HTML once and set these. The defaults are a
 * starting point that happens to work on simple pages.
 */
export const SELECTOR_DEFAULTS = Object.freeze({
  result: 'div.result',
  link: 'a',
  title: 'a',
  snippet: 'p',
})

/**
 * @typedef {object} CustomSourceSpec
 * @property {string} id - stable key, also used for per-source cookies.
 * @property {string} label - display name.
 * @property {string} url - page template with `{query}` and optional `{offset}`.
 * @property {string} [result] - selector for one result block.
 * @property {string} [link] - selector for the anchor carrying the target URL.
 * @property {string} [title] - selector for the title text.
 * @property {string} [snippet] - selector for the summary.
 * @property {number} [offsetStart] - first page's offset value.
 * @property {number} [offsetStep] - how much the offset advances per page.
 * @property {string} [hosts] - comma-separated hosts, for cookie import.
 * @property {string} [warmUp] - landing page to visit before searching.
 */

/**
 * Validate one custom source declaration.
 *
 * @param {unknown} value - raw config entry.
 * @param {number} index - position, for error messages.
 * @returns {CustomSourceSpec} the normalized spec.
 * @throws {Error} naming the offending field.
 */
export function normaliseCustomSource(value, index = 0) {
  const where = `customSources[${index}]`
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${where} must be an object`)
  }
  const raw = /** @type {Record<string, unknown>} */ (value)

  const id = text(raw.id, `${where}.id`)
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(id)) {
    throw new Error(`${where}.id must be 1–32 letters, digits, "_" or "-"; got ${JSON.stringify(id)}`)
  }
  // A custom id may not shadow a built-in one, or the pipeline would silently
  // pick one of the two depending on lookup order.
  if (BUILT_IN_IDS.includes(id)) {
    throw new Error(`${where}.id "${id}" is a built-in source; choose another id`)
  }

  const url = text(raw.url, `${where}.url`)
  if (!/^https?:\/\//i.test(url)) throw new Error(`${where}.url must start with http:// or https://`)
  if (!url.includes('{query}')) throw new Error(`${where}.url must contain the {query} placeholder`)

  const offsetStart = integer(raw.offsetStart, `${where}.offsetStart`, 0, 0, 10000)
  const offsetStep = integer(raw.offsetStep, `${where}.offsetStep`, 10, 1, 1000)

  return Object.freeze({
    id,
    label: text(raw.label, `${where}.label`),
    url,
    result: optionalText(raw.result, `${where}.result`) ?? SELECTOR_DEFAULTS.result,
    link: optionalText(raw.link, `${where}.link`) ?? SELECTOR_DEFAULTS.link,
    title: optionalText(raw.title, `${where}.title`) ?? SELECTOR_DEFAULTS.title,
    snippet: optionalText(raw.snippet, `${where}.snippet`) ?? SELECTOR_DEFAULTS.snippet,
    offsetStart,
    offsetStep,
    hosts: optionalText(raw.hosts, `${where}.hosts`) ?? hostsFromTemplate(url),
    warmUp: optionalText(raw.warmUp, `${where}.warmUp`) ?? originOf(url),
  })
}

/** Built-in ids a custom source may not take. */
const BUILT_IN_IDS = ['bing', '360', 'baidu', 'duckduckgo', 'sogou']

/**
 * Read a required non-empty string.
 *
 * @param {unknown} value - raw.
 * @param {string} where - field path.
 * @returns {string} the value.
 */
function text(value, where) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${where} must be a non-empty string`)
  }
  return value.trim()
}

/**
 * Read an optional non-empty string.
 *
 * @param {unknown} value - raw.
 * @param {string} where - field path.
 * @returns {string | undefined} the value.
 */
function optionalText(value, where) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error(`${where} must be a string`)
  return value.trim()
}

/**
 * Read a bounded integer.
 *
 * @param {unknown} value - raw.
 * @param {string} where - field path.
 * @param {number} fallback - default.
 * @param {number} min - lower bound.
 * @param {number} max - upper bound.
 * @returns {number} the value.
 */
function integer(value, where, fallback, min, max) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${where} must be an integer from ${min} to ${max}`)
  }
  return value
}

/**
 * Derive the host list from a URL template, so cookie import works without the
 * user restating the domain.
 *
 * @param {string} template - the URL template.
 * @returns {string} comma-separated hosts.
 */
function hostsFromTemplate(template) {
  const origin = originOf(template)
  if (origin === '') return ''
  try {
    const host = new URL(origin).hostname
    // A leading `www.` is not how a cookie is scoped, so record the bare domain
    // as well; the jar matches subdomains.
    const bare = host.replace(/^www\./, '')
    return bare === host ? host : `${bare},${host}`
  } catch {
    return ''
  }
}

/**
 * The origin of a URL template, with placeholders stripped.
 *
 * @param {string} template - the template.
 * @returns {string} the origin, or '' when unparseable.
 */
function originOf(template) {
  try {
    const probe = template.replace(/\{[a-zA-Z]+\}/g, 'x')
    const url = new URL(probe)
    return url.origin
  } catch {
    return ''
  }
}

/**
 * Turn a spec into the interface the search pipeline consumes.
 *
 * The selectors are deliberately simple: a tag name, optional `.class`, and
 * `#id`, which covers how result pages are actually marked up. A full CSS engine
 * would be a dependency the plugin does not otherwise need.
 *
 * @param {CustomSourceSpec} spec - the declaration.
 * @returns {import('./sources.js').SearchSource} the adapter.
 */
export function adapterOf(spec) {
  return {
    id: spec.id,
    label: spec.label,
    hosts: spec.hosts === '' ? [] : spec.hosts.split(',').map(h => h.trim()).filter(h => h !== ''),
    warmUp: spec.warmUp === '' ? [] : [spec.warmUp],
    pageUrl(query, offset) {
      const page = Math.floor(offset / spec.offsetStep)
      const value = spec.offsetStart + page * spec.offsetStep
      return spec.url
        .replace(/\{query\}/g, encodeURIComponent(query))
        .replace(/\{offset\}/g, String(value))
    },
    parse(html, pageUrl) {
      const hits = []
      // `regions` yields the outer HTML of each matching element as a string, so
      // every field has to be re-read from that fragment rather than treated as
      // an object with `inner`.
      for (const block of regions(html, tag => matches(tag, spec.result))) {
        const anchor = firstTag(block, spec.link)
        if (anchor === undefined) continue
        const href = anchor.attributes.href
        if (href === undefined || href === '') continue
        const url = absoluteUrl(href, pageUrl)
        if (url === undefined) continue

        const titleTag = firstTag(block, spec.title) ?? anchor
        const title = toText(innerOfTag(block, titleTag))
        if (title === '') continue

        const snippetTag = firstTag(block, spec.snippet)
        hits.push({
          url,
          title,
          snippet: snippetTag === undefined ? '' : toText(innerOfTag(block, snippetTag)),
        })
      }
      // Custom sources do not declare a next-page selector, so the pipeline's
      // offset advance drives paging. That is the safest default: following a
      // "next" link correctly needs a selector the user has not been asked for.
      return { hits, nextUrl: undefined }
    },
  }
}

/**
 * The first opening tag inside a fragment that matches a selector.
 *
 * @param {string} fragment - the block's outer HTML.
 * @param {string} selector - selector text.
 * @returns {{ name: string, attributes: Record<string, string>, start: number, selfClosing: boolean } | undefined}
 *   the tag, with offsets into `fragment`.
 */
function firstTag(fragment, selector) {
  for (const tag of scanTags(fragment)) {
    if (tag.closing || tag.selfClosing) continue
    if (matches(tag, selector)) return tag
  }
  return undefined
}

/**
 * The content between a tag's opening and its own closing tag.
 *
 * @param {string} fragment - the block's outer HTML.
 * @param {{ name: string, start: number, selfClosing: boolean }} tag - the tag.
 * @returns {string} the inner HTML, or '' when there is none.
 */
function innerOfTag(fragment, tag) {
  if (tag.selfClosing) return ''
  const openEnd = fragment.indexOf('>', tag.start)
  if (openEnd === -1) return ''
  const close = fragment.lastIndexOf('</' + tag.name)
  if (close === -1 || close < openEnd) return fragment.slice(openEnd + 1)
  return fragment.slice(openEnd + 1, close)
}

/**
 * Whether a scanned tag matches a simple selector (`tag`, `tag.class`,
 * `tag#id`, `.class`).
 *
 * @param {{ name: string, attributes: Record<string, string> }} tag - the tag.
 * @param {string} selector - the selector.
 * @returns {boolean} true on a match.
 */
function matches(tag, selector) {
  const cleaned = selector.trim()
  if (cleaned === '') return false

  // A descendant selector ("div.result a") is not supported; take the last part,
  // which is the element the user actually means.
  const last = cleaned.split(/\s+/).at(-1) ?? cleaned

  const idMatch = /#([\w-]+)/.exec(last)
  const classMatch = /\.([\w-]+)/.exec(last)
  const tagMatch = /^([\w-]+)/.exec(last)

  if (idMatch !== null && tag.attributes.id !== idMatch[1]) return false
  if (classMatch !== null) {
    const classes = (tag.attributes.class ?? '').split(/\s+/)
    if (!classes.includes(classMatch[1])) return false
  }
  if (tagMatch !== null && tagMatch[1] !== '*' && tag.name !== tagMatch[1].toLowerCase()) return false
  return true
}

/**
 * Build the adapters for every configured custom source.
 *
 * @param {readonly CustomSourceSpec[]} specs - validated declarations.
 * @returns {Map<string, import('./sources.js').SearchSource>} id → adapter.
 */
export function customAdapters(specs) {
  const map = new Map()
  for (const spec of specs) map.set(spec.id, adapterOf(spec))
  return map
}

/**
 * Assert a search produced results with a usable shape, so a misconfigured
 * selector is reported as a parse problem instead of an empty result set.
 *
 * @param {import('./sources.js').SearchSource} source - the adapter.
 * @param {import('./sources.js').SourcePage} page - its parse output.
 * @returns {void}
 * @throws {Error} when the selectors matched nothing.
 */
export function assertSelectorsWork(source, page) {
  if (page.hits.length > 0) return
  throw failure(
    'parse',
    `自定义源「${source.label}」没有解析出结果。请检查 result / link / title 选择器是否与目标页面一致。`,
    { source: source.label },
  )
}
