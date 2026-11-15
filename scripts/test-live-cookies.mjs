// End-to-end: does a per-source cookie actually reach that source's requests?
//
// A live search would be flaky to assert on (engines change their blocking
// behaviour by the hour), so this proves the mechanism instead: build the jars
// the provider builds, then read back the header each source would send. If the
// right cookie lands on the right host and nowhere else, the plumbing is sound.
//
// Run with: node scripts/test-live-cookies.mjs
import { jarsBySource, SOURCE_HOSTS, recogniseInput } from '../lib/source-cookies.js'

let failures = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

// Stand-ins with the real names each engine uses. Values are fake on purpose:
// this checks routing, never authenticity.
const PASTED = {
  baidu: 'BAIDUID=AAAA1111:FG=1; BDUSS=ZZZZ; PSTM=1700000000; H_PS_645EC=xyz',
  sogou: 'SUID=ssss; SUV=tttt; SNUID=uuuu; IPLOC=CN3100',
  bing: 'MUID=1111AAAA2222BBBB; _EDGE_S=mkt=zh-cn&ui=zh-cn; SRCHHPGUSR=SRCHLANG=zh-Hans',
  '360': 'QiHooGUID=qqqq; QH_SESSION_ID=rrrr; __guid=ssss',
  duckduckgo: 'vqd=4-1234567890; dcr=1',
}

console.log('识别每份粘贴：')
for (const [expected, header] of Object.entries(PASTED)) {
  const verdict = recogniseInput(header)
  check(`${expected} 的 cookie 识别正确`, verdict.source === expected, `got ${verdict.source}`)
}

console.log('\n路由：cookie 只到自己的 host')
const sources = Object.keys(PASTED)
const jars = jarsBySource({ cookiesBySource: PASTED, cookieHeader: '' }, sources)

for (const [id, header] of Object.entries(PASTED)) {
  const jar = jars.get(id)
  const hosts = SOURCE_HOSTS[id]
  const sent = jar.header(`https://${hosts[0]}/search?q=test`) ?? ''
  // Every marker from this source must be present.
  const markers = header.split(';').map(part => part.split('=')[0].trim()).filter(Boolean)
  const missing = markers.filter(name => !sent.includes(`${name}=`))
  check(`${id} 自己的 host 收到全部 ${markers.length} 个 cookie`, missing.length === 0, `missing ${missing.join(',')}`)
}

console.log('\n隔离：cookie 不会串到别的源')
for (const [id, jar] of jars) {
  for (const other of sources) {
    if (other === id) continue
    const otherHost = SOURCE_HOSTS[other][0]
    const sent = jar.header(`https://${otherHost}/search?q=test`) ?? ''
    if (sent === '') continue
    // A jar must only emit cookies whose domain covers that host. Cross-host
    // leakage would mean the source id → host mapping is wrong.
    const leaked = PASTED[id].split(';').map(p => p.split('=')[0].trim())
      .filter(name => name !== '' && sent.includes(`${name}=`))
    check(`${id} 的 jar 不向 ${otherHost} 发送自己的 cookie`, leaked.length === 0, leaked.join(','))
  }
}

console.log('\n旧的单 header 只落到能识别的那个源')
const legacy = jarsBySource({ cookiesBySource: {}, cookieHeader: PASTED.baidu }, sources)
const baiduSent = legacy.get('baidu').header('https://www.baidu.com/s?wd=x') ?? ''
const bingSent = legacy.get('bing').header('https://www.bing.com/search?q=x') ?? ''
check('旧 header 落到百度', baiduSent.includes('BAIDUID='))
check(
  '旧 header 不会伪装成必应会话',
  !bingSent.includes('BAIDUID='),
  bingSent || '(empty)',
)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
