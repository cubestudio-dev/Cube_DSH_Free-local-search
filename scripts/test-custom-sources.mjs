// Custom sources: declaration validation, adapter parsing, and how they slot
// into the source chain with enable/disable and priority.
//
// The parsing tests use a fixture page so they prove the selector engine, not
// somebody's live HTML.
import { normaliseCustomSource, adapterOf, customAdapters, SELECTOR_DEFAULTS } from '../lib/custom-sources.js'
import { resolveConfig } from '../lib/config.js'

let failures = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

console.log('声明校验：')

const good = {
  id: 'mysearch',
  label: '我的搜索',
  url: 'https://search.example.com/s?q={query}&p={offset}',
  result: 'div.item',
  link: 'a',
  title: 'h3',
  snippet: 'p.desc',
  offsetStart: 0,
  offsetStep: 20,
}

const spec = normaliseCustomSource(good, 0)
check('接受一份完整声明', spec.id === 'mysearch' && spec.label === '我的搜索')
check('保留 URL 模板', spec.url.includes('{query}'))
check('选择器按声明保留', spec.result === 'div.item' && spec.title === 'h3' && spec.snippet === 'p.desc')
check('offset 参数保留', spec.offsetStart === 0 && spec.offsetStep === 20)
check('从模板推导 host', spec.hosts.includes('search.example.com'), spec.hosts)
check('从模板推导 warm-up', spec.warmUp === 'https://search.example.com', spec.warmUp)

const minimal = normaliseCustomSource({ id: 'simple', label: 'Simple', url: 'https://a.example.com/s?q={query}' }, 0)
check('省略选择器时用默认值', minimal.result === SELECTOR_DEFAULTS.result && minimal.link === SELECTOR_DEFAULTS.link)
check('省略 offset 时用默认步长', minimal.offsetStep === 10)

// rejections
const rejects = [
  ['缺 id', { label: 'x', url: 'https://a.com/?q={query}' }],
  ['缺 label', { id: 'x', url: 'https://a.com/?q={query}' }],
  ['缺 url', { id: 'x', label: 'x' }],
  ['url 没有 {query}', { id: 'x', label: 'x', url: 'https://a.com/search' }],
  ['url 不是 http(s)', { id: 'x', label: 'x', url: 'ftp://a.com/?q={query}' }],
  ['id 含非法字符', { id: 'a b', label: 'x', url: 'https://a.com/?q={query}' }],
  ['id 撞内置源', { id: 'baidu', label: 'x', url: 'https://a.com/?q={query}' }],
]
for (const [what, value] of rejects) {
  let threw = false
  try {
    normaliseCustomSource(value, 0)
  } catch {
    threw = true
  }
  check(`拒绝：${what}`, threw)
}

console.log('\n适配器解析：')

const PAGE = `
<html><body>
  <div class="item">
    <a href="/hit/1"><h3>First result</h3></a>
    <p class="desc">Summary one</p>
  </div>
  <div class="item">
    <a href="https://other.example.org/hit/2"><h3>Second result</h3></a>
    <p class="desc">Summary two</p>
  </div>
  <div class="item">
    <span>no anchor here</span>
  </div>
</body></html>`

const adapter = adapterOf(spec)
const parsed = adapter.parse(PAGE, 'https://search.example.com/s?q=x')
check('解析出 2 条（跳过没有链接的那块）', parsed.hits.length === 2, String(parsed.hits.length))
check('标题取自 h3', parsed.hits[0]?.title === 'First result', parsed.hits[0]?.title)
check('摘要取自 p.desc', parsed.hits[0]?.snippet === 'Summary one', parsed.hits[0]?.snippet)
check('相对链接被转成绝对地址', parsed.hits[0]?.url === 'https://search.example.com/hit/1', parsed.hits[0]?.url)
check('绝对链接保持不变', parsed.hits[1]?.url === 'https://other.example.org/hit/2', parsed.hits[1]?.url)
check('自定义源不声明 nextUrl', parsed.nextUrl === undefined)

console.log('\n分页 URL：')
check('第一页 offset=0', adapter.pageUrl('hello world', 0).includes('p=0'), adapter.pageUrl('hello world', 0))
check('offset 20 落在第二页（步长 20）', adapter.pageUrl('q', 20).includes('p=20'), adapter.pageUrl('q', 20))
check('query 被编码', adapter.pageUrl('a b&c', 0).includes('q=a%20b%26c'), adapter.pageUrl('a b&c', 0))

console.log('\n启用 / 关闭 / 优先级：')

const cfg = resolveConfig({
  localSources: ['mysearch', 'bing', 'baidu'],
  customSources: [good],
})
check('自定义源可以出现在 localSources 里', cfg.localSources.join(',') === 'mysearch,bing,baidu')
check('localSources 保留顺序（= 优先级）', cfg.localSources[0] === 'mysearch')
check('customSources 被解析', cfg.customSources.length === 1 && cfg.customSources[0].id === 'mysearch')

// disabling = removing from localSources
const disabled = resolveConfig({ localSources: ['bing'], customSources: [good] })
check('不在 localSources 里即为关闭', !disabled.localSources.includes('mysearch'))
check('关闭后声明仍然保留', disabled.customSources.some(s => s.id === 'mysearch'))

// The resolver degrades a bad field to its default and records why, rather than
// throwing and losing every other field.
const unknown = resolveConfig({ localSources: ['nosuchsource'], customSources: [] })
check('引用未声明的自定义源被拒绝', unknown.problems.some(p => p.field === 'localSources'), JSON.stringify(unknown.problems))
check('并被回落到默认源列表', unknown.localSources.length === 5)

const empty = resolveConfig({ localSources: [], customSources: [good] })
check('全部关闭被拒绝', empty.problems.some(p => p.field === 'localSources'), JSON.stringify(empty.problems))
check('并被回落到默认源列表', empty.localSources.length === 5)

const dup = resolveConfig({ localSources: ['bing', 'bing'], customSources: [] })
check('重复列出同一个源被拒绝', dup.problems.some(p => p.field === 'localSources'), JSON.stringify(dup.problems))

// priority is observable: the adapter map preserves insertion from localSources
const map = customAdapters([spec])
check('适配器映射按 id 可查', map.get('mysearch')?.label === '我的搜索')

console.log('\n优先级顺序被 search 使用：')
// The pipeline iterates sourceIds in order and returns the first success, so the
// array order IS the priority. Assert the config preserves exactly that order.
const ordered = resolveConfig({ localSources: ['baidu', 'sogou', 'bing'], customSources: [] })
check('顺序原样保留', ordered.localSources.join(',') === 'baidu,sogou,bing', ordered.localSources.join(','))

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
