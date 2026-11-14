/**
 * Read cookies for named hosts out of an installed Chromium browser.
 *
 * What is actually possible, measured on this platform:
 *
 * - **The database file** is SQLite at
 *   `<userData>/<profile>/Network/Cookies`. While the browser runs it holds an
 *   exclusive lock, so the file must be copied before it can be opened; a copy
 *   is enough because the page never writes.
 * - **Cookie payload encryption** is the blocker. Chromium encrypts values with
 *   AES-GCM under a key that, before `v20`, was sealed with DPAPI for the
 *   current user and could be unwrapped from Node through a small native call.
 *   Current builds write `v20` + an app-bound key that only the browser process
 *   can unwrap (the "App-Bound Encryption" hardening), so a `v20` payload is
 *   **not decryptable outside the browser**. This module detects that case and
 *   reports it, rather than shipping a decryption path that cannot work.
 * - **DPAPI unwrapping** (for a legacy `v10`/`v11` payload) needs a native
 *   call. On Windows that is `CryptUnprotectData` from crypt32. It is invoked
 *   through PowerShell's `ProtectedData`, which is part of the OS, so no
 *   dependency is added and no binary is shipped.
 *
 * Every read is scoped to the hosts the caller names, and the values never
 * leave the process.
 *
 * @module cube-dsh-free/browser-cookies
 */

import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Where each supported browser keeps its user-data directory, per platform. */
const BROWSER_ROOTS = Object.freeze({
  edge: {
    win32: () => join(process.env.LOCALAPPDATA ?? '', 'Microsoft/Edge/User Data'),
    darwin: () => join(homedir(), 'Library/Application Support/Microsoft Edge'),
    linux: () => join(homedir(), '.config/microsoft-edge'),
  },
  chrome: {
    win32: () => join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/User Data'),
    darwin: () => join(homedir(), 'Library/Application Support/Google/Chrome'),
    linux: () => join(homedir(), '.config/google-chrome'),
  },
  chromium: {
    win32: () => join(process.env.LOCALAPPDATA ?? '', 'Chromium/User Data'),
    darwin: () => join(homedir(), 'Library/Application Support/Chromium'),
    linux: () => join(homedir(), '.config/chromium'),
  },
  brave: {
    win32: () => join(process.env.LOCALAPPDATA ?? '', 'BraveSoftware/Brave-Browser/User Data'),
    darwin: () => join(homedir(), 'Library/Application Support/BraveSoftware/Brave-Browser'),
    linux: () => join(homedir(), '.config/BraveSoftware/Brave-Browser'),
  },
})

/** Profile directories to try, most-used first. */
const PROFILE_DIRS = Object.freeze(['Default', 'Profile 1', 'Profile 2'])

/**
 * Browser ids this module can read.
 *
 * @returns {string[]} supported ids.
 */
export function supportedBrowsers() {
  return Object.keys(BROWSER_ROOTS)
}

/**
 * Read cookies for some hosts from one browser profile.
 *
 * @param {string} browser - browser id from {@link supportedBrowsers}.
 * @param {string[]} hosts - hosts to read, e.g. `['www.bing.com', 'baidu.com']`.
 * @returns {Promise<{ cookies: import('./cookies.js').StoredCookie[] } | { error: string }>}
 *   the cookies, or a reason they could not be read.
 */
