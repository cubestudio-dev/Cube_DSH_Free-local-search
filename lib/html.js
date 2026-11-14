/**
 * A small, dependency-free HTML toolkit: entity decoding, tag scanning, text
 * normalization, and content-region extraction.
 *
 * Why hand-written instead of a parser package: the plugin installs into a
 * profile whose `node_modules` carries only the plugin's own dependencies, and
 * the Harness installation's packages are not importable from a profile
 * plugin. A library dependency would therefore have to be vendored; a
 * purpose-built scanner is smaller, has no supply chain, and is enough for
 * extraction (we need text and links, not a DOM).
 *
 * @module cube-dsh-free/html
 */

/** Named entities worth decoding; numeric forms cover everything else. */
const NAMED_ENTITIES = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', zwnj: '\u200c', zwj: '\u200d',
  mdash: '—', ndash: '–', hellip: '…', middot: '·', bull: '•',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
  laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™',
  deg: '°', plusmn: '±', times: '×', divide: '÷', frac12: '½',
  eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', uuml: 'ü', ouml: 'ö', auml: 'ä',
  szlig: 'ß', ntilde: 'ñ', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§',
  para: '¶', dagger: '†', permil: '‰', prime: '′', Prime: '″',
})

/**
 * Decode HTML character references.
 *
 * @param {string} text - text possibly containing references.
 * @returns {string} decoded text.
 */
export function decodeEntities(text) {
  if (!text.includes('&')) return text
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match
      // Surrogates are not scalar values; keep the literal reference.
      if (code >= 0xd800 && code <= 0xdfff) return match
      try {
        return String.fromCodePoint(code)
      } catch {
        return match
      }
    }
    const named = NAMED_ENTITIES[body]
    return named === undefined ? match : named
  })
}

/**
 * Collapse runs of whitespace (including NBSP and ideographic space) to single
 * spaces and trim.
 *
 * @param {string} text - raw text.
 * @returns {string} normalized text.
 */
export function collapseWhitespace(text) {
  return text.replace(/[\s\u00a0\u3000]+/g, ' ').trim()
}

/**
 * Remove every tag from a fragment and decode what remains.
 *
 * @param {string} html - markup fragment.
 * @returns {string} plain text, whitespace collapsed.
 */
export function toText(html) {
  return collapseWhitespace(decodeEntities(html.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ').replace(/<[^>]*>/g, ' ')))
}

/** Elements that never take a closing tag. */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
])

/** Elements whose contents are not markup. */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title'])

/**
 * @typedef {object} Tag
 * @property {string} name - lowercased tag name.
 * @property {boolean} closing - whether this is an end tag.
 * @property {Record<string, string>} attributes - attribute map (lowercased names).
 * @property {number} start - offset of `<`.
 * @property {number} end - offset just past `>`.
 * @property {boolean} selfClosing - trailing slash or a void element.
 */

/**
 * Parse one attribute string into a name→value map.
 *
 * @param {string} source - everything between the tag name and the closing `>`.
 * @returns {Record<string, string>} attributes.
 */
function parseAttributes(source) {
  /** @type {Record<string, string>} */
  const attributes = {}
  const pattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let match
  while ((match = pattern.exec(source)) !== null) {
    const name = match[1].toLowerCase()
    const value = match[2] ?? match[3] ?? match[4] ?? ''
    // First occurrence wins, matching how browsers treat duplicate attributes.
    if (!(name in attributes)) attributes[name] = decodeEntities(value)
  }
  return attributes
}

/**
 * Iterate the tags of a document in source order, skipping comments and the
 * bodies of raw-text elements.
 *
 * @param {string} html - document or fragment.
 * @param {number} [from] - offset to start from.
 * @returns {Tag[]} tags with offsets.
 */
