// Regression: a plugin update must not reset the user's settings.
//
// The failure this guards against was real: the bundle patch shipped
// `config: { mode: auto }` on the plugin row. A bundle is rewritten on every
// install, so that literal reseeded the mode on update, and because the same
// layer is what the settings page reads back, the user's per-source cookies and
// source order looked like they had vanished.
//
// The rule that prevents it: the bundle layer must not carry user-editable
// `config` at all. Defaults belong in the schema; user values belong in the
// profile patch, which the bundle never touches.
import { readFileSync } from 'node:fs'
import { resolveConfig, DEFAULTS } from '../lib/config.js'

let failures = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

console.log('bundle patch 不得携带用户配置：')

// A hand-written parse is enough here: the file is ours and small, and the check
// is about structure, not YAML semantics.
const cubeBlock = patch
  .split('\n')
  .slice(patch.split('\n').findIndex(line => line.trim() === '- id: cube-dsh-free') - 1)
  .join('\n')
  .split('\n- id:')
  .slice(0, 1)
  .join('\n- id:')

check('插件行存在', patch.includes('- id: cube-dsh-free'))
check(
  '插件行不带 config（否则更新会重置用户设置）',
  !/^\s+config:\s*$/m.test(cubeBlock),
  cubeBlock.split('\n').filter(l => l.includes('config')).join(' | '),
)
check(
  '文件里没有 mode 字面量',
  !/^\s+mode:\s*/m.test(patch),
  patch.split('\n').filter(l => /^\s+mode:/.test(l)).join(' | '),
)

console.log('\n默认值来自 schema，而不是文件：')
const resolved = resolveConfig({})
check('mode 默认 auto', resolved.mode === 'auto', resolved.mode)
check('源默认五个内置源', resolved.localSources.length === 5, resolved.localSources.join(','))
check('customSources 默认空', resolved.customSources.length === 0)
check('cookiesBySource 默认空', Object.keys(resolved.cookiesBySource).length === 0)
check('cookieWarmUp 默认 true', resolved.cookieWarmUp === true)
check('DEFAULTS 与解析结果一致', resolved.mode === DEFAULTS.mode)

console.log('\n用户的值优先于默认值（模拟更新后的读取）：')
const userConfig = {
  mode: 'local',
  localSources: ['baidu', 'mysearch'],
  cookiesBySource: { baidu: 'BAIDUID=kept; BDUSS=kept' },
  customSources: [{ id: 'mysearch', label: '我的', url: 'https://a.example.com/?q={query}' }],
}
const fromUser = resolveConfig(userConfig)
check('mode 保留用户值', fromUser.mode === 'local', fromUser.mode)
check('源顺序保留', fromUser.localSources.join(',') === 'baidu,mysearch', fromUser.localSources.join(','))
check('cookie 保留', fromUser.cookiesBySource.baidu === 'BAIDUID=kept; BDUSS=kept', fromUser.cookiesBySource.baidu)
check('自定义源保留', fromUser.customSources[0]?.id === 'mysearch')

console.log('\n缺字段时只补默认，不整份丢弃：')
const partial = resolveConfig({ mode: 'official' })
check('给了的字段用用户值', partial.mode === 'official')
check('没给的字段用默认', partial.localSources.length === 5 && Object.keys(partial.cookiesBySource).length === 0)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
