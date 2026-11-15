/**
 * Cube_DSH_Free local search — Host half.
 *
 * Registers one search provider and one fetch provider with `ctx.web` under the
 * same id (`cube-dsh-free`); each dispatches per call according to the
 * configured mode. The model-facing `web_search` / `web_fetch` tools, their
 * schemas, and their rendered text are untouched: this plugin only fills the
 * backend behind `ctx.web`, so the tool list gains no entry.
 *
 * @module cube-dsh-free
 */

import { Config, resolveConfig } from './lib/config.js'
import { CubeFetchProvider, CubeSearchProvider } from './lib/provider.js'

export { Config }

/** The web seam is the whole extension point this plugin needs. */
export const inject = ['web']

/**
 * Read one config field, unwrapping a volatile reference when the Loader
 * wrapped it (the settings page writes `mode` live through that reference).
 *
 * @param {any} config - the fiber's resolved config.
 * @param {string} key - field name.
 * @returns {any} the current value.
 */
function field(config, key) {
  const value = config?.[key]
  if (value !== null && typeof value === 'object' && typeof value.get === 'function' && !Array.isArray(value)) {
    return value.get()
  }
  return value
}

/**
 * Snapshot the live config into one plain resolved object.
 *
 * Called at the start of every operation, so a mode switched in the settings
 * page takes effect on the next call and one call never mixes two configs.
 *
 * @param {any} config - the fiber's resolved config.
 * @returns {import('./lib/config.js').ResolvedConfig} the resolved snapshot.
 */
function snapshot(config) {
  return resolveConfig({
    mode: field(config, 'mode'),
    officialSearchProvider: field(config, 'officialSearchProvider'),
    officialFetchProvider: field(config, 'officialFetchProvider'),
    localSources: field(config, 'localSources'),
    // These two are easy to forget here, and forgetting them is silent: the
    // values exist in the config, resolveConfig fills defaults for the keys it
    // is not given, and the plugin then searches with no cookies and no custom
    // sources while the settings page still shows them stored. That is exactly
    // what "my cookies vanished after the update" looked like.
    customSources: field(config, 'customSources'),
    cookiesBySource: field(config, 'cookiesBySource'),
    localMaxPages: field(config, 'localMaxPages'),
    localTimeoutMs: field(config, 'localTimeoutMs'),
    localFetchTimeoutMs: field(config, 'localFetchTimeoutMs'),
    localMaxBytes: field(config, 'localMaxBytes'),
    localFetchMaxChars: field(config, 'localFetchMaxChars'),
    localMaxLinks: field(config, 'localMaxLinks'),
    keepNoise: field(config, 'keepNoise'),
    cookieBrowser: field(config, 'cookieBrowser'),
    cookieHeader: field(config, 'cookieHeader'),
    cookieWarmUp: field(config, 'cookieWarmUp'),
  })
}

/**
 * Host plugin body: two registrations, both fiber-scoped.
 *
 * @param {any} ctx - the plugin context (with `web` injected).
 * @param {any} config - the resolved Loader row config.
 */
export function apply(ctx, config) {
  const readConfig = () => snapshot(config)

  // The official layer is reached through the seam's own registry maps rather
  // than by re-creating official providers: the deployment's keys, endpoints,
  // and account sign-in then apply unchanged, and its error codes are the ones
  // that surface in a layered failure. A composition whose seam shape differs
  // simply reports the official layer as unreachable instead of failing to load.
  /** @type {import('./lib/provider.js').BackendLayers} */
  const layers = {
    officialSearch(config) {
      return lookup(ctx.web, 'searchProviders', config.officialSearchProvider, 'search')
    },
    officialFetch(config) {
      return lookup(ctx.web, 'fetchProviders', config.officialFetchProvider, 'fetch')
    },
  }

  ctx.effect(
    () => ctx.web.registerSearchProvider(new CubeSearchProvider(readConfig, layers)),
    'cube-dsh-free: web search provider',
  )
  ctx.effect(
    () => ctx.web.registerFetchProvider(new CubeFetchProvider(readConfig, layers)),
    'cube-dsh-free: web fetch provider',
  )
}

/**
 * Resolve one registered provider from the seam.
 *
 * @param {any} web - the `ctx.web` service.
 * @param {'searchProviders' | 'fetchProviders'} registry - which registry.
 * @param {string} id - configured provider id.
 * @param {'search' | 'fetch'} operation - the method to expose.
 * @returns {import('./lib/provider.js').OfficialProvider | undefined} the adapter, if registered.
 */
function lookup(web, registry, id, operation) {
  const table = web?.[registry]
  if (!(table instanceof Map)) return undefined
  const provider = table.get(id)
  if (provider === undefined || typeof provider[operation] !== 'function') return undefined
  return {
    id: provider.id,
    available: () => {
      try {
        return provider.available() === true
      } catch {
        return false
      }
    },
    call: (request, signal) => provider[operation](request, signal),
  }
}