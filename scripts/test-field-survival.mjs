// Does every user-editable field survive the trip from stored config to the
// value the providers actually use?
//
// This is the regression that mattered: `index.js` builds a snapshot by naming
// each field explicitly. A field missing from that list is not an error — the
// resolver silently fills its default — so the plugin runs with no cookies while
// the settings page still shows them saved. The check here is structural: every
// key in DEFAULTS must appear in the snapshot call.
import { readFileSync } from 'node:fs'
import { DEFAULTS, resolveConfig } from '../lib/config.js'

let failures = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const indexSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8')

// The snapshot is the one place that enumerates fields for the provider layer.
const snapshotCall = (() => {
  const start = indexSource.indexOf('function snapshot(config)')
  if (start === -1) return ''
  const end = indexSource.indexOf('\n}', start)
  return indexSource.slice(start, end)
})()

check('找到 snapshot 函数', snapshotCall !== '')

console.log('\n每个配置字段都必须被 snapshot 拾取：')
const missing = []
for (const key of Object.keys(DEFAULTS)) {
  const present = snapshotCall.includes(`field(config, '${key}')`) || snapshotCall.includes(`'${key}'`)
  if (!present) missing.push(key)
  check(`${key} 在 snapshot 中`, present)
}

check('没有遗漏字段', missing.length === 0, missing.join(', '))

console.log('\n字段值经解析后不丢失：')
// Values a user would actually have set, one per field.
const stored = {
  mode: 'auto',
  officialSearchProvider: 'deepseek-official',
  officialFetchProvider: 'http',
  localSources: ['baidu', 'bing'],
  customSources: [{ id: 'mysrc', label: '我的', url: 'https://a.example.com/?q={query}' }],
  localMaxPages: 3,
  localTimeoutMs: 20000,
  localFetchTimeoutMs: 30000,
  localMaxBytes: 4000000,
  localFetchMaxChars: 50000,
  localMaxLinks: 15,
  keepNoise: true,
  cookieBrowser: 'edge',
  cookieHeader: 'fallback=1',
  cookiesBySource: { baidu: 'BAIDUID=keep; BDUSS=keep' },
  cookieWarmUp: false,
}

const resolved = resolveConfig(stored)
for (const [key, value] of Object.entries(stored)) {
  const actual = resolved[key]
  if (key === 'customSources') {
    // A declaration is normalised: defaults are filled in for the selectors and
    // offsets the user left out. That is expected; what must survive are the
    // fields the user actually wrote.
    const ok = actual.length === value.length
      && actual.every((entry, i) => entry.id === value[i].id
        && entry.label === value[i].label
        && entry.url === value[i].url)
    check(`${key} 用户写的字段原样保留（默认值被补全）`, ok, JSON.stringify(actual))
    continue
  }
  const same = JSON.stringify(actual) === JSON.stringify(value)
  check(`${key} 原样保留`, same, `expected ${JSON.stringify(value)}, got ${JSON.stringify(actual)}`)
}
check('无回落问题', resolved.problems.length === 0, JSON.stringify(resolved.problems))

console.log('\n模拟一次更新：配置文件被重新读入（同样的对象）后仍然一致：')
const again = resolveConfig(JSON.parse(JSON.stringify(stored)))
check(
  '二次解析结果相同',
  JSON.stringify(again.cookiesBySource) === JSON.stringify(resolved.cookiesBySource)
    && again.localSources.join(',') === resolved.localSources.join(','),
  JSON.stringify(again.cookiesBySource),
)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
