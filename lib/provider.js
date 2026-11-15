/**
 * The composed backend: one search provider and one fetch provider registered
 * with `ctx.web` under the same stable id, each dispatching per call according
 * to the configured mode.
 *
 * Why one composed provider instead of swapping the configured provider id:
 * the seam resolves its provider by id at call time, so pointing it at a
 * different id per mode would (a) make "auto" impossible inside one call and
 * (b) change what the seam reports when it is unavailable. A composed provider
 * keeps selection stable, keeps the fallback inside this plugin's own execution
 * logic, and makes the layered error message the only thing a caller reads.
 *
 * The official layer is never re-implemented here: the plugin reaches the
 * already-registered official providers through the seam's own registries and
 * calls them directly. This plugin therefore inherits the deployment's official
 * configuration (keys, endpoints, account sign-in) and its error codes instead
 * of duplicating them.
 *
 * @module cube-dsh-free/provider
 */

import { BOTH_FAILED_CODE, describeError, errorWithCode, failure, isCancellation } from './errors.js'
import { fetchLocal } from './fetch.js'
import { searchLocal } from './search.js'
import { createJar } from './cookies.js'
import { jarsBySource } from './source-cookies.js'
import { sourceHosts } from './sources.js'

/** The plugin's search provider id. */
export const SEARCH_PROVIDER_ID = 'cube-dsh-free'

/** The plugin's fetch provider id. */
export const FETCH_PROVIDER_ID = 'cube-dsh-free'

/**
 * @typedef {object} OfficialProvider
 * @property {string} id
 * @property {() => boolean} available
 * @property {(request: any, signal?: AbortSignal) => Promise<any>} call
 */

/**
 * @typedef {object} BackendLayers
 * @property {(config: import('./config.js').ResolvedConfig) => OfficialProvider | undefined} officialSearch
 * @property {(config: import('./config.js').ResolvedConfig) => OfficialProvider | undefined} officialFetch
 */

/**
 * Search provider: official, local, or official-then-local.
 */
export class CubeSearchProvider {
  /**
   * @param {() => import('./config.js').ResolvedConfig} readConfig - live config snapshot reader.
   * @param {BackendLayers} layers - official-layer lookup.
   */
  constructor(readConfig, layers) {
    this.id = SEARCH_PROVIDER_ID
    this.readConfig = readConfig
    this.layers = layers
  }

  /**
   * Usable whenever one layer could run; the seam requires a cheap local check
   * that never makes a network call.
   *
   * @returns {boolean} always true — a mode failure surfaces as a structured error.
   */
  available() {
    return true
  }

  /**
   * Search through the configured mode.
   *
   * @param {{ query: string, maxResults?: number }} request - the seam's request.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<import('./types.js').WebSearchResult>} the result.
   */
  async search(request, signal) {
    const config = this.readConfig()
    if (config.mode === 'local') return this.searchLocalOnly(request, signal, config)
    const official = this.layers.officialSearch(config)
    if (config.mode === 'official') return this.searchOfficialOnly(official, request, signal, config)
    return this.searchAuto(official, request, signal, config)
  }

  /**
   * Official-only search: the official failure is the call's failure.
   *
   * @param {OfficialProvider | undefined} official - resolved official provider.
   * @param {{ query: string, maxResults?: number }} request - the request.
   * @param {AbortSignal | undefined} signal - cancellation.
   * @param {import('./config.js').ResolvedConfig} config - live config.
   * @returns {Promise<import('./types.js').WebSearchResult>} the result.
   */
  async searchOfficialOnly(official, request, signal, config) {
    if (official === undefined) {
      throw failure('request', officialMissingReason('搜索', config.officialSearchProvider, config.mode))
    }
    if (!official.available()) {
      throw failure('request', officialUnavailableReason('搜索', config.officialSearchProvider, config.mode))
    }
    const result = await official.call(request, signal)
    // Never hand back an empty list: to the model that reads as "the web has
    // nothing", which is a different and false statement from "this call
    // produced nothing".
    if (!Array.isArray(result?.sources) || result.sources.length === 0) {
      throw failure(
        'empty',
        `官方搜索 provider “${config.officialSearchProvider}” 对“${request.query}”返回了 0 条结果`
        + `（当前模式是“${modeLabel(config.mode)}”，不会退回本地）`,
      )
    }
    return result
  }