export function scanTags(html, from = 0) {
  /** @type {Tag[]} */
  const tags = []
  const lower = html.toLowerCase()
  let offset = from
  while (offset < html.length) {
    const start = html.indexOf('<', offset)
    if (start === -1) break
    if (html.startsWith('<!--', start)) {
      const close = html.indexOf('-->', start + 4)
      offset = close === -1 ? html.length : close + 3
      continue
    }
    if (html.startsWith('<![CDATA[', start)) {
      const close = html.indexOf(']]>', start + 9)
      offset = close === -1 ? html.length : close + 3
      continue
    }
    if (html[start + 1] === '!' || html[start + 1] === '?') {
      const close = html.indexOf('>', start + 2)
      offset = close === -1 ? html.length : close + 1
      continue
    }
    const closing = html[start + 1] === '/'
    const nameStart = start + (closing ? 2 : 1)
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(html.slice(nameStart, nameStart + 64))
    if (nameMatch === null) {
      offset = start + 1
      continue
    }
    const name = nameMatch[0].toLowerCase()
    // Find the tag's closing '>' while respecting quoted attribute values.
    let cursor = nameStart + nameMatch[0].length
    let quote = ''
    while (cursor < html.length) {
      const char = html[cursor]
      cursor += 1
      if (quote !== '') {
        if (char === quote) quote = ''
      } else if (char === '"' || char === "'") {
        quote = char
      } else if (char === '>') {
        break
      }
    }
    if (html[cursor - 1] !== '>') break
    const attributeSource = html.slice(nameStart + nameMatch[0].length, cursor - 1)
    const tag = {
      name,
      closing,
      attributes: closing ? {} : parseAttributes(attributeSource),
      start,
      end: cursor,
      selfClosing: !closing && (VOID_ELEMENTS.has(name) || /\/\s*$/.test(attributeSource)),
    }
    tags.push(tag)
    if (!closing && RAW_TEXT_ELEMENTS.has(name)) {
      const closeStart = lower.indexOf(`</${name}`, cursor)
      offset = closeStart === -1 ? html.length : closeStart
      continue
    }
    offset = cursor
  }
  return tags
}

/**
 * Return the inner HTML of the first element matching `name`, using a
 * depth scan so nested same-name elements are handled.
 *
 * @param {string} html - document.
 * @param {string} name - lowercased tag name.
 * @param {number} [from] - offset to search from.
 * @returns {{ inner: string, start: number, end: number } | undefined} the region.
 */
export function innerOfFirst(html, name, from = 0) {
  let depth = 0
  let innerStart = -1
  let outerStart = -1
  for (const tag of scanTags(html, from)) {
    if (tag.name !== name) continue
    if (!tag.closing && !tag.selfClosing) {
      if (depth === 0) {
        innerStart = tag.end
        outerStart = tag.start
      }
      depth += 1
    } else if (tag.closing) {
      depth -= 1
      if (depth === 0 && innerStart !== -1) {
        return { inner: html.slice(innerStart, tag.start), start: outerStart, end: tag.end }
      }
    }
  }
  return undefined
}

/**
 * Split a document into the outer HTML of each element matching a predicate.
 *
 * Walks the tag stream rather than the raw text, so a match closes at its own
 * end tag and malformed documents yield fewer, larger regions instead of
 * garbage.
 *
 * @param {string} html - document.
 * @param {(tag: Tag) => boolean} matches - predicate for an opening element.
 * @param {number} [limit] - stop after this many regions.
 * @returns {string[]} the outer HTML of each matched element.
 */
export function regions(html, matches, limit = Number.POSITIVE_INFINITY) {
  /** @type {string[]} */
  const out = []
  const tags = scanTags(html)
  for (let index = 0; index < tags.length; index += 1) {
    const tag = tags[index]
    if (tag.closing || tag.selfClosing || !matches(tag)) continue
    let depth = 1
    let end = html.length
    for (let cursor = index + 1; cursor < tags.length; cursor += 1) {
      const inner = tags[cursor]
      if (inner.name !== tag.name) continue
      if (!inner.closing && !inner.selfClosing) depth += 1
      else if (inner.closing) {
        depth -= 1
        if (depth === 0) {
          end = inner.end
          break
        }
      }
    }
    out.push(html.slice(tag.start, end))
    if (out.length >= limit) break
  }
  return out
}

