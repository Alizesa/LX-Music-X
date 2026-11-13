const test = require('node:test')
const assert = require('node:assert/strict')
const { createState, registerPush, publishManifest } = require('../publish/release-state.cjs')
const { seedState, pushContext } = require('../publish/release.cjs')
const { githubFixture, releaseManifest, loadRelease, fingerprint, fixtureConfig: config } = require('./helpers/github.cjs')

const sha = value => value.repeat(40)
const event = (branch, value, before, bootstrap = false) => ({ branch, sha: sha(value), before: sha(before), bootstrap })
const initial = () => ({ ...createState('1.9.2', 100000), signingCertificateSha256: fingerprint, signingHistoryChecked: true })
const channelWrite = (tag, channel = 'stable') => call => call.route === '/git/trees' && call.json.tree.some(file => file.path === `channels/${channel}.json` && JSON.parse(file.content)?.tag === tag)

test('a full publication uses fewer than 70 API calls while keeping all assets and both pointers verified', async t => {
  const state = initial()
  const record = registerPush(state, event('master', 'a', '0', true))
  const app = githubFixture(state)
  await loadRelease(releaseManifest(record)).publish(app.github, record, () => false)
  assert.equal(app.releases[0].draft, false)
  assert.equal(app.releases[0].assets.length, 7)
  assert.equal(app.channel('stable').tag, record.tag)
  assert.equal(app.latest.tag_name, record.tag)
  assert.ok(app.calls.length < 70, `${app.calls.length} requests exceeds the publication budget`)
  assert.ok(app.calls.filter(call => call.route === '/git/refs/heads/release-meta').every(call => call.json.force === false))
  t.diagnostic(`First stable publication: ${app.calls.length} API calls (was 131); no retries or heartbeat renewals`)
})

test('immutable snapshot caching still checks the ref and never exposes its internal state object', async() => {
  const app = githubFixture(initial())
  const first = await app.github.readState()
  assert.equal(app.calls.length, 4)
  first.state.sequence = 999
  assert.equal((await app.github.readState()).state.sequence, 0)
  assert.equal(app.calls.length, 5)
  await app.github.updateState(state => { state.sequence++ })
  const offset = app.calls.length
  assert.equal((await app.github.readState()).state.sequence, 1)
  assert.equal(app.calls.length - offset, 1)
  await app.client().updateState(state => { state.sequence++ })
  const changed = app.calls.length
  assert.equal((await app.github.readState()).state.sequence, 2)
  assert.equal(app.calls.length - changed, 4)
})

test('a ref change invalidates cached lease ownership and the old worker cannot remove the new lock', async() => {
  const app = githubFixture(initial())
  await assert.rejects(app.github.withPromotionLock('old', async lease => {
    await lease.assertOwned()
    await app.client().updateState(state => { state.promotionLock = { owner: 'new', expiresAt: Date.now() + 120000 } })
    await lease.assertOwned()
    assert.fail('A stale snapshot must not authorize publication')
  }), /ownership was lost/)
  assert.equal(app.state.promotionLock.owner, 'new')
})

for (const recovery of ['older stable', 'new preview']) {
  test(`${recovery} publication repairs a newer public stable release after its channel write failed`, async() => {
    const state = initial()
    const first = registerPush(state, event('master', 'a', '0', true))
    const second = registerPush(state, event('master', 'b', 'a'))
    const recovering = recovery === 'older stable' ? first : registerPush(state, event('Next', 'c', '0', true))
    const app = githubFixture(state)
    app.failOnce(channelWrite(second.tag))
    await assert.rejects(loadRelease(releaseManifest(second)).publish(app.github, second, () => false), /simulated API failure/)
    assert.equal(app.releases.find(release => release.tag_name === second.tag).draft, false)
    assert.equal(app.state.channels.stable, undefined)
    assert.equal(app.state.builds[`master/${second.sourceSha}`].status, 'allocated')
    const offset = app.calls.length
    await loadRelease(releaseManifest(recovering)).publish(app.github, recovering, () => false)
    assert.equal(app.channel('stable').tag, second.tag)
    assert.equal(app.latest.tag_name, second.tag)
    assert.equal(app.state.builds[`master/${second.sourceSha}`].status, 'published')
    if (recovery === 'new preview') assert.equal(app.channel('next').tag, recovering.tag)
    const newerRelease = app.releases.find(release => release.tag_name === second.tag)
    assert.ok(app.calls.slice(offset).filter(call => call.route.includes(`/releases/${newerRelease.id}/assets`)).every(call => call.method === 'GET'))
  })
}

test('a public preview whose higher version was allocated by old code is withdrawn when stable contains its source', async() => {
  const state = initial()
  const stable = registerPush(state, event('master', 'b', '0', true))
  // Simulate an unsafe reservation made before ancestry checks were added.
  const oldPreview = registerPush(state, event('Next', 'a', '0', true))
  const preview = releaseManifest(oldPreview)
  publishManifest(state, preview)
  const app = githubFixture(state)
  app.addRelease(preview)
  await loadRelease(releaseManifest(stable)).publish(app.github, stable, (a, b) => a === sha('a') && b === sha('b'))
  assert.equal(app.channel('next'), null)
  assert.equal(app.channel('stable').tag, stable.tag)
  assert.equal(app.state.builds[`Next/${oldPreview.sourceSha}`].supersededBy, stable.tag)
  assert.equal(app.releases.find(release => release.tag_name === preview.tag).draft, false)
})

