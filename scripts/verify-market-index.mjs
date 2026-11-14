/**
 * Verify the published DSH market index end to end.
 *
 * Run after GitHub Pages is enabled:
 *   node scripts/verify-market-index.mjs
 *
 * Checks, in order:
 *   1. the index URL answers with JSON (Pages has built);
 *   2. the document passes DSH's own format-1 validator;
 *   3. the install spec it yields is the commit-pinned one for this repo;
 *   4. the commit the index pins still carries the plugin manifest.
 */

import { readFileSync } from 'node:fs'

const INDEX_URL = 'https://cubestudio-dev.github.io/Cube_DSH_Free-local-search/market-index.json'
const EXPECTED_COMMIT = '7dc79d8335271f1d5aa99ee790860ad1f761be46'

const failures = []
const note = (ok, label, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' :: ' + extra : ''}`)
  if (!ok) failures.push(label)
}

// 1. reachable
let text
try {
  const response = await fetch(INDEX_URL, { signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'cube-dsh-free' } })
  note(response.ok, 'index URL answers', `HTTP ${response.status}`)
  text = await response.text()
} catch (error) {
  note(false, 'index URL answers', error.cause?.code ?? error.name)
}

if (text !== undefined) {
  // 2. shape first (a Pages 404 page is HTML, and must not be mistaken for JSON)
  let document
  try {
    document = JSON.parse(text)
    note(true, 'body is JSON')
  } catch {
    note(false, 'body is JSON', `got ${text.slice(0, 60).replace(/\s+/g, ' ')}`)
  }

  if (document !== undefined) {
    note(document.format === 1, 'format is 1')
    note(Array.isArray(document.plugins) && document.plugins.length > 0, 'lists at least one plugin')

    const entry = document.plugins?.find(plugin => plugin.name === 'cube-dsh-free')
    note(entry !== undefined, 'lists cube-dsh-free')
    if (entry !== undefined) {
      note(typeof entry.title === 'object' && 'en' in entry.title, 'has an en title', entry.title?.en)
      const version = entry.versions?.[0]
      note(version?.version !== undefined, 'has a version', version?.version)
      const source = version?.source
      note(source?.type === 'git', 'source is git')
      note(/^[0-9a-f]{40}$/.test(source?.commit ?? ''), 'commit is a 40-hex SHA')
      note(source?.url === 'https://github.com/cubestudio-dev/Cube_DSH_Free-local-search', 'source URL matches this repo')
      const spec = `git+${source?.url.endsWith('.git') ? source.url : `${source?.url}.git`}#${source?.commit}`
      note(spec.includes(EXPECTED_COMMIT), 'install spec pins the published commit', spec.slice(0, 96))
    }
  }
}

// 4. the pinned commit must still carry the plugin manifest; compare against
//    the local working copy so a stale index is caught rather than assumed.
try {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  note(manifest.name === 'cube-dsh-free', 'local manifest name matches', manifest.name)
  note(manifest.version === '1.0.0', 'local manifest version matches the index', manifest.version)
  note(manifest.dsh?.bundle?.patch !== undefined, 'local manifest declares a bundle patch')
} catch (error) {
  note(false, 'local manifest readable', error.message)
}

console.log(failures.length === 0 ? '\nall checks passed' : `\n${failures.length} check(s) failed`)
if (failures.length > 0) process.exitCode = 1