/** Class/id tokens that mark site chrome rather than content. */
const NOISE_PATTERN = /\b(nav|navbar|navigation|menu|breadcrumb|sidebar|side-bar|aside|footer|header|masthead|topbar|toolbar|share|social|comment|comments|related|recommend|advert|advertisement|ad-slot|sponsor|promo|banner|cookie|popup|modal|subscribe|newsletter|pagination|pager|tag-list|tags|copyright)\b/i

/** Elements removed wholesale before extraction. */
const DROP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'svg',
  'canvas', 'form', 'input', 'button', 'select', 'option', 'textarea', 'nav',
  'footer', 'header', 'aside', 'menu', 'dialog', 'video', 'audio', 'map',
])

/** Tags that produce a block boundary in the extracted text. */
const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'main', 'li', 'tr', 'td', 'th', 'h1',
  'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'dt', 'dd', 'figcaption',
  'table', 'ul', 'ol', 'hr', 'br',
])

/**
 * Whether an element is site chrome by tag name, ARIA role, or class/id token.
 *
 * @param {Tag} tag - opening tag.
 * @returns {boolean} true when the element should be skipped.
 */
export function isNoiseElement(tag) {
  if (DROP_TAGS.has(tag.name)) return true
  if (tag.attributes['aria-hidden'] === 'true') return true
  if (tag.attributes.hidden !== undefined) return true
  const role = tag.attributes.role ?? ''
  if (role === 'navigation' || role === 'banner' || role === 'contentinfo' || role === 'complementary' || role === 'search') return true
  const style = tag.attributes.style ?? ''
  if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) return true
  const className = tag.attributes.class ?? ''
  const id = tag.attributes.id ?? ''
  if (className === '' && id === '') return false
  return NOISE_PATTERN.test(className) || NOISE_PATTERN.test(id)
}

/**
 * @typedef {object} ExtractedContent
 * @property {string} title - document title, or the first heading.
 * @property {string} text - readable body text with block line breaks.
 * @property {boolean} truncated - whether the character cap cut the text.
 */

/**
 * Extract a readable title and body from an HTML document.
 *
 * One pass over the tag stream: skip chrome (by tag, ARIA role, class/id
 * token, or hidden style), cut a line at each block boundary, then choose the
 * densest contiguous run of prose lines so a page whose article sits inside a
 * wide template does not return the whole template. Finally enforce a
 * character cap at a line boundary.
 *
 * @param {string} html - the document.
 * @param {{ maxChars: number, keepNoise?: boolean }} options - extraction bounds.
 * @returns {ExtractedContent} the extracted content.
 */
export function extractContent(sourceHtml, options) {
  const maxChars = Math.max(200, options.maxChars)
  const keepNoise = options.keepNoise === true
  // Comments, doctypes, and CDATA carry no text and would otherwise leak into
  // the first line as markup.
  const html = sourceHtml
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ')
    .replace(/<!doctype[^>]*>/gi, ' ')
    .replace(/<\?xml[^>]*>/gi, ' ')
  const title = extractTitle(html)
  /** @type {string[]} */
  const lines = []
  let buffer = ''
  /** Names of elements whose whole subtree is being skipped. */
  const skipStack = []
  let cursor = 0
  const flush = () => {
    const line = collapseWhitespace(decodeEntities(buffer))
    buffer = ''
    if (line !== '') lines.push(line)
  }
  for (const tag of scanTags(html)) {
    if (skipStack.length === 0) {
      const gap = html.slice(cursor, tag.start)
      if (gap !== '') buffer += gap
    }
    cursor = tag.end
    if (skipStack.length > 0) {
      if (tag.name === skipStack[skipStack.length - 1]) {
        if (!tag.closing && !tag.selfClosing) skipStack.push(tag.name)
        else if (tag.closing) skipStack.pop()
      }
      continue
    }
    if (tag.closing || tag.selfClosing) {
      if (BLOCK_TAGS.has(tag.name)) flush()
      continue
    }
    if (keepNoise !== true && isNoiseElement(tag)) {
      // Self-closing chrome has no subtree, but it still ends the line.
      if (tag.selfClosing) flush()
      else skipStack.push(tag.name)
      continue
    }
    if (BLOCK_TAGS.has(tag.name)) flush()
  }
  if (skipStack.length === 0) {
    buffer += html.slice(cursor)
    flush()
  }
  const selected = selectContentLines(lines, title)
  const joined = selected.join('\n')
  if (joined.length <= maxChars) return { title, text: joined, truncated: false }
  let cut = joined.slice(0, maxChars)
  const lastBreak = cut.lastIndexOf('\n')
  if (lastBreak > maxChars * 0.6) cut = cut.slice(0, lastBreak)
  return { title, text: cut.trimEnd(), truncated: true }
}