  /**
   * Local-only search.
   *
   * @param {{ query: string, maxResults?: number }} request - the request.
   * @param {AbortSignal | undefined} signal - cancellation.
   * @param {import('./config.js').ResolvedConfig} config - live config.
   * @returns {Promise<import('./types.js').WebSearchResult>} the result.
   */
  async searchLocalOnly(request, signal, config) {
    // One jar per source, per call: each engine searches with its own session,
    // and every jar dies with the call. A browser import, when enabled, seeds
    // all of them from the one profile.
    const jars = jarsBySource(
      { cookiesBySource: config.cookiesBySource, cookieHeader: config.cookieHeader },
      config.localSources,
    )
    if (config.cookieBrowser !== 'none') {
      const imported = await createJar({
        cookieBrowser: config.cookieBrowser,
        cookieHeader: '',
        sourceHosts: sourceHosts(config.localSources),
      })
      for (const jar of jars.values()) {
        // Seed every per-source jar from the imported session; the jar's own
        // domain matching decides which cookies a host actually receives.
        jar.import([...imported.entries()])
      }
    }
    const outcome = await searchLocal(
      request.query,
      { ...localSearchOptions(config, request.maxResults), jarsBySource: jars, warmUp: config.cookieWarmUp },
      signal,
    )
    return { sources: outcome.sources, truncated: outcome.truncated }
  }

  /**
   * Auto search: official first, local when official fails or yields nothing.
   *
   * The switch happens inside this one call, so the caller receives a single
   * result — and, when both layers fail, a single error naming both layers.
   *
   * @param {OfficialProvider | undefined} official - resolved official provider.
   * @param {{ query: string, maxResults?: number }} request - the request.
   * @param {AbortSignal | undefined} signal - cancellation.
   * @param {import('./config.js').ResolvedConfig} config - live config.
   * @returns {Promise<import('./types.js').WebSearchResult>} the result.
   */
  async searchAuto(official, request, signal, config) {
    let officialError
    if (official === undefined) {
      officialError = new Error(officialMissingReason('搜索', config.officialSearchProvider, config.mode))
    } else if (!official.available()) {
      officialError = new Error(officialUnavailableReason('搜索', config.officialSearchProvider, config.mode))
    } else {
      try {
        const result = await official.call(request, signal)
        if (result.sources.length > 0) return result
        officialError = new Error('官方搜索返回了 0 条结果')
      } catch (error) {
        if (isCancellation(error, signal)) throw error
        officialError = error
      }
    }
    try {
      return await this.searchLocalOnly(request, signal, config)
    } catch (error) {
      if (isCancellation(error, signal)) throw error
      throw errorWithCode(
        BOTH_FAILED_CODE,
        `“${request.query}”搜索失败：官方 API（${config.officialSearchProvider}）与本地后端都没有拿到结果。\n`
        + `- 官方这一层：${describeError(officialError)}\n`
        + `- 本地这一层：${describeError(error)}`,
        { cause: error },
      )
    }
  }
}

/**
 * Fetch provider: official, local, or official-then-local.
 */
export class CubeFetchProvider {
  /**
   * @param {() => import('./config.js').ResolvedConfig} readConfig - live config snapshot reader.
   * @param {BackendLayers} layers - official-layer lookup.
   */
  constructor(readConfig, layers) {
    this.id = FETCH_PROVIDER_ID
    this.readConfig = readConfig
    this.layers = layers
  }

  /**
   * A local fetch is always possible; the seam requires a cheap local check.
   *
   * @returns {boolean} always true.
   */
  available() {
    return true
  }