export async function readCookieDatabase(browser, hosts) {
  const roots = BROWSER_ROOTS[browser]
  if (roots === undefined) return { error: `不支持的浏览器 ${JSON.stringify(browser)}` }
  const rootForPlatform = roots[process.platform]
  if (rootForPlatform === undefined) return { error: `${browser} 在 ${process.platform} 上没有已知的配置目录` }
  const root = rootForPlatform()
  if (root === '' || !existsSync(root)) return { error: `没有找到 ${browser} 的配置目录` }

  /** @type {string[]} */
  const reasons = []
  for (const profile of PROFILE_DIRS) {
    const database = join(root, profile, 'Network/Cookies')
    if (!existsSync(database)) continue
    /** @type {string | undefined} */
    let scratch
    try {
      // A running browser holds an exclusive lock on this file. Opening it
      // read-only is attempted first (SQLite permits concurrent readers on the
      // same file on Windows); only when that is refused is a copy made, which
      // some browsers' advisory locks also block.
      const rows = tryRead(database, hosts) ?? (() => {
        scratch = mkdtempSync(join(tmpdir(), 'cube-cookies-'))
        const copy = join(scratch, 'Cookies')
        copyFileSync(database, copy)
        return readRows(copy, hosts)
      })()
      if (rows.length === 0) {
        reasons.push(`${profile}: 没有匹配这些域名的 cookie`)
        continue
      }
      const decoded = await decodeRows(rows, root, profile)
      if ('cookies' in decoded) {
        if (decoded.cookies.length === 0) {
          reasons.push(`${profile}: ${decoded.reason}`)
          continue
        }
        return { cookies: decoded.cookies }
      }
      reasons.push(`${profile}: ${decoded.error}`)
    } catch (error) {
      reasons.push(`${profile}: ${explainReadFailure(error)}`)
    } finally {
      if (scratch !== undefined) {
        try {
          rmSync(scratch, { recursive: true, force: true })
        } catch {
          // A leftover temp directory is harmless.
        }
      }
    }
  }
  return { error: reasons.length === 0 ? `没有找到 ${browser} 的 Cookie 数据库` : reasons.join('；') }
}

/**
 * Try to read the live database in place.
 *
 * @param {string} path - the live database.
 * @param {string[]} hosts - hosts to match.
 * @returns {Array<object> | undefined} the rows, or undefined when the file is locked.
 */
function tryRead(path, hosts) {
  try {
    return readRows(path, hosts)
  } catch {
    return undefined
  }
}

/**
 * Read matching rows from a copied cookie database.
 *
 * Columns are cast in SQL so `node:sqlite` never has to widen a 64-bit
 * `expires_utc` into a JavaScript number (which it refuses to do implicitly).
 *
 * @param {string} path - the copied database.
 * @param {string[]} hosts - hosts to match.
 * @returns {Array<{ host: string, name: string, value: string, encrypted: string, expires: number }>} the rows.
 */
function readRows(path, hosts) {
  const { DatabaseSync } = require_('node:sqlite')
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const clauses = hosts.map(() => '(host_key = ? OR host_key = ? OR host_key LIKE ?)').join(' OR ')
    /** @type {unknown[]} */
    const parameters = []
    for (const host of hosts) {
      const bare = host.replace(/^\./, '').toLowerCase()
      parameters.push(bare, `.${bare}`, `%.${bare}`)
    }
    const statement = database.prepare(
      `SELECT host_key, name, CAST(value AS TEXT) AS value, hex(encrypted_value) AS encrypted,`
      + ` CAST(expires_utc / 1000000 AS INTEGER) AS expires_seconds FROM cookies WHERE ${clauses}`,
    )
    return statement.all(...parameters).map(row => ({
      host: String(row.host_key),
      name: String(row.name),
      value: String(row.value ?? ''),
      encrypted: String(row.encrypted ?? ''),
      expires: chromiumTime(Number(row.expires_seconds ?? 0)),
    }))
  } finally {
    database.close()
  }
}

/**
 * Load a built-in module without a bundler rewriting the specifier.
 *
 * @param {string} name - module name.
 * @returns {any} the module namespace.
 */
function require_(name) {
  const loader = /** @type {any} */ (globalThis).process?.getBuiltinModule
  if (typeof loader === 'function') return loader.call(process, name)
  throw new Error(`cannot load ${name}`)
}

/**
 * Convert Chromium's microseconds-since-1601 to Unix seconds.
 *
 * @param {number} secondsSince1601 - seconds since 1601 (already divided).
 * @returns {number} epoch seconds, or 0 when the cookie is a session cookie.
 */
