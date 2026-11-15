// Per-source cookie behaviour, checked without a network.
//
// The claims under test are the ones the settings page makes to the user:
//   1. a pasted header is attributed to the engine it belongs to;
//   2. each source's jar only carries that source's cookies;
//   3. an ambiguous paste is refused rather than guessed;
//   4. the legacy single header still works as a fallback;
//   5. a typo in a source id is rejected, not silently ignored.
import { recogniseInput, recogniseSource, splitBySource, jarsBySource, cookieSummary } from '../lib/source-cookies.js'
import { resolveConfig } from '../lib/config.js'

let failures = 0
/**
 * @param {string} name - what is being asserted.
 * @param {boolean} ok - the outcome.
 * @param {string} [detail] - extra context on failure.
 */
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

console.log('识别：')

const baidu = 'BAIDUID=ABC123:FG=1; BDUSS=xyz; PSTM=1700'
check('百度 header 被识别为 baidu', recogniseSource(baidu).source === 'baidu')

const sogou = 'SUID=aaaa; SUV=bbbb; SNUID=cccc'
check('搜狗 header 被识别为 sogou', recogniseSource(sogou).source === 'sogou')

const bing = 'MUID=111122223333; _EDGE_S=mkt=zh-cn'
check('必应 header 被识别为 bing', recogniseSource(bing).source === 'bing')

const so360 = 'QiHooGUID=zzz; QH_SESSION_ID=qqq'
check('360 header 被识别为 360', recogniseSource(so360).source === '360')

const ddg = 'vqd=4-123; dcr=1'
check('DuckDuckGo header 被识别为 duckduckgo', recogniseSource(ddg).source === 'duckduckgo')

const devtools = 'cookie: BAIDUID=ABC; BDUSS=xyz'
check('带 "cookie:" 前缀也能识别', recogniseInput(devtools).source === 'baidu')

const unknown = 'foo=1; bar=2'
check('无特征的 header 不猜测', recogniseSource(unknown).source === undefined)

const hostHint = 'hello from www.sogou.com; a=1; b=2'
check('文本里有域名时用它兜底', recogniseInput(hostHint).source === 'sogou')

check('空输入被拒绝', recogniseInput('').source === undefined)

console.log('\n拆分：')

const mixed = 'BAIDUID=a; BDUSS=b; SUID=c; SUV=d'
const split = splitBySource(mixed)
check('混合 header 拆成两个源', split.size === 2)
check('百度拿到自己的两个 cookie', split.get('baidu') === 'BAIDUID=a; BDUSS=b', split.get('baidu') ?? '(none)')
check('搜狗拿到自己的两个 cookie', split.get('sogou') === 'SUID=c; SUV=d', split.get('sogou') ?? '(none)')

const singleWithAux = 'BAIDUID=a; someUnknownCookie=z'
const singleSplit = splitBySource(singleWithAux)
check('单一源时未知 cookie 归给它', (singleSplit.get('baidu') ?? '').includes('someUnknownCookie=z'), singleSplit.get('baidu') ?? '(none)')

console.log('\n按源建 jar：')

const sources = ['bing', '360', 'baidu', 'duckduckgo', 'sogou']
const jars = jarsBySource(
  {
    cookiesBySource: { baidu, sogou },
    cookieHeader: '',
  },
  sources,
)
check('每个源都有 jar', jars.size === 5)
check(
  '百度 jar 拿到百度 cookie',
  (jars.get('baidu').header('https://www.baidu.com/s?wd=x') ?? '').includes('BAIDUID'),
)
check(
  '必应 jar 没拿到百度 cookie',
  !(jars.get('bing').header('https://www.bing.com/search?q=x') ?? '').includes('BAIDUID'),
  jars.get('bing').header('https://www.bing.com/search?q=x') ?? '(empty)',
)
check(
  '搜狗 jar 拿到搜狗 cookie',
  (jars.get('sogou').header('https://www.sogou.com/web?query=x') ?? '').includes('SUID'),
)

const legacyJars = jarsBySource({ cookiesBySource: {}, cookieHeader: baidu }, sources)
check(
  '旧的单 header 仍可用作兜底',
  (legacyJars.get('baidu').header('https://www.baidu.com/s') ?? '').includes('BAIDUID'),
)

const own = jarsBySource(
  { cookiesBySource: { bing: bing }, cookieHeader: baidu },
  sources,
)
check(
  '源自己的 cookie 优先于旧 header',
  (own.get('bing').header('https://www.bing.com/') ?? '').includes('MUID')
    && !(own.get('bing').header('https://www.bing.com/') ?? '').includes('BAIDUID'),
  own.get('bing').header('https://www.bing.com/') ?? '(empty)',
)

console.log('\n配置校验：')

const resolved = resolveConfig({ cookiesBySource: { baidu }, localSources: sources })
check('config 接受合法的 per-source cookie', resolved.cookiesBySource.baidu === baidu)

// A bad value is reported and fell back, not thrown: one bad cookie entry must
// not cost the user every other setting.
const unknownSource = resolveConfig({ cookiesBySource: { notASource: 'a=1' } })
check(
  '未知源 id 被拒绝',
  unknownSource.problems.some(x => x.field === 'cookiesBySource'),
  JSON.stringify(unknownSource.problems),
)
check('该字段回落到空', Object.keys(unknownSource.cookiesBySource).length === 0)

const newline = resolveConfig({ cookiesBySource: { baidu: 'BAIDUID=a
b' } })
check(
  '带换行的 cookie 被拒绝',
  newline.problems.some(x => x.field === 'cookiesBySource'),
  JSON.stringify(newline.problems),
)

check(
  '默认值是空对象',
  Object.keys(resolveConfig({}).cookiesBySource).length === 0,
)

console.log('\n摘要：')
const summary = cookieSummary({ baidu }, '', sources)
const baiduRow = summary.find(row => row.id === 'baidu')
const bingRow = summary.find(row => row.id === 'bing')
check('摘要标出已配置的源', baiduRow.set === true && baiduRow.names === 3, JSON.stringify(baiduRow))
check('摘要标出未配置的源', bingRow.set === false, JSON.stringify(bingRow))

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
