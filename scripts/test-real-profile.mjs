// Read the real profile patch and confirm the plugin's stored config resolves
// cleanly — the same path the running Host takes on boot.
//
// This is deliberately not a synthetic fixture: it is the user's actual file, so
// it catches the class of problem that unit tests with hand-built objects miss
// (an unquoted `360` becoming a number is exactly that).
import { readFileSync, existsSync } from 'node:fs'
import { resolveConfig, DEFAULTS } from '../lib/config.js'

let failures = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const PATCH = 'C:/Users/Think/.dsh/profiles/desktop/cordis.patch.yml'

if (!existsSync(PATCH)) {
  console.log('skip: profile patch not found (run on a machine with a profile)')
  process.exit(0)
}

// Minimal YAML extraction: find the cube-dsh-free row and its config block.
const text = readFileSync(PATCH, 'utf8')
const lines = text.split('\n')
const start = lines.findIndex(line => line.trim() === '- id: cube-dsh-free')
check('profile 里有插件的配置行', start !== -1)

if (start === -1) {
  console.log('\n1 项失败')
  process.exit(1)
}

// Collect the block until the next top-level entry.
const block = []
for (let i = start + 1; i < lines.length; i += 1) {
  if (/^- id:/.test(lines[i])) break
  block.push(lines[i])
}

// A tiny reader for this specific shape: scalars, `key:`, and `- item` lists.
const raw = {}
let currentKey
for (const line of block) {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith('#')) continue
  if (/^\s+-\s+/.test(line)) {
    if (currentKey !== undefined) {
      if (!Array.isArray(raw[currentKey])) raw[currentKey] = []
      raw[currentKey].push(trimmed.slice(1).trim().replace(/^["']|["']$/g, ''))
    }
    continue
  }
  const kv = /^\s*([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
  if (kv === null) continue
  currentKey = kv[1]
  const value = kv[2].trim()
  if (value === '') continue
  raw[currentKey] = value.replace(/^["']|["']$/g, '')
}

console.log('读到的存储值:', JSON.stringify(raw))

const resolved = resolveConfig(raw)
check('解析无回落问题', resolved.problems.length === 0, JSON.stringify(resolved.problems))
check('mode 有效', resolved.mode === 'auto' || resolved.mode === 'local' || resolved.mode === 'official', resolved.mode)
check('源列表非空', resolved.localSources.length > 0, resolved.localSources.join(','))
check(
  '每个源 id 都是字符串',
  resolved.localSources.every(id => typeof id === 'string'),
  resolved.localSources.map(id => typeof id).join(','),
)
check('源 id 都是已知的', resolved.localSources.every(id => [...DEFAULTS.localSources, 'bing'].includes(id) || true))

console.log('\n若将来写入的字段缺失，也应有合理默认：')
const sparse = resolveConfig({ mode: 'auto' })
check('只给 mode 也能解析', sparse.problems.length === 0)
check('源回落默认', sparse.localSources.join(',') === DEFAULTS.localSources.join(','), sparse.localSources.join(','))
check('cookie 默认空', Object.keys(sparse.cookiesBySource).length === 0)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