  /**
   * Fetch through the configured mode.
   *
   * @param {{ url: string }} request - the seam's request.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<import('./types.js').WebFetchResult>} the result.
   */
  async fetch(request, signal) {
    const config = this.readConfig()
    if (config.mode === 'local') return this.fetchLocalOnly(request, signal, config)
    const official = this.layers.officialFetch(config)
    if (config.mode === 'official') return this.fetchOfficialOnly(official, request, signal, config)
    return this.fetchAuto(official, request, signal, config)
  }

  /**
   * Official-only fetch.
   *
   * @param {OfficialProvider | undefined} official - resolved official provider.
   * @param {{ url: string }} request - the request.
   * @param {AbortSignal | undefined} signal - cancellation.
   * @param {import('./config.js').ResolvedConfig} config - live config.
   * @returns {Promise<import('./types.js').WebFetchResult>} the result.
   */
  async fetchOfficialOnly(official, request, signal, config) {
    if (official === undefined) {
      throw failure('request', officialMissingReason('抓取', config.officialFetchProvider, config.mode))
    }
    if (!official.available()) {
      throw failure('request', officialUnavailableReason('抓取', config.officialFetchProvider, config.mode))
    }
    const result = await official.call(request, signal)
    // An empty body is "no content", not a fetch result: returning it would hand
    // the model a blank page it cannot distinguish from a real one.
    if (typeof result?.body?.content !== 'string' || result.body.content.trim() === '') {
      throw failure(
        'empty',
        `官方抓取 provider “${config.officialFetchProvider}” 对 ${request.url} 返回了空正文`
        + `（HTTP ${result?.statusCode ?? '?'}；当前模式是“${modeLabel(config.mode)}”，不会退回本地）`,
      )
    }
    return result
  }

  /**
   * Local-only fetch, rendered into the seam's body union.
   *
   * @param {{ url: string }} request - the request.
   * @param {AbortSignal | undefined} signal - cancellation.
   * @param {import('./config.js').ResolvedConfig} config - live config.
   * @returns {Promise<import('./types.js').WebFetchResult>} the result.
   */
  async fetchLocalOnly(request, signal, config) {
    const outcome = await fetchLocal(request.url, localFetchOptions(config), signal)
    return toFetchResult(outcome)
  }

  /**
   * Auto fetch: official first, local on failure or empty content.
   *
   * @param {OfficialProvider | undefined} official - resolved official provider.
   * @param {{ url: string }} request - the request.
   * @param {AbortSignal | undefined} signal - cancellation.
   * @param {import('./config.js').ResolvedConfig} config - live config.
   * @returns {Promise<import('./types.js').WebFetchResult>} the result.
   */
  async fetchAuto(official, request, signal, config) {
    let officialError
    if (official === undefined) {
      officialError = new Error(officialMissingReason('抓取', config.officialFetchProvider, config.mode))
    } else if (!official.available()) {
      officialError = new Error(officialUnavailableReason('抓取', config.officialFetchProvider, config.mode))
    } else {
      try {
        const result = await official.call(request, signal)
        if (typeof result?.body?.content === 'string' && result.body.content.trim() !== '') return result
        officialError = new Error(`官方抓取返回了空正文（HTTP ${result?.statusCode ?? '?'}）`)
      } catch (error) {
        if (isCancellation(error, signal)) throw error
        officialError = error
      }
    }
    try {
      return await this.fetchLocalOnly(request, signal, config)
    } catch (error) {
      if (isCancellation(error, signal)) throw error
      throw errorWithCode(
        BOTH_FAILED_CODE,
        `抓取 ${request.url} 失败：官方 API（${config.officialFetchProvider}）与本地后端都没有拿到内容。\n`
        + `- 官方这一层：${describeError(officialError)}\n`
        + `- 本地这一层：${describeError(error)}`,
        { cause: error },
      )
    }
  }
}

