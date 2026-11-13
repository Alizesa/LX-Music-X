const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createHash } = require('node:crypto')
const { GitHub, GitHubError } = require('../../publish/github.cjs')
const { repository, packageName, manifest: makeFixture } = require('./release.cjs')
const fixtureConfig = { ...require('../../publish/release-config.json'), targetVersion: null, signingCertificateSha256: null }

const digest = value => createHash('sha256').update(value).digest('hex')
const apkBytes = Buffer.from('in-memory regression fixture; not an Android package')
const fingerprint = 'a'.repeat(64)
const releaseManifest = record => {
  const info = { ...makeFixture(record.version, record.versionCode), sourceSha: record.sourceSha, signingCertificateSha256: fingerprint }
  for (const asset of info.assets) { asset.size = apkBytes.length; asset.sha256 = digest(apkBytes) }
  return info
}
const artifactFiles = info => new Map([
  ...info.assets.map(asset => [asset.fileName, apkBytes]),
  ['update.json', Buffer.from(JSON.stringify(info) + '\n')],
  ['SHA256SUMS.txt', Buffer.from(info.assets.map(asset => `${asset.sha256}  ${asset.fileName}\n`).join(''))],
  ['package.json', Buffer.from(JSON.stringify({ name: packageName, version: info.version, versionCode: info.versionCode }))],
])