/**
 * Read the document title: `<title>`, then `og:title`, then the first heading.
 *
 * @param {string} html - the document.
 * @returns {string} the title, possibly empty.
 */
export function extractTitle(html) {
  const titleTag = innerOfFirst(html, 'title')
  const fromTitle = titleTag === undefined ? '' : collapseWhitespace(decodeEntities(titleTag.inner))
  if (fromTitle !== '') return fromTitle
  const og = html.match(/<meta[^>]+property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']*)["']/i)
    ?? html.match(/<meta[^>]+content\s*=\s*["']([^"']*)["'][^>]*property\s*=\s*["']og:title["']/i)
  if (og !== null) return collapseWhitespace(decodeEntities(og[1]))
  for (const name of ['h1', 'h2']) {
    const heading = innerOfFirst(html, name)
    if (heading === undefined) continue
    const text = toText(heading.inner)
    if (text !== '') return text
  }
  return ''
}

/**
 * Pick the content lines worth returning.
 *
 * Short pages ("a short note", a docs leaf) keep every line. Long pages are
 * dominated by template furniture, so the densest contiguous run of prose is
 * kept: a sliding window scores spans by prose length, then only that span
 * survives.
 *
 * @param {string[]} lines - extracted lines in document order.
 * @param {string} title - the document title, used to drop a duplicate header.
 * @returns {string[]} the selected lines.
 */
function selectContentLines(lines, title) {
  /** @type {string[]} */
  const kept = []
  let previous = ''
  for (const line of lines) {
    if (line === previous || line === title) continue
    // Line-number-only and menu leftovers carry no prose.
    if (line.length < 12 && !/[。！？.!?]$/.test(line)) continue
    kept.push(line)
    previous = line
  }
  if (kept.length <= 30) return kept
  const weights = kept.map(line => (/[。！？.!?，,；;]/.test(line) ? Math.min(line.length, 400) : Math.min(line.length, 400) * 0.35))
  const windowSize = 24
  let bestScore = -1
  let bestStart = 0
  let running = 0
  for (let index = 0; index < weights.length; index += 1) {
    running += weights[index]
    if (index >= windowSize) running -= weights[index - windowSize]
    if (index >= windowSize - 1 && running > bestScore) {
      bestScore = running
      bestStart = index - windowSize + 1
    }
  }
  return kept.slice(bestStart, bestStart + windowSize * 3)
}

/**
 * Resolve a possibly relative URL against a base, returning `undefined` for
 * unusable or non-HTTP(S) results.
 *
 * @param {string} href - raw or resolved href.
 * @param {string} [base] - absolute base URL.
 * @returns {string | undefined} the absolute HTTP(S) URL.
 */
export function absoluteUrl(href, base) {
  const trimmed = decodeEntities(href).trim()
  if (trimmed === '' || trimmed.startsWith('#')) return undefined
  if (/^(javascript|mailto|tel|data|vbscript):/i.test(trimmed)) return undefined
  try {
    const url = base === undefined ? new URL(trimmed) : new URL(trimmed, base)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

/**
 * Collect the anchors of a fragment as `{ href, text }` pairs.
 *
 * @param {string} html - fragment.
 * @param {string} [base] - absolute base URL for relative hrefs.
 * @returns {Array<{ url: string, text: string }>} usable links in document order.
 */
export function anchors(html, base) {
  /** @type {Array<{ url: string, text: string }>} */
  const out = []
  for (const tag of scanTags(html)) {
    if (tag.closing || tag.name !== 'a') continue
    const href = tag.attributes.href
    if (href === undefined) continue
    const url = absoluteUrl(href, base)
    if (url === undefined) continue
    out.push({ url, text: '' })
  }
  return out
}