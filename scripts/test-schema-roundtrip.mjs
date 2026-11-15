// Does the schema survive the JSON round trip the settings service performs?
//
// `dsh-settings` builds its editable form with:
//     const result = new z(schema.toJSON())
// so every field in our Config is destroyed and rebuilt from JSON before a write
// is validated. If a nested type does not survive that trip, the value the user
// saves is validated against a different schema than the one it was written
// against — which is how "my cookies vanished after the update" happens.
//
// This runs the real Schemastery from the DSH installation, not a stub.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'

const ASAR = 'E:/DeepSeek Harness/resources/app.asar'

// Extract the packaged Schemastery so it can be imported for real.
function extractAsar(path) {
  const buf = readFileSync(path)
  const jsonSize = buf.readUInt32LE(12)
  const header = JSON.parse(buf.subarray(16, 16 + jsonSize).toString('utf8'))
  const base = 16 + jsonSize
  const files = new Map()
  const walk = (node, prefix) => {
    for (const [name, value] of Object.entries(node.files ?? {})) {
      const p = `${prefix}/${name}`
      if (value.files !== undefined) walk(value, p)
      else files.set(p, { offset: Number(value.offset), size: value.size })
    }
  }
  walk(header, '')
  return { buf, base, files }
}

const { buf, base, files } = extractAsar(ASAR)
const DIR = '.z-check/node_modules/@deepseek-ai/schemastery'
mkdirSync(`${DIR}/lib`, { recursive: true })

const entry = [...files.keys()].find(
  p => p === '/dsh/node_modules/@deepseek-ai/schemastery/lib/index.mjs',
)
if (entry === undefined) {
  console.error('schemastery not found in the installation')
  process.exit(1)
}
const { offset, size } = files.get(entry)
writeFileSync(`${DIR}/lib/index.mjs`, buf.subarray(base + offset, base + offset + size))
writeFileSync(`${DIR}/package.json`, JSON.stringify({
  name: '@deepseek-ai/schemastery', version: '0.0.0-extracted', type: 'module', main: './lib/index.mjs',
}))

// Schemastery imports cosmokit; extract that too so the module graph resolves.
const cosmoEntry = [...files.keys()].find(
  p => p === '/dsh/node_modules/@deepseek-ai/cosmokit/lib/index.js',
)
if (cosmoEntry === undefined) {
  console.error('cosmokit not found in the installation')
  process.exit(1)
}
const cosmo = files.get(cosmoEntry)
const COSMO = '.z-check/node_modules/@deepseek-ai/cosmokit'
mkdirSync(`${COSMO}/lib`, { recursive: true })
writeFileSync(`${COSMO}/lib/index.js`, buf.subarray(base + cosmo.offset, base + cosmo.offset + cosmo.size))
writeFileSync(`${COSMO}/package.json`, JSON.stringify({
  name: '@deepseek-ai/cosmokit', version: '0.0.0-extracted', type: 'module', main: './lib/index.js',
}))

const z = (await import(pathToFileURL(`${process.cwd()}/${DIR}/lib/index.mjs`).href)).default

let failures = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

/** The trip the settings service performs. */
function roundTrip(schema) {
  return new z(schema.toJSON())
}

console.log('单层字段：')
{
  const schema = z.object({
    mode: z.union([z.const('official'), z.const('local'), z.const('auto')])
      .default('auto')
      .volatile(),
  })
  const back = roundTrip(schema)
  check('string union 往返后类型不变', back.type === 'object')
  check('volatile 标记保留', back.dict?.mode?.meta?.volatile === true, JSON.stringify(back.dict?.mode?.meta))
  const parsed = back({ mode: 'local' })
  check('往返后仍接受合法值', parsed.mode === 'local', JSON.stringify(parsed))
}

console.log('\n数组字段（localSources）：')
{
  const schema = z.object({
    localSources: z.array(z.string()).default(['bing', '360']).volatile(),
  })
  const back = roundTrip(schema)
  const field = back.dict?.localSources
  check('array 往返后仍是 array', field?.type === 'array', String(field?.type))
  check('volatile 标记保留', field?.meta?.volatile === true)
  const parsed = back({ localSources: ['baidu', 'sogou'] })
  check('往返后接受数组值', Array.isArray(parsed.localSources) && parsed.localSources.join(',') === 'baidu,sogou', JSON.stringify(parsed.localSources))
}

console.log('\n字典字段（cookiesBySource）：')
{
  const schema = z.object({
    cookiesBySource: z.dict(z.string(), z.string()).default({}).volatile(),
  })
  const back = roundTrip(schema)
  const field = back.dict?.cookiesBySource
  check('dict 往返后仍是 dict', field?.type === 'dict', String(field?.type))
  check('dict 的 inner 保留', field?.inner !== undefined, String(field?.inner?.type))
  const value = { baidu: 'BAIDUID=a', sogou: 'SUID=b' }
  const parsed = back({ cookiesBySource: value })
  check(
    '往返后接受字典值',
    parsed.cookiesBySource?.baidu === 'BAIDUID=a' && parsed.cookiesBySource?.sogou === 'SUID=b',
    JSON.stringify(parsed.cookiesBySource),
  )
}

console.log('\n对象数组（customSources）：')
{
  const schema = z.object({
    customSources: z.array(z.object({
      id: z.string().required(),
      label: z.string().required(),
      url: z.string().required(),
      offsetStart: z.number().step(1),
    })).default([]).volatile(),
  })
  const back = roundTrip(schema)
  const field = back.dict?.customSources
  check('object[] 往返后仍是 array', field?.type === 'array', String(field?.type))
  check('内层 object 保留', field?.inner?.type === 'object', String(field?.inner?.type))
  check('内层字段保留', field?.inner?.dict?.id !== undefined, JSON.stringify(Object.keys(field?.inner?.dict ?? {})))
  const value = [{ id: 'my360', label: '我的 360', url: 'https://a/?q={query}', offsetStart: 1 }]
  const parsed = back({ customSources: value })
  check(
    '往返后接受对象数组',
    parsed.customSources?.length === 1 && parsed.customSources[0].id === 'my360',
    JSON.stringify(parsed.customSources),
  )
}

console.log('\n没有任何 volatile 字段时（settings 会拒绝写入）：')
{
  const schema = z.object({ plain: z.string().default('x') })
  const back = roundTrip(schema)
  const hasVolatile = back.dict?.plain?.meta?.volatile === true
  check('普通字段不带 volatile', hasVolatile === false)
}

import { rmSync } from 'node:fs'
rmSync('.z-check', { recursive: true, force: true })

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