// Real release orchestration and real GitHub state/lease methods, with only
// transport and local artifact IO replaced. No live credentials or Android tools.
const loadRelease = (info, { config = fixtureConfig, clock = Date, delay, apkInspector } = {}) => {
  const files = artifactFiles(info)
  const loaded = { exports: {} }
  const virtualFs = {
    readFileSync: (file, encoding) => {
      const value = files.get(path.basename(file))
      assert.ok(value, `Unexpected fixture read: ${file}`)
      return encoding ? value.toString(encoding) : value
    },
    statSync: file => ({ size: files.get(path.basename(file)).length }),
    existsSync: file => files.has(path.basename(file)),
    copyFileSync: (from, to) => files.set(path.basename(to), Buffer.from(files.get(path.basename(from)))),
    mkdirSync() {},
    mkdtempSync: prefix => prefix + 'fixture',
    rmSync() {},
    unlinkSync: file => files.delete(path.basename(file)),
    writeFileSync: (file, data) => files.set(path.basename(file), Buffer.from(data)),
    appendFileSync: (file, data) => files.set(path.basename(file), Buffer.concat([files.get(path.basename(file)) ?? Buffer.alloc(0), Buffer.from(data)])),
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../publish/release.cjs'), 'utf8'), {
    module: loaded, __dirname: path.resolve(__dirname, '../../publish'),
    Date: clock,
    process: { env: { GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' } }, console: { log() {} },
    require: name => {
      if (name === 'node:fs') return virtualFs
      if (name === 'node:timers/promises' && delay) return { setTimeout: delay }
      if (name === './android-tools.cjs' && apkInspector) return { createApkInspector: () => apkInspector }
      if (name === './release-config.json' && config) return config
      if (name === 'node:child_process') return { execFileSync: (executable, args) => {
        assert.equal(executable, 'git')
        if (args[0] === 'log') return '- Update flow fixture\n'
        assert.deepEqual([...args], ['rev-parse', 'HEAD'])
        return info.sourceSha + '\n'
      } }
      return name.startsWith('.') ? require(path.resolve(__dirname, '../../publish', name)) : require(name)
    },
  })
  return { ...loaded.exports, files }
}

const githubFixture = initial => {
  const state = initial ? { ...structuredClone(initial), repository } : null
  let head = state ? 'commit0' : null, objectId = 0, assetId = 0, releaseId = 0
  const commits = new Map([['commit0', { tree: { sha: 'tree0' } }]])
  const initialFiles = new Map([['state.json', 'blob0']])
  const trees = new Map([['tree0', initialFiles]])
  const blobs = new Map([['blob0', JSON.stringify(state)]])
  for (const [channel, info] of Object.entries(state?.channels ?? {})) {
    const blob = `channel-${channel}`
    initialFiles.set(`channels/${channel}.json`, blob)
    blobs.set(blob, JSON.stringify(info))
  }
  const tags = new Map(), releases = [], assets = new Map(), calls = [], failures = []
  let latestId = null
  const addAsset = (release, name, bytes) => {
    const asset = { id: ++assetId, name, size: bytes.length, state: 'uploaded', digest: `sha256:${digest(bytes)}` }
    assets.set(asset.id, bytes)
    release.assets.push(asset)
    return asset
  }
  const addRelease = (info, { draft = false } = {}) => {
    const release = { id: ++releaseId, tag_name: info.tag, draft, prerelease: info.channel === 'next', assets: [], published_at: info.publishedAt }
    for (const [name, bytes] of artifactFiles(info)) {
      if (name !== 'package.json') addAsset(release, name, bytes)
    }
    releases.push(release)
    tags.set(info.tag, info.sourceSha)
    return release
  }
  const request = async(method, route, options = {}) => {
    const call = { method, route, ...options }
    calls.push(call)
    const failure = failures.findIndex(item => item.when(call))
    if (failure >= 0) throw failures.splice(failure, 1)[0].error
    const { json } = options
    if (route === '/git/ref/heads/release-meta') return head ? { object: { sha: head } } : null
    if (route.startsWith('/git/commits/') && method === 'GET') return structuredClone(commits.get(route.split('/').pop()))
    if (route.startsWith('/git/trees/') && method === 'GET') return { tree: [...trees.get(route.split('/').pop())].map(([path, sha]) => ({ path, sha, type: 'blob' })) }
    if (route.startsWith('/git/blobs/')) return { content: Buffer.from(blobs.get(route.split('/').pop())).toString('base64') }
    if (route === '/git/trees' && method === 'POST') {
      const files = new Map(trees.get(json.base_tree))
      for (const file of json.tree) { const id = `blob${++objectId}`; blobs.set(id, file.content); files.set(file.path, id) }
      const tree = `tree${++objectId}`
      trees.set(tree, files)
      return { sha: tree }
    }
    if (route === '/git/commits' && method === 'POST') {
      const commit = `commit${++objectId}`
      commits.set(commit, { tree: { sha: json.tree }, parents: json.parents })
      return { sha: commit }
    }
    if (route === '/git/refs/heads/release-meta' && method === 'PATCH') {
      assert.equal(json.force, false)
      if (commits.get(json.sha).parents[0] !== head) throw new GitHubError(422, 'Not a fast forward')
      head = json.sha
      return {}
    }
    if (route.startsWith('/git/ref/tags/')) {
      const sha = tags.get(decodeURIComponent(route.split('/').pop()))
      return sha ? { object: { type: 'commit', sha } } : null
    }
    if (route === '/git/matching-refs/tags/v') return [...tags].map(([tag, sha]) => ({ ref: `refs/tags/${tag}`, object: { type: 'commit', sha } }))
    if (route === '/git/refs' && method === 'POST') {
      if (json.ref === 'refs/heads/release-meta') {
        if (head) throw new GitHubError(422, 'Reference already exists')
        head = json.sha
        return { object: { type: 'commit', sha: head } }
      }
      const tag = json.ref.replace('refs/tags/', '')
      if (tags.has(tag)) throw new GitHubError(422, 'Reference already exists')
      tags.set(tag, json.sha)
      return { object: { type: 'commit', sha: json.sha } }
    }
    if (route.startsWith('/releases/tags/')) return structuredClone(releases.find(item => item.tag_name === decodeURIComponent(route.split('/').pop())) ?? null)
    if (route.startsWith('/releases?')) {
      const page = Number(new URL('https://fixture.invalid' + route).searchParams.get('page'))
      return structuredClone(releases.slice((page - 1) * 100, page * 100))
    }
    if (route === '/releases' && method === 'POST') {
      const release = { id: ++releaseId, ...json, assets: [] }
      releases.push(release)
      return structuredClone(release)
    }
    const assetRoute = /^\/releases\/assets\/(\d+)$/.exec(route)
    if (assetRoute && method === 'GET') return JSON.parse(assets.get(Number(assetRoute[1])).toString('utf8'))
    if (assetRoute && method === 'DELETE') {
      const id = Number(assetRoute[1])
      assets.delete(id)
      for (const release of releases) release.assets = release.assets.filter(asset => asset.id !== id)
      return null
    }
    const upload = /^\/releases\/(\d+)\/assets\?/.exec(route)
    if (upload && method === 'POST') return structuredClone(addAsset(releases.find(item => item.id === Number(upload[1])), new URL('https://fixture.invalid' + route).searchParams.get('name'), options.body))
    const releaseRoute = /^\/releases\/(\d+)$/.exec(route)
    if (releaseRoute && method === 'PATCH') {
      const release = releases.find(item => item.id === Number(releaseRoute[1]))
      Object.assign(release, json)
      if (json.make_latest === 'true') latestId = release.id
      return structuredClone(release)
    }
    throw new Error(`Unexpected fixture request: ${method} ${route}`)
  }
  const client = () => {
    const github = new GitHub(repository, 'fixture-token', 'release-meta', async() => assert.fail('No live GitHub transport is allowed'))
    github.request = request
    github.downloadAsset = async(asset, file) => fs.writeFileSync(file, assets.get(asset.id))
    return github
  }
  const readFile = file => {
    if (!head) return null
    const blob = trees.get(commits.get(head).tree.sha).get(file)
    return blob ? JSON.parse(blobs.get(blob)) : null
  }
  return {
    github: client(), client, calls, releases, addRelease, get state() { return readFile('state.json') },
    channel: channel => readFile(`channels/${channel}.json`), get latest() { return releases.find(item => item.id === latestId) },
    failOnce: (when, error = new Error('simulated API failure')) => failures.push({ when, error }),
    assetBytes: (tag, fileName) => {
      const release = releases.find(item => item.tag_name === tag && !item.draft)
      assert.ok(release, 'Only public releases are downloadable')
      const asset = release.assets.find(item => item.name === fileName && item.state === 'uploaded')
      assert.ok(asset, 'The requested asset must have been uploaded')
      return Buffer.from(assets.get(asset.id))
    },
  }
}

module.exports = { githubFixture, releaseManifest, loadRelease, fingerprint, fixtureConfig }
