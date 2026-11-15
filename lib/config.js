/**
 * The plugin's Config: the persisted mode plus the operational bounds.
 *
 * `mode` is the one volatile field — the settings page writes it live and it
 * applies to the next call. Everything else is ordinary configuration edited in
 * the profile patch, because changing it changes behaviour the user should
 * review before it takes effect.
 *
 * The schema must be a real Schemastery schema: the Loader only projects a
 * Config it recognises as native (`Symbol.for('schemastery')`), and anything
 * else is reported as unsupported configuration and gets no form.
 *
 * @module cube-dsh-free/config
 */

import z from '@deepseek-ai/schemastery'

/** The three modes, in the order the settings page shows them. */
export const MODES = Object.freeze(['official', 'local', 'auto'])

/** Local source ids accepted by configuration. */
export const SOURCE_IDS = Object.freeze(['bing', '360', 'baidu', 'duckduckgo', 'sogou'])

/** Resolved defaults, shared by the schema and the resolver. */
export const DEFAULTS = Object.freeze({
  mode: 'auto',
  officialSearchProvider: 'deepseek-official',
  officialFetchProvider: 'http',
  localSources: Object.freeze(['bing', '360', 'baidu', 'duckduckgo', 'sogou']),
  localMaxPages: 2,
  localTimeoutMs: 15000,
  localFetchTimeoutMs: 25000,
  localMaxBytes: 3000000,
  localFetchMaxChars: 60000,
  localMaxLinks: 20,
  keepNoise: false,
  cookieBrowser: 'none',
  cookieHeader: '',
  cookiesBySource: Object.freeze({}),
  cookieWarmUp: true,
})

/**
 * The Loader-visible Config schema.
 *
 * `mode` is volatile so a settings-page write reaches the running provider
 * without a plugin reload; the other fields require a reload, which the
 * settings form states.
 */
export const Config = z.object({
  mode: z.union([z.const('official'), z.const('local'), z.const('auto')])
    .default('auto')
    .description('Which backend serves web_search and web_fetch: official (DeepSeek only), local (free public sources), or auto (official first, local on failure). Applies to the next call.')
    .volatile(),
  officialSearchProvider: z.string()
    .default('deepseek-official')
    .description('Official search provider id, used in official and auto modes: deepseek-official (Messages API) or deepseek-search-api (Search & Fetch API).'),
  officialFetchProvider: z.string()
    .default('http')
    .description('Official fetch provider id, used in official and auto modes: http (shipped anonymous fetcher) or deepseek-fetch-api (Search & Fetch API).'),
  localSources: z.array(z.string())
    .default(['bing', '360', 'baidu', 'duckduckgo', 'sogou'])
    .description('Free public search sources tried in order: bing, 360, baidu, duckduckgo, sogou.'),
  localMaxPages: z.number().step(1).min(1).max(10)
    .default(2)
    .description('Maximum result pages fetched per source.'),
  localTimeoutMs: z.number().step(1).min(1000).max(120000)
    .default(15000)
    .description('Per-request timeout for local search pages, in milliseconds.'),
  localFetchTimeoutMs: z.number().step(1).min(1000).max(120000)
    .default(25000)
    .description('Per-request timeout for local page fetches, in milliseconds.'),
  localMaxBytes: z.number().step(1).min(65536).max(20000000)
    .default(3000000)
    .description('Response byte cap for local requests.'),
  localFetchMaxChars: z.number().step(1).min(500).max(400000)
    .default(60000)
    .description('Character cap on the extracted body returned by local fetch.'),
  localMaxLinks: z.number().step(1).min(0).max(100)
    .default(20)
    .description('Maximum related links returned by local fetch (0 disables them).'),
  keepNoise: z.boolean()
    .default(false)
    .description('Keep navigation, sidebars, and footers in extracted pages instead of stripping them.'),
  cookieBrowser: z.string()
    .default('none')
    .description('Import cookies from an installed browser so local search looks like a real session: none, edge, chrome, chromium, brave. Only the configured search engines\' hosts are read, in memory, never stored.')
    .volatile(),
  cookieHeader: z.string()
    .default('')
    .description('Literal Cookie header used as a fallback for every source that has no per-source cookie below. Prefer the per-source field: a header scoped to one engine is ignored, or reads as a forged session, when sent to another host. Stored in the profile patch, so treat that file as sensitive. Applies to the next call.')
    .volatile(),
  cookiesBySource: z.dict(z.string(), z.string())
    .default({})
    .description('Per-source Cookie headers, keyed by source id: bing, 360, baidu, duckduckgo, sogou. Each source searches with its own session and never sends another engine\'s cookies. Paste what your browser sends for that site; the plugin recognises which engine a header belongs to when you cannot tell. Stored in the profile patch, so treat that file as sensitive. Applies to the next call.')
    .volatile(),
  cookieWarmUp: z.boolean()
    .default(true)
    .description('Visit each source\'s landing page once before searching, so the request carries that source\'s session cookies instead of hitting it cold. This makes a request look like a browsing session; it is not a reliable way around a block.')
    .volatile(),
})

