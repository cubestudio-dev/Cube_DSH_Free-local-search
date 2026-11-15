// Per-field recovery from a bad stored value.
//
// The behaviour under test is the fix for "my settings vanished": an invalid
// field must cost exactly that field, not the whole configuration. The old
// resolver threw on the first bad value and callers fell back to defaults, so a
// single malformed entry (an unquoted `360` read back as a number, a source id
// that no longer exists) wiped cookies, source order and mode at once.
import { resolveConfig } from '../lib/config.js'

let failures = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

console.log('一个坏字段只损失它自己：')

// A number where a source id belongs — exactly what an unquoted 360 becomes.
const bad = resolveConfig({
  mode: 'local',
  localSources: ['bing', 360, 'baidu'],
  cookiesBySource: { baidu: 'BAIDUID=kept; BDUSS=kept' },
  cookieWarmUp: false,
})

check('mode 保留（不受坏字段影响）', bad.mode === 'local', bad.mode)
check('cookie 保留', bad.cookiesBySource.baidu === 'BAIDUID=kept; BDUSS=kept', bad.cookiesBySource.baidu)
check('cookieWarmUp 保留', bad.cookieWarmUp === false)
check('坏掉的 localSources 回落到默认', bad.localSources.length === 5, bad.localSources.join(','))
check('问题被记录下来', bad.problems.some(p => p.field === 'localSources'), JSON.stringify(bad.problems))

console.log('\n多个坏字段，各自独立回落：')
const many = resolveConfig({
  mode: 'not-a-mode',
  localSources: [],
  cookiesBySource: { baidu: 'a=1', nosuchsource: 'b=2' },
  localMaxPages: 999,
})
check('mode 回落 auto', many.mode === 'auto', many.mode)
check('localSources 回落默认（空数组非法）', many.localSources.length === 5)
check('localMaxPages 回落默认', many.localMaxPages === 2, String(many.localMaxPages))
check('cookiesBySource 整份回落（含未知源 id）', Object.keys(many.cookiesBySource).length === 0, JSON.stringify(many.cookiesBySource))
check('三处问题都被记录', many.problems.length >= 3, JSON.stringify(many.problems.map(p => p.field)))

console.log('\n合法配置不受影响：')
const good = {
  mode: 'local',
  localSources: ['bing', '360', 'baidu'],
  cookiesBySource: { baidu: 'BAIDUID=x; BDUSS=y' },
  customSources: [{ id: 'mysrc', label: '我的', url: 'https://a.example.com/?q={query}' }],
  cookieWarmUp: true,
}
const c = resolveConfig(good)
check('无问题记录', c.problems.length === 0, JSON.stringify(c.problems))
check('全部字段保留', c.mode === 'local' && c.localSources.length === 3 && c.cookiesBySource.baidu === 'BAIDUID=x; BDUSS=y')
check('自定义源保留', c.customSources[0]?.id === 'mysrc')

console.log('\n"360" 作为字符串被正常接受：')
const quoted = resolveConfig({ localSources: ['bing', '360'] })
check('字符串 360 合法', quoted.localSources.join(',') === 'bing,360', quoted.localSources.join(','))
check('无问题记录', quoted.problems.length === 0)

console.log('\n空配置与缺失配置：')
const empty = resolveConfig({})
check('空对象得到完整默认值', empty.mode === 'auto' && empty.localSources.length === 5)
check('空对象无问题', empty.problems.length === 0)
const missing = resolveConfig(undefined)
check('undefined 得到完整默认值', missing.mode === 'auto' && missing.localSources.length === 5)

console.log('\n自定义源被丢弃时，引用它的源顺序不会连坐：')
const orphan = resolveConfig({
  customSources: [{ id: 'bad id!', label: 'x', url: 'https://a/?q={query}' }],
  localSources: ['bing', 'bad id!'],
})
check('无效的自定义源被放弃', orphan.customSources.length === 0, JSON.stringify(orphan.customSources))
check(
  'localSources 回落到默认而不是丢弃全部',
  orphan.localSources.length === 5,
  orphan.localSources.join(','),
)
check('两处问题都被记录', orphan.problems.length === 2, JSON.stringify(orphan.problems.map(p => p.field)))

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
