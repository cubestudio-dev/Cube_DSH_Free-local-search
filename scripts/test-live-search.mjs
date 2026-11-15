// Live check: does a per-source cookie change what a source returns?
//
// This is the only test that touches the network, and it is honest about what it
// proves: that the cookie reaches the request and the search still parses. It
// cannot prove an engine will never block — that varies by hour and by IP — so
// the assertions are about the mechanism, not about beating a wall.
//
// Run with: node scripts/test-live-search.mjs
import { searchLocal } from '../lib/search.js'
import { jarsBySource } from '../lib/source-cookies.js'

const QUERY = 'DeepSeek Harness'

let failures = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

// ── 1. local search with no cookies at all ─────────────────────────────────
console.log('无 cookie 的本地搜索：')
const bare = jarsBySource({ cookiesBySource: {}, cookieHeader: '' }, ['bing', 'baidu', 'sogou', '360'])
try {
  const outcome = await searchLocal(QUERY, {
    sourceIds: ['bing', 'baidu', 'sogou', '360'],
    maxResults: 5,
    maxPages: 1,
    timeoutMs: 15000,
    maxBytes: 3000000,
    maxChars: 200000,
    jarsBySource: bare,
    warmUp: false,
  }, AbortSignal.timeout(60000))
  check('返回了至少一条结果', outcome.sources.length > 0, `${outcome.sources.length}`)
  check('结果由某个源产出', typeof outcome.sourceId === 'string' && outcome.sourceId !== '')
  check('每条结果都有 url 和 title', outcome.sources.every(s => typeof s.url === 'string' && s.url.startsWith('http') && typeof s.title === 'string' && s.title !== ''))
  console.log(`       源：${outcome.sourceId} · ${outcome.sources.length} 条 · 首条「${outcome.sources[0].title.slice(0, 40)}」`)
} catch (error) {
  check('无 cookie 搜索成功', false, error instanceof Error ? error.message.slice(0, 160) : String(error))
}

// ── 2. the same query, with a cookie the source does not recognise ─────────
// A made-up cookie proves the header is *sent* without pretending a real
// session exists; the source must still answer, and the plumbing must not throw.
console.log('\n带一份（假的）分源 cookie：')
const withCookie = jarsBySource({
  cookiesBySource: { baidu: 'BAIDUID=TESTONLY:FG=1; BDUSS=TESTONLY' },
  cookieHeader: '',
}, ['bing', 'baidu', 'sogou', '360'])

// Confirm the header would actually be attached to Baidu's request.
const sent = withCookie.get('baidu').header('https://www.baidu.com/s?wd=x') ?? ''
check('百度请求会带上这份 cookie', sent.includes('BAIDUID=TESTONLY'), sent || '(empty)')
check('必应请求不会带上它', !(withCookie.get('bing').header('https://www.bing.com/search?q=x') ?? '').includes('BAIDUID'), 'leaked')

try {
  const outcome = await searchLocal(QUERY, {
    sourceIds: ['baidu', 'bing', 'sogou', '360'],
    maxResults: 5,
    maxPages: 1,
    timeoutMs: 15000,
    maxBytes: 3000000,
    maxChars: 200000,
    jarsBySource: withCookie,
    warmUp: true,
  }, AbortSignal.timeout(60000))
  check('带 cookie 的搜索仍然成功', outcome.sources.length > 0)
  console.log(`       源：${outcome.sourceId} · ${outcome.sources.length} 条`)
} catch (error) {
  // A block here is a legitimate outcome; report it as such rather than a
  // failure of the plumbing.
  const message = error instanceof Error ? error.message : String(error)
  console.log(`       搜索未成功（可能被拦截）：${message.slice(0, 200)}`)
  check('失败时给出了可路由的错误码', typeof (error?.code) === 'string' && error.code.startsWith('CUBE_WEB_'), String(error?.code))
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