test('a late unsafe preview remains a historical release and cannot re-enter the update channel', async() => {
  const state = initial()
  const stable = registerPush(state, event('master', 'b', '0', true))
  const preview = registerPush(state, event('Next', 'a', '0', true))
  const stableInfo = releaseManifest(stable)
  publishManifest(state, stableInfo)
  const app = githubFixture(state)
  app.addRelease(stableInfo)
  const pipeline = loadRelease(releaseManifest(preview))
  const contains = (a, b) => a === sha('a') && b === sha('b')
  await pipeline.publish(app.github, preview, contains)
  await pipeline.publish(app.github, preview, contains)
  assert.equal(app.state.channels.next, undefined)
  assert.equal(app.channel('stable').tag, stable.tag)
  assert.equal(app.latest.tag_name, stable.tag)
  assert.equal(app.releases.filter(release => release.tag_name === preview.tag).length, 1)
})

test('incomplete higher public releases never get promoted during reconciliation', async() => {
  const state = initial()
  const first = registerPush(state, event('master', 'a', '0', true))
  const second = registerPush(state, event('master', 'b', 'a'))
  publishManifest(state, releaseManifest(first))
  const app = githubFixture(state)
  app.addRelease(releaseManifest(first))
  const damaged = app.addRelease(releaseManifest(second))
  damaged.assets = damaged.assets.filter(asset => !asset.name.endsWith('-x86.apk'))
  await assert.rejects(loadRelease(releaseManifest(first)).promote(app.github, releaseManifest(first), 'test', undefined, () => false), /incomplete asset/)
  assert.equal(app.channel('stable').tag, first.tag)
  assert.equal(app.latest, undefined)
})

test('rehydrating real update manifests restores the branch cursor before new and historical runs register', async() => {
  const state = initial()
  const first = registerPush(state, event('master', 'a', '0', true))
  const app = githubFixture(state)
  app.addRelease(releaseManifest(first))
  const recovered = await seedState(app.github, config, { version: '1.9.2', name: 'lx-music-mobile' }, () => ({ versionCode: first.versionCode, applicationId: config.applicationId, certificateSha256: fingerprint }))
  assert.equal(recovered.branches.master, first.sourceSha)
  const github = { readState: async() => ({ state: recovered }), list: async() => assert.fail('Restored branches must not depend on old workflow-run ordering') }
  registerPush(recovered, await pushContext(github, { ref: 'refs/heads/master', before: sha('0'), after: first.sourceSha }, { GITHUB_EVENT_NAME: 'push' }))
  const successor = await pushContext(github, { ref: 'refs/heads/master', before: first.sourceSha, after: sha('b') }, { GITHUB_EVENT_NAME: 'push' })
  assert.equal(registerPush(recovered, successor).version, '1.9.4')
})

test('an APK certificate mismatch blocks draft creation, uploads and publication', async() => {
  const state = initial()
  const record = registerPush(state, event('master', 'a', '0', true))
  const info = releaseManifest(record)
  info.signingCertificateSha256 = 'b'.repeat(64)
  const app = githubFixture(state)
  await assert.rejects(loadRelease(info).publish(app.github, record, () => false), /pinned release signing certificate/)
  assert.equal(app.releases.length, 0)
  assert.equal(app.calls.filter(call => call.upload).length, 0)
})

test('metadata reconstruction never republishes an unsafe historical preview channel', async() => {
  const state = initial()
  const stable = registerPush(state, event('master', 'b', '0', true))
  const preview = registerPush(state, event('Next', 'a', '0', true))
  const app = githubFixture(state)
  app.addRelease(releaseManifest(stable))
  app.addRelease(releaseManifest(preview))
  const restored = await seedState(app.github, config, { version: '1.9.2', name: 'lx-music-mobile' }, () => ({ versionCode: preview.versionCode, applicationId: config.applicationId, certificateSha256: fingerprint }), () => true)
  assert.equal(restored.channels.next, null)
  assert.equal(restored.channels.stable.tag, stable.tag)
  assert.equal(restored.builds[`Next/${preview.sourceSha}`].supersededBy, stable.tag)
  assert.equal(restored.branches.Next, preview.sourceSha)
})

for (const [target, expected] of [['2.0.0', '2.0.0-next.3'], ['auto', '1.9.3-next.3']]) {
  test(`manual dispatch target ${target} repairs a legacy pending event using the complete reserve command`, async() => {
    const state = initial()
    registerPush(state, event('Next', 'a', '0', true))
    registerPush(state, event('Next', 'b', 'a'))
    state.events[`Next/${sha('c')}`] = { ...event('Next', 'c', 'b'), targetVersion: '2.0' }
    const app = githubFixture(state)
    const request = app.github.request
    app.github.request = async(method, route, options) => route.startsWith('/compare/') ? { status: 'ahead' } : request(method, route, options)
    const context = releaseManifest({ version: expected, versionCode: 100003, sourceSha: sha('c') })
    const pipeline = loadRelease(context, { config: { ...config, targetVersion: '2.0' } })
    pipeline.files.set('event.json', Buffer.from(JSON.stringify({ inputs: { source_branch: 'Next', source_sha: sha('c'), before_sha: sha('b'), target_version: target } })))
    const reserved = await pipeline.reserve(app.github, { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_EVENT_PATH: '/fixture/event.json', GITHUB_OUTPUT: '/fixture/output.txt' }, () => false)
    assert.equal(reserved.version, expected)
    assert.equal(app.state.events[`Next/${sha('c')}`], undefined)
    assert.equal(JSON.parse(pipeline.files.get('record.json')).tag, `v${expected}`)
    assert.match(pipeline.files.get('output.txt').toString(), /reuse_public=false/)
  })
}
