/**
 * Failure vocabulary for the local web backend.
 *
 * Four situations stay distinct, because the caller's recovery differs:
 *
 * - `request`  — the network request itself failed (DNS, TLS, reset, timeout,
 *                or a non-2xx status that is not an explicit block);
 * - `blocked`  — the source answered but refused to serve content (403/429,
 *                captcha or interstitial), so retrying the same source is
 *                pointless while a different source may work;
 * - `parse`    — bytes arrived but they are not the document shape the source
 *                promised (non-HTML, unreadable encoding, truncated payload);
 * - `empty`    — the document parsed cleanly and genuinely carries nothing
 *                (no result blocks, or no extractable body text).
 *
 * Codes are stable and prefixed, so the tool registry surfaces them in
 * structured error metadata and a caller can route on them.
 *
 * The error class is the harness's own `WebError` when the package resolves in
 * this process, so `error.info.code` reaches the model. A composition that does
 * not ship that package still loads: the fallback carries the same `code` and
 * the reason in its message.
 *
 * @module cube-dsh-free/errors
 */

/** Stable code per failure kind. */
export const FAILURE_CODES = Object.freeze({
  request: 'CUBE_WEB_REQUEST_FAILED',
  blocked: 'CUBE_WEB_BLOCKED',
  parse: 'CUBE_WEB_UNPARSABLE',
  empty: 'CUBE_WEB_EMPTY',
})

/** Code for a mode where both layers failed and neither produced content. */
export const BOTH_FAILED_CODE = 'CUBE_WEB_BOTH_FAILED'

/** Human prefixes that keep the reason legible in one error line. */
const FAILURE_LABELS = Object.freeze({
  request: '请求失败',
  blocked: '被拦截',
  parse: 'HTML 无法解析',
  empty: '确实无内容',
})

/**
 * Fallback error type used only when the harness `WebError` class cannot be
 * imported. It keeps `code` and `name` so error metadata stays routable.
 */
export class CubeWebError extends Error {
  /**
   * @param {string} message - caller-facing reason.
   * @param {string} code - stable machine code.
   * @param {{ cause?: unknown }} [options] - underlying failure.
   */
  constructor(message, code, options) {
    super(message, options)
    this.code = code
    this.name = 'CubeWebError'
  }
}

/**
 * The harness error class, resolved once at module load.
 *
 * A top-level await is safe here: the Loader imports plugin modules
 * asynchronously, so the module simply settles before `apply` runs.
 *
 * @returns {Promise<new (message: string, code: string, options?: { cause?: unknown }) => Error>} the class.
 */
async function resolveErrorClass() {
  try {
    const mod = await import('@deepseek-ai/dsh-web')
    if (typeof mod?.WebError === 'function') return mod.WebError
  } catch {
    // The package is absent in a composition that mounts another seam; the
    // fallback keeps the plugin loadable with the same code vocabulary.
  }
  return CubeWebError
}

/** The error constructor used for every classified failure. */
const ErrorClass = await resolveErrorClass()

/**
 * Build one failure with the layer's label baked into the message, so a single
 * line already says both *what* failed and *how*.
 *
 * @param {'request' | 'blocked' | 'parse' | 'empty'} kind - the classified situation.
 * @param {string} detail - what happened, without the classification prefix.
 * @param {{ cause?: unknown, source?: string }} [options] - extra context.
 * @returns {Error} the throwable.
 */
export function failure(kind, detail, options = {}) {
  const label = FAILURE_LABELS[kind] ?? kind
  const source = options.source === undefined ? '' : `[${options.source}] `
  return new ErrorClass(
    `${source}${label}：${detail}`,
    FAILURE_CODES[kind] ?? FAILURE_CODES.request,
    options.cause === undefined ? undefined : { cause: options.cause },
  )
}

/**
 * Build one unclassified failure (a missing provider, a composed both-layers
 * error) with an explicit code.
 *
 * @param {string} code - stable machine code.
 * @param {string} message - caller-facing reason.
 * @param {{ cause?: unknown }} [options] - underlying failure.
 * @returns {Error} the throwable.
 */
export function errorWithCode(code, message, options = {}) {
  return new ErrorClass(message, code, options.cause === undefined ? undefined : { cause: options.cause })
}

/**
 * Whether an error is one this plugin classified.
 *
 * @param {unknown} error - caught value.
 * @returns {boolean} true for a local-backend failure.
 */
export function isCubeFailure(error) {
  const code = /** @type {any} */ (error)?.code
  return typeof code === 'string' && code.startsWith('CUBE_WEB_')
}

/**
 * Render any thrown value as `CODE: message` for a layered error line.
 *
 * @param {unknown} error - caught value.
 * @returns {string} one-line description.
 */
export function describeError(error) {
  if (error === undefined || error === null) return '未知错误'
  const code = /** @type {any} */ (error)?.code
  const message = error instanceof Error ? error.message : String(error)
  return typeof code === 'string' && code !== '' ? `${code}: ${message}` : message
}

/**
 * Whether an abort is the caller's cancellation rather than a local failure.
 *
 * @param {unknown} error - caught value.
 * @param {AbortSignal | undefined} signal - the caller's signal.
 * @returns {boolean} true when the caller cancelled.
 */
export function isCancellation(error, signal) {
  if (signal?.aborted === true) return true
  const name = /** @type {any} */ (error)?.name
  return name === 'AbortError' && /** @type {any} */ (error)?.code !== 'CUBE_WEB_REQUEST_FAILED'
}