function chromiumTime(secondsSince1601) {
  if (!Number.isFinite(secondsSince1601) || secondsSince1601 <= 0) return 0
  return Math.floor(secondsSince1601 - 11_644_473_600)
}

/**
 * Decode the encrypted values of the rows.
 *
 * @param {Array<{ host: string, name: string, value: string, encrypted: string, expires: number }>} rows - database rows.
 * @param {string} root - the browser's user-data directory.
 * @param {string} profile - the profile directory name.
 * @returns {Promise<{ cookies: import('./cookies.js').StoredCookie[] } | { error: string } | { cookies: [], reason: string }>}
 *   the decoded cookies, or a reason.
 */
async function decodeRows(rows, root, profile) {
  /** @type {import('./cookies.js').StoredCookie[]} */
  const cookies = []
  let plain = 0
  /** @type {string[]} */
  const blocked = []
  /** @type {string[][]} */
  const needKey = []
  for (const row of rows) {
    const encrypted = Buffer.from(row.encrypted, 'hex')
    if (encrypted.length === 0) {
      if (row.value !== '') {
        cookies.push(toCookie(row, row.value))
        plain += 1
      }
      continue
    }
    const prefix = encrypted.subarray(0, 3).toString('latin1')
    if (prefix === 'v20') {
      blocked.push(row.name)
      continue
    }
    if (prefix === 'v10' || prefix === 'v11') {
      needKey.push([row.host, row.name, row.encrypted, String(row.expires)])
      continue
    }
    // Unencrypted legacy row.
    if (row.value !== '') cookies.push(toCookie(row, row.value))
  }
  if (blocked.length > 0 && needKey.length === 0) {
    return {
      cookies: [],
      reason: `${blocked.length} 个 cookie 使用 v20（App-Bound）加密，按设计只能在浏览器进程内解密`,
    }
  }
  if (needKey.length > 0) {
    const key = await readMasterKey(root, profile)
    if ('key' in key) {
      for (const [host, name, encryptedHex, expiresText] of needKey) {
        const decrypted = decryptLegacy(Buffer.from(encryptedHex, 'hex'), key.key)
        if (decrypted !== undefined) {
          cookies.push({
            name,
            value: decrypted,
            domain: host.replace(/^\./, '').toLowerCase(),
            path: '/',
            hostOnly: !host.startsWith('.'),
            ...Number(expiresText) > 0 ? { expires: Number(expiresText) } : {},
          })
        }
      }
    } else {
      return { error: key.error }
    }
  }
  if (cookies.length === 0) {
    return { cookies: [], reason: blocked.length > 0 ? `仅有的 cookie 使用 v20 加密（${blocked.length} 个）` : '没有可用的明文 cookie' }
  }
  return { cookies }
}

/**
 * Convert one row into a stored cookie.
 *
 * @param {{ host: string, expires: number }} row - the row.
 * @param {string} value - the decoded value.
 * @returns {import('./cookies.js').StoredCookie} the cookie.
 */
function toCookie(row, value) {
  return {
    name: row.name,
    value,
    domain: row.host.replace(/^\./, '').toLowerCase(),
    path: '/',
    hostOnly: !row.host.startsWith('.'),
    ...row.expires > 0 ? { expires: row.expires } : {},
  }
}

/**
 * Read and unwrap the browser's master key (legacy `v10` payloads only).
 *
 * @param {string} root - the browser's user-data directory.
 * @param {string} profile - the profile directory name.
 * @returns {Promise<{ key: Buffer } | { error: string }>} the key, or why it failed.
 */
