const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createState, registerPush, publishManifest } = require('../publish/release-state.cjs')
const { GitHub, GitHubError, PUBLICATION_LEASE_MS } = require('../publish/github.cjs')
const { seedState, pushContext, inject, makeManifest, requireCompleteRelease } = require('../publish/release.cjs')
const { githubFixture, releaseManifest, loadRelease, fixtureConfig: config } = require('./helpers/github.cjs')
const sha = value => value.repeat(40)
const event = (branch, value, before, bootstrap = false) => ({ branch, sha: sha(value), before: sha(before), bootstrap })

test('one version per push snapshot, shared Android codes, reruns do not allocate', () => {
  const state = createState('1.9.2', 100000)
  const first = registerPush(state, event('Next', 'a', '0', true))
  const second = registerPush(state, event('Next', 'b', 'a'))
  const stable = registerPush(state, event('master', 'c', '0', true))
  const next = registerPush(state, event('Next', 'd', 'b'))
  assert.deepEqual([first.version, second.version, stable.version, next.version], ['1.9.3-next.1', '1.9.3-next.2', '1.9.3', '1.9.4-next.4'])
  assert.deepEqual([first.versionCode, second.versionCode, stable.versionCode, next.versionCode], [100001, 100002, 100003, 100004])
  assert.equal(registerPush(state, event('master', 'c', '0')), stable)
  assert.equal(state.sequence, 4)
})

test('later master run waits and cannot get an earlier version than its predecessor', () => {
  const state = createState('1.9.2', 100000)
  assert.equal(registerPush(state, event('master', 'c', 'b')), null)
  assert.equal(registerPush(state, event('master', 'b', 'a')), null)
  assert.equal(state.sequence, 0)
  registerPush(state, event('master', 'a', '0', true))
  assert.deepEqual(['a', 'b', 'c'].map(value => state.builds[`master/${sha(value)}`].version), ['1.9.3', '1.9.4', '1.9.5'])
  assert.equal(state.sequence, 3)
})

test('explicit release targets persist from Next to master without guessing commits', () => {
  const state = createState('1.9.2', 100000)
  assert.equal(registerPush(state, { ...event('Next', 'a', '0', true), targetVersion: '2.0.0' }).version, '2.0.0-next.1')
  assert.equal(registerPush(state, event('master', 'b', '0', true)).version, '2.0.0')
  assert.equal(registerPush(state, event('Next', 'c', 'a')).version, '2.0.1-next.3')
})

test('late completion marks old builds published without moving channel backwards', () => {
  const state = createState('1.9.2', 100000)
  const first = registerPush(state, event('master', 'a', '0', true))
  const second = registerPush(state, event('master', 'b', 'a'))
  const newest = { ...second, desc: 'second', publishedAt: '2026-11-12T00:00:00Z' }
  assert.equal(publishManifest(state, newest), true)
  assert.equal(publishManifest(state, { ...first, desc: 'first' }), false)
  assert.equal(state.channels.stable.version, '1.9.4')
  assert.equal(state.builds[`master/${sha('a')}`].status, 'published')
})

test('bootstrap only belongs to earliest push run when Actions startup is reversed', async() => {
  const runs = [
    { run_number: 2, event: 'push', head_branch: 'master', head_sha: sha('b') },
    { run_number: 1, event: 'push', head_branch: 'master', head_sha: sha('a') },
    { run_number: 0, event: 'push', head_branch: 'v1.9.2', head_sha: sha('0') },
    { run_number: 0, event: 'workflow_dispatch', head_branch: 'master', head_sha: sha('0') },
  ]
  const github = { readState: async() => ({ state: null }), list: async() => runs }
  assert.equal((await pushContext(github, { ref: 'refs/heads/master', before: sha('a'), after: sha('b') }, { GITHUB_EVENT_NAME: 'push' })).bootstrap, false)
  assert.equal((await pushContext(github, { ref: 'refs/heads/master', before: sha('0'), after: sha('a') }, { GITHUB_EVENT_NAME: 'push' })).bootstrap, true)
})

test('manual rerun of allocated source reuses reservation without a before input', async() => {
  const record = { before: sha('a'), version: '1.9.3' }
  const github = { readState: async() => ({ state: { builds: { [`master/${sha('b')}`]: record } } }) }
  const result = await pushContext(github, { inputs: { source_branch: 'master', source_sha: sha('b') } }, { GITHUB_EVENT_NAME: 'workflow_dispatch' })
  assert.equal(result.before, sha('a'))
  assert.equal(result.reservation, record)
})

