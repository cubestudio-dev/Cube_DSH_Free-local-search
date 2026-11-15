// Run the source-cookie tests with a stub for @deepseek-ai/schemastery.
//
// config.js imports the real Schemastery only to publish its schema; the
// behaviour under test here is the resolver, so the import is replaced with the
// minimum surface config.js needs at module scope. The real schema is checked
// separately against the DSH runtime.
//
// The stub lives in ./node_modules for the duration of the run and is removed
// afterwards, so the published tree never carries it.
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'

const PKG = 'node_modules/@deepseek-ai/schemastery'
const STUB = `export class Schema {
  constructor(type) { this.type = type; this.meta = {}; }
  default(v) { this.meta.default = v; return this }
  description(v) { this.meta.description = v; return this }
  role(v) { this.meta.role = v; return this }
  volatile() { this.meta.volatile = true; return this }
  step() { return this }
  min() { return this }
  max() { return this }
  required() { return this }
  hidden() { return this }
  loose() { return this }
  collapse() { return this }
}
const make = type => (...args) => {
  const schema = new Schema(type)
  if (type === 'object') schema.dict = args[0] ?? {}
  if (type === 'dict' || type === 'array') schema.inner = args[0]
  if (type === 'union') schema.list = args[0] ?? []
  return schema
}
const z = make('any')
z.object = make('object')
z.dict = make('dict')
z.array = make('array')
z.union = make('union')
z.string = make('string')
z.number = make('number')
z.boolean = make('boolean')
z.const = value => { const s = new Schema('const'); s.value = value; return s }
export default z
`

const hadNodeModules = existsSync('node_modules')
rmSync(PKG, { recursive: true, force: true })
mkdirSync(`${PKG}/lib`, { recursive: true })
writeFileSync(`${PKG}/package.json`, JSON.stringify({
  name: '@deepseek-ai/schemastery',
  version: '0.0.0-test-stub',
  type: 'module',
  main: './lib/index.js',
}))
writeFileSync(`${PKG}/lib/index.js`, STUB)

try {
  for (const suite of process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : ['test-update-survival.mjs', 'test-field-survival.mjs', 'test-config-resilience.mjs', 'test-custom-sources.mjs', 'test-source-cookies.mjs']) {
    await import(`./${suite}`)
  }
} finally {
  rmSync(PKG, { recursive: true, force: true })
  // Remove node_modules only if this run created it and nothing else is in it.
  if (!hadNodeModules) rmSync('node_modules', { recursive: true, force: true })
}