async function readMasterKey(root, _profile) {
  try {
    const { readFileSync } = await import('node:fs')
    const state = JSON.parse(readFileSync(join(root, 'Local State'), 'utf8'))
    const encoded = state?.os_crypt?.encrypted_key
    if (typeof encoded !== 'string' || encoded === '') {
      return { error: 'Local State 里没有 os_crypt.encrypted_key（该配置从未保存过 cookie）' }
    }
    const sealed = Buffer.from(encoded, 'base64')
    if (sealed.subarray(0, 5).toString('latin1') !== 'DPAPI') {
      return { error: '主密钥不是 DPAPI 封装的形式，无法在本机解开' }
    }
    const inner = sealed.subarray(5)
    if (process.platform !== 'win32') {
      return { error: '只有 Windows 上的 DPAPI 封装能通过系统接口解开' }
    }
    const unwrapped = await dpapiUnprotect(inner)
    return unwrapped === undefined ? { error: 'DPAPI 解封失败' } : { key: unwrapped }
  } catch (error) {
    return { error: `读取主密钥失败：${describe(error)}` }
  }
}

/**
 * Unwrap a DPAPI blob with the current user's credentials.
 *
 * `ProtectedData.Unprotect` is part of .NET, which ships with Windows, so this
 * adds no dependency and ships no binary.
 *
 * @param {Buffer} blob - the sealed bytes.
 * @returns {Promise<Buffer | undefined>} the plaintext, or undefined on failure.
 */
async function dpapiUnprotect(blob) {
  const script = [
    'Add-Type -AssemblyName System.Security;',
    '$in=[Console]::In.ReadToEnd().Trim();',
    '$bytes=[Convert]::FromBase64String($in);',
    '$out=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
    '[Console]::Out.Write([Convert]::ToBase64String($out))',
  ].join(' ')
  try {
    const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      input: blob.toString('base64'),
      timeout: 15000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    })
    const text = stdout.trim()
    return text === '' ? undefined : Buffer.from(text, 'base64')
  } catch {
    return undefined
  }
}

/**
 * Decrypt one legacy `v10`/`v11` cookie value: AES-256-GCM, 12-byte nonce after
 * the prefix, and the tag in the last 16 bytes.
 *
 * @param {Buffer} payload - the encrypted bytes including the 3-byte prefix.
 * @param {Buffer} key - the unwrapped AES key.
 * @returns {string | undefined} the plaintext value.
 */
function decryptLegacy(payload, key) {
  try {
    const { createDecipheriv } = require_crypto()
    if (payload.length < 3 + 12 + 16) return undefined
    const nonce = payload.subarray(3, 15)
    const tag = payload.subarray(payload.length - 16)
    const body = payload.subarray(15, payload.length - 16)
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  } catch {
    return undefined
  }
}

/**
 * Load node:crypto without a bundler rewriting the specifier.
 *
 * @returns {any} the module.
 */
function require_crypto() {
  const loader = /** @type {any} */ (globalThis).process?.getBuiltinModule
  if (typeof loader === 'function') return loader.call(process, 'node:crypto')
  throw new Error('cannot load node:crypto')
}

/**
 * Render one error for a diagnostic line.
 *
 * @param {unknown} error - caught value.
 * @returns {string} the message.
 */
function describe(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Explain a cookie-database read failure in terms of what the user can do.
 *
 * A running browser keeps the cookie file open with a share mode that refuses
 * both opening and copying (`EBUSY` / `SQLITE_CANTOPEN`). There is no safe way
 * around a share-mode refusal from another process, so the guidance is to use
 * the warm-up path or a pasted header, which do not need the browser at all.
 *
 * @param {unknown} error - caught value.
 * @returns {string} the guidance.
 */
function explainReadFailure(error) {
  const code = /** @type {any} */ (error)?.code ?? ''
  if (code === 'EBUSY' || code === 'EPERM' || code === 'ERR_SQLITE_ERROR') {
    return '浏览器正在运行并独占了 Cookie 文件，无法读取（关闭该浏览器后重试，或改用 cookieWarmUp / cookieHeader）'
  }
  return describe(error)
}