test('established branch ordering does not depend on the Actions 1000-run search window', async() => {
  const github = {
    readState: async() => ({ state: { builds: {}, branches: { master: sha('a') } } }),
    list: async() => { throw new Error('Existing before/after chain must not enumerate workflow history') },
  }
  const context = await pushContext(github, { ref: 'refs/heads/master', before: sha('a'), after: sha('b') }, { GITHUB_EVENT_NAME: 'push' })
  assert.equal(context.bootstrap, false)
  assert.equal(context.before, sha('a'))
})

for (const reason of ['[skip ci]', 'skip-checks', 'GITHUB_TOKEN']) {
  test(`manual registration recovers a ${reason} push and releases all waiting successors in order`, async() => {
    const state = createState('1.9.2', 100000)
    registerPush(state, event('master', 'a', '0', true))
    assert.equal(registerPush(state, event('master', 'd', 'c')), null)
    assert.equal(registerPush(state, event('master', 'c', 'b')), null)
    assert.equal(state.sequence, 1)
    const comparisons = []
    const github = {
      readState: async() => ({ state }),
      list: async() => { assert.fail('Missing-run recovery must not require workflow history') },
      request: async(method, route) => { comparisons.push(route); return { status: 'ahead' } },
    }
    const context = await pushContext(github, { inputs: { source_branch: 'master', source_sha: sha('b'), before_sha: sha('a') } }, { GITHUB_EVENT_NAME: 'workflow_dispatch' })
    assert.equal(context.bootstrap, false)
    registerPush(state, context)
    assert.deepEqual(comparisons, [`/compare/${sha('b')}...master`, `/compare/${sha('a')}...${sha('b')}`])
    assert.deepEqual(['a', 'b', 'c', 'd'].map(value => state.builds[`master/${sha(value)}`].version), ['1.9.3', '1.9.4', '1.9.5', '1.9.6'])
    assert.deepEqual(['a', 'b', 'c', 'd'].map(value => state.builds[`master/${sha(value)}`].versionCode), [100001, 100002, 100003, 100004])
    assert.equal(state.sequence, 4)
    assert.equal(Object.keys(state.events).length, 0)
    const rerun = await pushContext(github, { inputs: { source_branch: 'master', source_sha: sha('b') } }, { GITHUB_EVENT_NAME: 'workflow_dispatch' })
    assert.equal(registerPush(state, rerun).version, '1.9.4')
    assert.equal(state.sequence, 4)
  })
}

test('missing push recovery on Next preserves preview ordering and one shared sequence', async() => {
  const state = createState('1.9.2', 100000)
  registerPush(state, event('Next', 'a', '0', true))
  registerPush(state, event('Next', 'e', 'd'))
  registerPush(state, event('Next', 'c', 'b'))
  const github = {
    readState: async() => ({ state }),
    request: async() => ({ status: 'ahead' }),
  }
  // Recover two missing edges in reverse startup order, without skipping C.
  for (const [value, before] of [['d', 'c'], ['b', 'a']]) {
    registerPush(state, await pushContext(github, { inputs: { source_branch: 'Next', source_sha: sha(value), before_sha: sha(before) } }, { GITHUB_EVENT_NAME: 'workflow_dispatch' }))
  }
  assert.deepEqual(['a', 'b', 'c', 'd', 'e'].map(value => state.builds[`Next/${sha(value)}`].version), ['1.9.3-next.1', '1.9.3-next.2', '1.9.3-next.3', '1.9.3-next.4', '1.9.3-next.5'])
  assert.equal(state.sequence, 5)
})

test('manual recovery validates branch reachability and before ancestry before reserving', async() => {
  const state = createState('1.9.2', 100000)
  registerPush(state, event('master', 'a', '0', true))
  const inputs = { source_branch: 'master', source_sha: sha('b'), before_sha: sha('a') }
  for (const [source, history, message] of [
    ['diverged', 'ahead', /not on the selected release branch/],
    ['ahead', 'behind', /must precede the source SHA/],
    ['identical', 'identical', /must precede the source SHA/],
  ]) {
    const github = {
      readState: async() => ({ state }),
      request: async(method, route) => ({ status: route.endsWith('...master') ? source : history }),
    }
    await assert.rejects(pushContext(github, { inputs }, { GITHUB_EVENT_NAME: 'workflow_dispatch' }), message)
    assert.equal(state.sequence, 1)
    assert.equal(state.branches.master, sha('a'))
  }
})