/** Keys the schema accepts, for the unknown-key warning. */
const KNOWN_KEYS = new Set([
  'mode', 'officialSearchProvider', 'officialFetchProvider', 'localSources',
  'localMaxPages', 'localTimeoutMs', 'localFetchTimeoutMs', 'localMaxBytes',
  'localFetchMaxChars', 'localMaxLinks', 'keepNoise', 'cookieBrowser',
  'cookieHeader', 'cookiesBySource', 'cookieWarmUp',
])

/**
 * Report keys the schema does not know, so a typo in the patch layer is visible
 * instead of silently falling back to a default.
 *
 * @param {unknown} raw - the row's raw config.
 * @returns {string[]} unknown keys.
 */
export function unknownKeys(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []
  return Object.keys(raw).filter(key => !KNOWN_KEYS.has(key))
}

/**
 * Validate and resolve one raw config.
 *
 * Accepts either a raw object or an already-resolved one (both arrive here: the
 * Loader resolves the row, and the settings projection hands back plain values),
 * so every field is normalized the same way.
 *
 * @param {unknown} value - the config to resolve.
 * @returns {ResolvedConfig} the resolved configuration.
 * @throws {Error} naming the offending value.
 */
export function resolveConfig(value) {
  if (value === undefined || value === null) {
    return finish({ ...DEFAULTS, localSources: [...DEFAULTS.localSources] })
  }
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('config must be an object')
  const raw = /** @type {Record<string, unknown>} */ (value)
  const mode = raw.mode ?? DEFAULTS.mode
  if (typeof mode !== 'string' || !MODES.includes(mode)) {
    throw new Error(`mode must be one of ${MODES.join(', ')}; got ${JSON.stringify(mode)}`)
  }
  return finish({
    mode,
    officialSearchProvider: text(raw.officialSearchProvider, 'officialSearchProvider', DEFAULTS.officialSearchProvider),
    officialFetchProvider: text(raw.officialFetchProvider, 'officialFetchProvider', DEFAULTS.officialFetchProvider),
    localSources: sources(raw.localSources),
    localMaxPages: integer(raw.localMaxPages, 'localMaxPages', DEFAULTS.localMaxPages, 1, 10),
    localTimeoutMs: integer(raw.localTimeoutMs, 'localTimeoutMs', DEFAULTS.localTimeoutMs, 1000, 120000),
    localFetchTimeoutMs: integer(raw.localFetchTimeoutMs, 'localFetchTimeoutMs', DEFAULTS.localFetchTimeoutMs, 1000, 120000),
    localMaxBytes: integer(raw.localMaxBytes, 'localMaxBytes', DEFAULTS.localMaxBytes, 65536, 20000000),
    localFetchMaxChars: integer(raw.localFetchMaxChars, 'localFetchMaxChars', DEFAULTS.localFetchMaxChars, 500, 400000),
    localMaxLinks: integer(raw.localMaxLinks, 'localMaxLinks', DEFAULTS.localMaxLinks, 0, 100),
    keepNoise: boolean(raw.keepNoise, 'keepNoise', DEFAULTS.keepNoise),
    cookieBrowser: browserId(raw.cookieBrowser),
    cookieHeader: header(raw.cookieHeader),
    cookiesBySource: cookiesBySource(raw.cookiesBySource),
    cookieWarmUp: boolean(raw.cookieWarmUp, 'cookieWarmUp', DEFAULTS.cookieWarmUp),
  })
}

/**
 * @typedef {object} ResolvedConfig
 * @property {'official' | 'local' | 'auto'} mode
 * @property {string} officialSearchProvider
 * @property {string} officialFetchProvider
 * @property {readonly string[]} localSources
 * @property {number} localMaxPages
 * @property {number} localTimeoutMs
 * @property {number} localFetchTimeoutMs
 * @property {number} localMaxBytes
 * @property {number} localFetchMaxChars
 * @property {number} localMaxLinks
 * @property {boolean} keepNoise
 * @property {string} cookieBrowser
 * @property {string} cookieHeader
 * @property {Readonly<Record<string, string>>} cookiesBySource
 * @property {boolean} cookieWarmUp
 */

