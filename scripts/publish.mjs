// Push the working tree to GitHub through the Contents API.
//
// git over schannel fails on this machine (CRYPT_E_NO_REVOCATION_CHECK), so this
// uploads each changed file as a Contents API write and then moves the branch
// ref. The token comes from the environment and is never written to disk.
//
// Usage: GH_TOKEN=… node scripts/publish.mjs [--dry]
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const TOKEN = process.env.GH_TOKEN
if (TOKEN === undefined) {
  console.error('GH_TOKEN is required')
  process.exit(1)
}

const OWNER = 'cubestudio-dev'
const REPO = 'Cube_DSH_Free-local-search'
const BRANCH = 'main'
const API = `https://api.github.com/repos/${OWNER}/${REPO}`
const HEADERS = {
  authorization: `Bearer ${TOKEN}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'cube-dsh-free-publish',
  'content-type': 'application/json',
}

const dry = process.argv.includes('--dry')

// Files to publish: the plugin's own tree, minus local-only artifacts.
const SKIP_DIRS = new Set(['node_modules', '.git', '.test-node_modules', 'out', '.verify'])
const SKIP_FILES = new Set(['.DS_Store'])

/** @returns {string[]} relative POSIX paths. */
function walk(dir) {
  /** @type {string[]} */
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue
      out.push(...walk(full))
    } else {
      if (SKIP_FILES.has(name)) continue
      out.push(relative('.', full).split('\\').join('/'))
    }
  }
  return out.sort()
}

const files = walk('.')
console.log(`publishing ${files.length} files to ${OWNER}/${REPO}@${BRANCH}`)
if (dry) {
  console.log(files.join('\n'))
  process.exit(0)
}

/** One API call, with the response body returned for inspection. */
async function call(url, method = 'GET', body) {
  const response = await fetch(url, {
    method,
    headers: HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json
  try {
    json = text === '' ? undefined : JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: response.status, json, text }
}

// 1. current branch head, so the new commit has a parent
const ref = await call(`${API}/git/ref/heads/${BRANCH}`)
if (ref.status !== 200) {
  console.error(`cannot read branch ${BRANCH}: ${ref.status} ${ref.text.slice(0, 200)}`)
  process.exit(1)
}
const parent = ref.json.object.sha
console.log(`parent commit: ${parent}`)

// 2. upload each blob
/** @type {Array<{ path: string, sha: string, mode: string, type: string }>} */
const tree = []
for (const path of files) {
  const content = readFileSync(path).toString('base64')
  const blob = await call(`${API}/git/blobs`, 'POST', { content, encoding: 'base64' })
  if (blob.status !== 201) {
    console.error(`blob ${path}: ${blob.status} ${blob.text.slice(0, 200)}`)
    process.exit(1)
  }
  const mode = /\.(mjs|js|json|yml|md|svg|html)$/.test(path) ? '100644' : '100644'
  tree.push({ path, sha: blob.json.sha, mode, type: 'blob' })
  process.stdout.write('.')
}
console.log(`\n${tree.length} blobs uploaded`)

// 3. one tree, one commit, then move the ref
const newTree = await call(`${API}/git/trees`, 'POST', { tree })
if (newTree.status !== 201) {
  console.error(`tree: ${newTree.status} ${newTree.text.slice(0, 300)}`)
  process.exit(1)
}

const message = readFileSync('.git/COMMIT_EDITMSG', 'utf8').trim() || 'update'
const commit = await call(`${API}/git/commits`, 'POST', {
  message,
  tree: newTree.json.sha,
  parents: [parent],
  author: {
    name: 'cubestudio-dev',
    email: '334166755+cubestudio-dev@users.noreply.github.com',
    date: new Date().toISOString(),
  },
})
if (commit.status !== 201) {
  console.error(`commit: ${commit.status} ${commit.text.slice(0, 300)}`)
  process.exit(1)
}
console.log(`new commit: ${commit.json.sha}`)

const moved = await call(`${API}/git/refs/heads/${BRANCH}`, 'PATCH', { sha: commit.json.sha, force: true })
if (moved.status !== 200) {
  console.error(`ref: ${moved.status} ${moved.text.slice(0, 300)}`)
  process.exit(1)
}
console.log(`moved ${BRANCH} → ${commit.json.sha}`)
console.log(`https://github.com/${OWNER}/${REPO}/commit/${commit.json.sha}`)