test('the first manually registered push can bootstrap when no release push ever triggered Actions', async() => {
  const state = createState('1.9.2', 100000)
  const github = { readState: async() => ({ state }), request: async() => ({ status: 'identical' }), list: async() => [] }
  const context = await pushContext(github, { inputs: { source_branch: 'master', source_sha: sha('a'), before_sha: sha('0') } }, { GITHUB_EVENT_NAME: 'workflow_dispatch' })
  assert.equal(context.bootstrap, true)
  assert.equal(registerPush(state, context).version, '1.9.3')
})

test('initialization inspects actual historical split APK codes and all existing tags', async() => {
  const downloaded = []
  const releases = [{ id: 1, draft: false, prerelease: false, tag_name: 'v1.9.4', body: 'history', published_at: '2026-11-01T00:00:00Z', assets: [{ id: 10, name: 'old-arm64.apk' }, { id: 11, name: 'old-universal.apk' }] }]
  const github = {
    list: async() => releases,
    request: async(method, route) => route.includes('matching-refs') ? [{ ref: 'refs/tags/v1.9.5-next.10' }] : { object: { type: 'commit', sha: sha('c') } },
    downloadAsset: async(asset, target) => { downloaded.push(asset.id); fs.writeFileSync(target, String(asset.id)) },
  }
  const state = await seedState(github, config, { version: '1.9.2', name: 'lx-music-mobile' }, file => ({ applicationId: config.applicationId, certificateSha256: 'a'.repeat(64), versionCode: fs.readFileSync(file, 'utf8') === '10' ? 230004 : 230 }))
  assert.deepEqual(downloaded, [10, 11])
  assert.equal(state.versionCodeBase, 230004)
  assert.equal(state.sequence, 10)
  assert.equal(state.lastStableVersion, '1.9.4')
  assert.equal(registerPush(state, event('Next', 'a', '0', true)).versionCode, 230015)
})

test('CI injection synchronizes npm root version without rewriting dependencies', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-injection-test-'))
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'lx-music-mobile', version: '1.9.2', versionCode: 79 }))
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ version: '1.9.2', packages: { '': { version: '1.9.2' }, 'node_modules/foo': { version: '2.0.0' } } }))
    inject({ version: '1.9.3-next.2', versionCode: 100002, channel: 'next', sourceSha: sha('a') }, root)
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
    assert.equal(pkg.releaseSourceSha, sha('a'))
    assert.equal(pkg.versionCode, 100002)
    assert.equal(lock.packages[''].version, '1.9.3-next.2')
    assert.equal(lock.packages['node_modules/foo'].version, '2.0.0')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('incomplete published assets are refused before channel promotion', () => {
  const record = { channel: 'stable', version: '1.9.3', versionCode: 100001, tag: 'v1.9.3', sourceSha: sha('a') }
  const manifest = makeManifest(record, config.abis.map(abi => ({ abi, fileName: `${abi}.apk`, size: 10 })), { builds: {}, legacyHistory: [] }, 'changes')
  const assets = [...manifest.assets.map(asset => ({ name: asset.fileName, size: 10, state: 'uploaded' })), { name: 'update.json', state: 'uploaded' }, { name: 'SHA256SUMS.txt', state: 'uploaded' }]
  const release = { tag_name: manifest.tag, prerelease: false, assets }
  requireCompleteRelease(release, manifest)
  assert.throws(() => requireCompleteRelease({ ...release, assets: assets.slice(1) }, manifest), /incomplete asset/)
  assert.throws(() => requireCompleteRelease(release, { ...manifest, assets: manifest.assets.slice(1) }), /missing an expected/)
})