/**
 * Freeze one resolved config so no consumer can mutate shared state.
 *
 * @param {any} config - resolved values.
 * @returns {ResolvedConfig} the frozen config.
 */
function finish(config) {
  Object.freeze(config.localSources)
  return Object.freeze(config)
}

/**
 * Read a non-empty string field.
 *
 * @param {unknown} value - raw value.
 * @param {string} key - field name.
 * @param {string} fallback - default.
 * @returns {string} the resolved value.
 */
function text(value, key, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${key} must be a non-empty string`)
  return value.trim()
}

/**
 * Read an integer field within bounds.
 *
 * @param {unknown} value - raw value.
 * @param {string} key - field name.
 * @param {number} fallback - default.
 * @param {number} min - inclusive lower bound.
 * @param {number} max - inclusive upper bound.
 * @returns {number} the resolved value.
 */
function integer(value, key, fallback, min, max) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer from ${min} to ${max}; got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Read a boolean field.
 *
 * @param {unknown} value - raw value.
 * @param {string} key - field name.
 * @param {boolean} fallback - default.
 * @returns {boolean} the resolved value.
 */
function boolean(value, key, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`)
  return value
}

/**
 * Read and validate the ordered local source list.
 *
 * @param {unknown} value - raw value.
 * @returns {readonly string[]} the sources.
 */
function sources(value) {
  if (value === undefined) return Object.freeze([...SOURCE_IDS])
  if (!Array.isArray(value) || value.length === 0) throw new Error('localSources must be a non-empty array of source ids')
  const seen = new Set()
  for (const entry of value) {
    if (typeof entry !== 'string' || !SOURCE_IDS.includes(entry)) {
      throw new Error(`localSources entries must be one of ${SOURCE_IDS.join(', ')}; got ${JSON.stringify(entry)}`)
    }
    if (seen.has(entry)) throw new Error(`localSources lists ${JSON.stringify(entry)} twice`)
    seen.add(entry)
  }
  return Object.freeze([.../** @type {string[]} */ (value)])
}

/**
 * Read the browser id whose cookies to import.
 *
 * @param {unknown} value - raw value.
 * @returns {string} the browser id.
 */
function browserId(value) {
  if (value === undefined) return DEFAULTS.cookieBrowser
  if (typeof value !== 'string') throw new Error('cookieBrowser must be a string')
  const allowed = ['none', 'edge', 'chrome', 'chromium', 'brave']
  if (!allowed.includes(value)) {
    throw new Error(`cookieBrowser must be one of ${allowed.join(', ')}; got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Read the literal Cookie header, validating its `name=value; …` shape so a
 * pasted header with a stray newline cannot inject a second header.
 *
 * @param {unknown} value - raw value.
 * @returns {string} the header.
 */
function header(value) {
  if (value === undefined || value === null) return DEFAULTS.cookieHeader
  if (typeof value !== 'string') throw new Error('cookieHeader must be a string')
  const trimmed = value.trim()
  if (trimmed === '') return ''
  if (/[\r\n]/.test(trimmed)) throw new Error('cookieHeader must be a single line')
  if (!/^[^=;\s]+=[^;]*(;\s*[^=;\s]+=[^;]*)*$/.test(trimmed)) {
    throw new Error('cookieHeader must look like "name=value; name2=value2"')
  }
  return trimmed
}

/**
 * Read the per-source cookie map.
 *
 * Validates each entry the same way as the legacy header, and rejects unknown
 * source ids so a typo does not silently configure nothing.
 *
 * @param {unknown} value - raw value.
 * @returns {Readonly<Record<string, string>>} the headers, frozen.
 */
function cookiesBySource(value) {
  if (value === undefined || value === null) return Object.freeze({})
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('cookiesBySource must be an object of source id → Cookie header')
  }
  /** @type {Record<string, string>} */
  const out = {}
  for (const [id, raw] of Object.entries(value)) {
    if (!SOURCE_IDS.includes(id)) {
      throw new Error(`cookiesBySource key must be one of ${SOURCE_IDS.join(', ')}; got ${JSON.stringify(id)}`)
    }
    const parsed = header(raw)
    if (parsed !== '') out[id] = parsed
  }
  return Object.freeze(out)
}

/**
 * Resolve one config from defaults plus a partial change.
 *
 * @param {Partial<ResolvedConfig>} patch - fields to replace.
 * @returns {ResolvedConfig} the resolved configuration.
 */
export function withDefaults(patch) {
  return resolveConfig({ ...DEFAULTS, ...patch })
}