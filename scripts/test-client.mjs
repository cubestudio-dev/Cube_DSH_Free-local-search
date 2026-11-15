// Smoke-test the client bundle: does it load, and does the settings page render
// with per-source cookie rows wired to the right field?
//
// The bundle is a hand-written ModuleLoader module, not an ES module, so it is
// evaluated with a fake loader and minimal React/fetch shims. This catches the
// class of mistake that unit tests of the Host modules cannot: a missing key,
// a broken component reference, a row bound to the wrong field.
import { readFileSync } from 'node:fs'

const source = readFileSync('client.js', 'utf8')

let captured
const sandbox = {
  window: {
    __ModuleLoader__: {
      load({ id, factory }) {
        captured = { id, factory }
      },
    },
  },
  document: {
    createElement: () => ({ setAttribute() {}, textContent: '', remove() {} }),
    head: { appendChild() {} },
  },
}

// Minimal React: the components only use createElement, useState, useEffect,
// useMemo and useRef, so the shim records the element tree instead of rendering.
function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat() }
}
const React = {
  createElement,
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: value => ({ current: value }),
  Fragment: 'Fragment',
}

let failures = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

// ── evaluate the bundle ────────────────────────────────────────────────────
const run = new Function('window', 'document', 'console', source)
run(sandbox.window, sandbox.document, console)

check('bundle registers itself', captured !== undefined && captured.id === 'cube-dsh-free')
if (captured === undefined) {
  console.log('\n1 项失败')
  process.exit(1)
}

const require = name => {
  if (name === 'react' || name === 'react/jsx-runtime') return React
  throw new Error(`unexpected require: ${name}`)
}
const exported = captured.factory(require)

check('exposes apply', typeof exported.apply === 'function')
check('exposes inject list', Array.isArray(exported.inject))
check('injects configForms', exported.inject.includes('configForms'))

// ── render the page through the slot registration ──────────────────────────
let pageComponent
let dictZh
let dictEn
const slots = new Map()

const fakeForm = {
  value: {
    mode: 'auto',
    cookieWarmUp: true,
    cookieBrowser: 'none',
    cookieHeader: '',
    cookiesBySource: { baidu: 'BAIDUID=abc; BDUSS=xyz' },
  },
  writable: true,
  // The page reads its state through these two, so the shim has to provide them.
  getSnapshot() {
    return { status: 'ready', writable: true, value: this.value }
  },
  subscribe() { return () => {} },
  async set(field, value) {
    this.value = { ...this.value, [field]: value }
    return true
  },
}

const ctx = {
  effect: fn => { const off = fn(); return () => off?.() },
  locale: {
    bind: () => key => key,
    register: (ns, dicts) => { dictZh = dicts.zh; dictEn = dicts.en; return () => {} },
    getLocale: () => 'zh',
  },
  configForms: {
    get: () => fakeForm,
    whileServed: (namespaces, register) => {
      register(new Set(namespaces))
      return () => {}
    },
  },
  slots: {
    inject: (name, fn) => { fn(); return () => {} },
    register: (kind, component) => {
      slots.set(kind.name, { component, kind, props: {} })
      pageComponent = component
      return () => {}
    },
  },
}

exported.apply(ctx)

check('registers a settings.section', slots.has('settings.section'))
check('registers both dictionaries', dictZh !== undefined && dictEn !== undefined)
check('zh has per-source copy', dictZh?.cookiePerSource !== undefined)
check('en has per-source copy', dictEn?.cookiePerSource !== undefined)
check('both dictionaries define save', dictZh?.save !== undefined && dictEn?.save !== undefined)

// Render with a snapshot shaped like the settings form's.
/** Resolve wrapper components the shim does not render. */
function renderFully(element) {
  let node = element
  // The slot passes the real props to SettingsPage, so call it with the same.
  if (typeof node?.type === 'function') {
    node = node.type({ ...node.props, t: key => dictZh[key] ?? key, form: fakeForm, locale: 'zh' })
  }
  return node
}

const tree = renderFully(pageComponent({
  t: key => dictZh[key] ?? key,
  form: fakeForm,
  locale: 'zh',
}))

// Walk the element tree looking for the cookie rows.
function walk(node, visit) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) { for (const item of node) walk(item, visit); return }
  if (typeof node !== 'object') return
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
  // props.children may hold the real subtree when the shim did not flatten it
  const nested = node.props?.children
  if (nested !== undefined && (node.children ?? []).length === 0) walk(nested, visit)
}

let rowCount = 0
const rowLabels = []
let sawPerSourceHint = false
let sawSecurityNote = false
walk(tree, node => {
  const typeName = typeof node.type === 'function' ? node.type.name : node.type
  if (typeName === 'CookieRow') {
    rowCount += 1
    rowLabels.push(node.props.id)
    // Each row must be bound to its own id and read the stored value for it.
    if (node.props.id === 'baidu' && node.props.value !== 'BAIDUID=abc; BDUSS=xyz') {
      console.log(`  FAIL baidu row has wrong value: ${JSON.stringify(node.props.value)}`)
      failures += 1
    }
  }
  if (typeof node.children?.[0] === 'string') {
    if (node.children[0].includes('每个搜索源')) sawPerSourceHint = true
    if (node.children[0].includes('明文')) sawSecurityNote = true
  }
})

check('renders one row per source', rowCount === 5, `got ${rowCount}`)
check('rows cover all five sources', ['bing', '360', 'baidu', 'duckduckgo', 'sogou'].every(id => rowLabels.includes(id)), rowLabels.join(','))
check('shows the per-source hint', sawPerSourceHint)
check('shows the plaintext warning', sawSecurityNote)

// ── the write path ─────────────────────────────────────────────────────────
const baiduRow = (() => {
  let found
  walk(tree, node => { const n = typeof node.type === 'function' ? node.type.name : node.type; if (n === 'CookieRow' && node.props.id === 'baidu') found = node })
  return found
})()
check('baidu row is editable', baiduRow !== undefined && baiduRow.props.disabled === false)

// Saving one source must write the whole map, preserving the others.
await baiduRow.props.onSave('BAIDUID=new; BDUSS=new')
check(
  'save writes the merged map',
  fakeForm.value.cookiesBySource.baidu === 'BAIDUID=new; BDUSS=new',
  JSON.stringify(fakeForm.value.cookiesBySource),
)

// Clearing removes the key rather than storing an empty string.
await baiduRow.props.onSave('')
check(
  'clearing removes the key',
  fakeForm.value.cookiesBySource.baidu === undefined,
  JSON.stringify(fakeForm.value.cookiesBySource),
)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