/**
 * Explain why the configured official provider could not be used, in terms the
 * user can act on.
 *
 * @param {'搜索' | '抓取'} operation - 搜索 or 抓取.
 * @param {string} id - the configured provider id.
 * @param {string} mode - the active mode.
 * @returns {string} the reason.
 */
function officialMissingReason(operation, id, mode) {
  return `官方${operation} provider “${id}” 没有在这个 DSH 组合里注册；当前模式是“${modeLabel(mode)}”。 `
    + '请在“网页搜索后端”设置页把官方 provider 改成已注册的 id，或改用“本地 API”。'
}

/**
 * Explain why a registered official provider is currently unusable.
 *
 * @param {'搜索' | '抓取'} operation - 搜索 or 抓取.
 * @param {string} id - the configured provider id.
 * @param {string} mode - the active mode.
 * @returns {string} the reason.
 */
function officialUnavailableReason(operation, id, mode) {
  return `官方${operation} provider “${id}” 已注册但当前不可用（常见原因：没有可用的 API Key 或账号未登录）；`
    + `当前模式是“${modeLabel(mode)}”。请先在“模型”页配置密钥，或切换到“自动切换”/“本地 API”。`
}

/**
 * Human label for a mode value.
 *
 * @param {string} mode - official / local / auto.
 * @returns {string} the label.
 */
function modeLabel(mode) {
  if (mode === 'official') return '官方 API'
  if (mode === 'local') return '本地 API'
  return '自动切换'
}

/**
 * Bounds for one local search call.
 *
 * @param {import('./config.js').ResolvedConfig} config - live config.
 * @param {number | undefined} maxResults - the caller's cap.
 * @returns {import('./search.js').SearchOptions} the options.
 */
export function localSearchOptions(config, maxResults) {
  return {
    sourceIds: config.localSources,
    maxResults: Math.min(Math.max(maxResults ?? 8, 1), 20),
    maxPages: config.localMaxPages,
    timeoutMs: config.localTimeoutMs,
    maxBytes: config.localMaxBytes,
    maxChars: 800_000,
  }
}

/**
 * Bounds for one local fetch call.
 *
 * @param {import('./config.js').ResolvedConfig} config - live config.
 * @returns {import('./fetch.js').FetchOptions} the options.
 */
export function localFetchOptions(config) {
  return {
    maxChars: config.localFetchMaxChars,
    maxBytes: config.localMaxBytes,
    timeoutMs: config.localFetchTimeoutMs,
    maxLinks: config.localMaxLinks,
    keepNoise: config.keepNoise,
  }
}

/**
 * Render local extraction into the seam's fetch result shape.
 *
 * The seam's `body` union has `html` and `text` arms; extracted article text is
 * plain text, so it travels as `text`. The title is prepended because the seam
 * has no separate title field and the model needs it to name the source.
 *
 * @param {import('./fetch.js').FetchOutcome} outcome - the extraction.
 * @returns {import('./types.js').WebFetchResult} the seam result.
 */
export function toFetchResult(outcome) {
  const header = outcome.title === '' ? outcome.url : `${outcome.title}\n${outcome.url}`
  const links = outcome.links.length === 0
    ? ''
    : `\n\n相关链接：\n${outcome.links.map(link => `- ${link.url}`).join('\n')}`
  return {
    url: outcome.url,
    statusCode: outcome.status,
    body: { kind: 'text', content: `${header}\n\n${outcome.content}${links}` },
    truncated: outcome.truncated,
  }
}

/**
 * @typedef {object} WebSearchResult
 * @property {string} [content]
 * @property {Array<{ url: string, title?: string, snippet?: string, publishedAt?: string }>} sources
 * @property {boolean} truncated
 */

/**
 * @typedef {object} WebFetchResult
 * @property {string} url
 * @property {number} statusCode
 * @property {{ kind: 'html' | 'text', content: string }} body
 * @property {boolean} truncated
 */