test('old stable completion reconciles Latest to newest public release after pointer failures', async() => {
  const state = createState('1.9.2', 100000)
  const first = registerPush(state, event('master', 'a', '0', true))
  registerPush(state, event('master', 'b', 'a'))
  const newest = registerPush(state, event('master', 'c', 'b'))
  const preview = registerPush(state, event('Next', 'd', '0', true))
  const app = githubFixture(state)
  for (const record of [first, newest, preview]) app.addRelease(releaseManifest(record))
  await loadRelease(releaseManifest(first)).promote(app.github, releaseManifest(first), 'test', undefined, () => false)
  assert.equal(app.latest.tag_name, newest.tag)
  assert.equal(app.channel('stable').tag, newest.tag)
  assert.equal(app.channel('next').tag, preview.tag)
})

test('GitHub metadata compare-and-swap retries sibling conflicts without force pushing', async() => {
  const github = new GitHub('owner/repository', 'test-token', 'release-meta')
  const base = { ...createState('1.9.2', 100000), repository: 'owner/repository' }
  let snapshotReads = 0
  const parents = []
  const writes = []
  github.readState = async() => {
    snapshotReads++
    return { head: snapshotReads === 1 ? 'first' : 'concurrent', tree: 'tree', state: structuredClone(base) }
  }
  github.request = async(method, route, { json } = {}) => {
    if (route === '/git/trees') return { sha: 'new-tree' }
    if (route === '/git/commits') { parents.push(json.parents); return { sha: `commit-${parents.length}` } }
    writes.push(json)
    if (writes.length === 1) throw new GitHubError(422, 'not a fast forward')
    return {}
  }
  await github.updateState(state => { state.sequence++ })
  assert.deepEqual(parents, [['first'], ['concurrent']])
  assert.ok(writes.every(write => write.force === false))
})

test('workflow run pagination accepts wrapped workflow_runs responses', async() => {
  const github = new GitHub('owner/repository', 'test-token', 'release-meta')
  github.request = async() => ({ workflow_runs: [{ id: 1, head_sha: sha('a') }] })
  assert.deepEqual(await github.list('/actions/workflows/release.yml/runs'), [{ id: 1, head_sha: sha('a') }])
})

test('public release rerun only verifies existing assets and repairs its pointer', async() => {
  const state = createState('1.9.2', 100000)
  const record = registerPush(state, event('Next', 'a', '0', true))
  const manifest = releaseManifest(record)
  const app = githubFixture(state)
  app.addRelease(manifest)
  assert.deepEqual(await loadRelease(manifest).publish(app.github, record, () => false), manifest)
  assert.equal(app.channel('next').tag, record.tag)
  assert.ok(app.calls.filter(call => call.route.startsWith('/releases')).every(call => call.method === 'GET'))
})

test('release publication and Latest advancement occur within the same promotion lock', async() => {
  let held = false
  const calls = []
  const state = createState('1.9.2', 100000)
  const record = registerPush(state, event('master', 'a', '0', true))
  const info = releaseManifest(record)
  const app = githubFixture(state)
  const release = app.addRelease(info, { draft: true })
  const lock = app.github.withPromotionLock.bind(app.github)
  app.github.withPromotionLock = (owner, work) => lock(owner, async lease => {
    held = true
    try { return await work(lease) } finally { held = false }
  })
  const request = app.github.request
  app.github.request = async(method, route, options) => {
    if (route === '/git/trees' && options.json.tree.some(file => file.path === 'channels/stable.json')) { assert.equal(held, true); calls.push('channel') }
    if (route === `/releases/${release.id}` && method === 'PATCH') { assert.equal(held, true); calls.push('latest') }
    return request(method, route, options)
  }
  await loadRelease(info).promote(app.github, info, 'owner', async() => { assert.equal(held, true); release.draft = false; calls.push('public') }, () => false)
  assert.deepEqual(calls, ['public', 'channel', 'latest'])
})

test('a worker that lost its lease cannot continue publication or remove the new owner lock', async() => {
  const github = new GitHub('owner/repository', 'test-token', 'release-meta')
  const state = createState('1.9.2', 100000)
  github.updateState = async change => ({ result: change(state), state })
  github.readState = async() => ({ state })
  await assert.rejects(github.withLock('releaseLock', 'old', 1000, async lease => {
    state.releaseLock = { owner: 'new', expiresAt: Date.now() + 1000 }
    await lease.assertOwned()
    assert.fail('Lost owner must not continue')
  }), /ownership was lost/)
  assert.equal(state.releaseLock.owner, 'new')
})
