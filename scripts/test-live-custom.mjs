// Live check: does a user-declared source actually work end to end?
//
// The declaration below points at a real engine's results page with selectors
// that match it, so this proves the whole path — config → adapter → request →
// parse — not just the parser in isolation.
//
// Run with: node --use-system-ca scripts/test-live-custom.mjs
import { searchLocal } from '../lib/search.js'
import { customAdapters } from '../lib/custom-sources.js'
import { jarsBySource } from '../lib/source-cookies.js'
import { resolveConfig } from '../lib/config.js'

let failures = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

// A custom 360 source declared through config, exactly as a user would.
const cfg = resolveConfig({
  localSources: ['my360'],
  customSources: [{
    id: 'my360',
    label: '我的 360',
    url: 'https://www.so.com/s?q={query}&pn={offset}',
    result: 'li.res-list',
    link: 'h3 a',
    title: 'h3',
    snippet: 'p.res-desc',
    offsetStart: 1,
    offsetStep: 1,
  }],
})

check('config 接受自定义源', cfg.localSources.join(',') === 'my360')
check('自定义源被解析', cfg.customSources[0]?.id === 'my360')
check('host 自动推导', cfg.customSources[0]?.hosts.includes('so.com'), cfg.customSources[0]?.hosts)

const adapters = customAdapters(cfg.customSources)
check('适配器可以构建', adapters.get('my360') !== undefined)

console.log('\n真实请求：')
const jars = jarsBySource(
  { cookiesBySource: {}, cookieHeader: '' },
  cfg.localSources,
  adapters,
)

try {
  const outcome = await searchLocal('DeepSeek Harness', {
    sourceIds: cfg.localSources,
    maxResults: 3,
    maxPages: 1,
    timeoutMs: 20000,
    maxBytes: 3000000,
    maxChars: 400000,
    customAdapters: adapters,
    jarsBySource: jars,
    warmUp: false,
  }, AbortSignal.timeout(60000))

  check('自定义源返回了结果', outcome.sources.length > 0, String(outcome.sources.length))
  check('结果有合法 URL', outcome.sources.every(s => s.url.startsWith('http')))
  check('结果有标题', outcome.sources.every(s => typeof s.title === 'string' && s.title.length > 0))
  console.log(`       ${outcome.sources.length} 条 · 首条「${outcome.sources[0]?.title.slice(0, 40)}」`)
  console.log(`       来源 id：${outcome.sourceId}`)
} catch (error) {
  // A block is a legitimate outcome for a live request; a crash is not.
  const message = error instanceof Error ? error.message : String(error)
  const code = error?.code
  check('失败时给出了分类错误码', typeof code === 'string' && code.startsWith('CUBE_WEB_'), String(code))
  console.log(`       未成功（${code}）：${message.slice(0, 180)}`)
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
