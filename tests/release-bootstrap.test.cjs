const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createApkInspector } = require('../publish/android-tools.cjs')
const { createState, registerPush } = require('../publish/release-state.cjs')
const { pushContext } = require('../publish/release.cjs')
const { githubFixture, releaseManifest, loadRelease } = require('./helpers/github.cjs')

const sha = value => value.repeat(40)
const event = (branch, value, before, bootstrap = false) => ({ branch, sha: sha(value), before: sha(before), bootstrap })
const run = (branch, value, number, status, conclusion) => ({ event: 'push', head_branch: branch, head_sha: sha(value), run_number: number, status, conclusion })
const context = (state, runs, value = 'b', before = 'a', branch = 'Next') => pushContext({
  readState: async() => ({ state }), list: async() => runs,
}, { ref: `refs/heads/${branch}`, before: sha(before), after: sha(value) }, { GITHUB_EVENT_NAME: 'push' })

for (const branch of ['Next', 'master']) {
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'startup_failure']) {
    test(`${branch} can initialize after an unregistered first run ended with ${conclusion}`, async() => {
      const state = createState('1.9.2', 100000)
      const next = await context(null, [run(branch, 'a', 1, 'completed', conclusion), run(branch, 'b', 2, 'in_progress')], 'b', 'a', branch)
      assert.equal(next.bootstrap, true)
      const record = registerPush(state, next)
      assert.equal(record.versionCode, 100001)
      assert.equal(state.builds[`${branch}/${sha('a')}`], undefined)
      assert.deepEqual(state.initializationSkipped[branch], [sha('a')])
      assert.equal(registerPush(state, event(branch, 'b', 'a')), record)
      assert.throws(() => registerPush(state, event(branch, 'a', '0')), /failed before version initialization/)
      assert.equal(registerPush(state, event(branch, 'c', 'b')).versionCode, 100002)
    })
  }
}

for (const [status, conclusion] of [['queued', undefined], ['in_progress', undefined], ['completed', 'success'], ['completed', undefined]]) {
  test(`bootstrap does not skip an unregistered ${status}/${conclusion ?? 'unknown'} predecessor`, async() => {
    const state = createState('1.9.2', 100000)
    const later = await context(null, [run('Next', 'a', 1, status, conclusion), run('Next', 'b', 2, 'in_progress')])
    assert.equal(later.bootstrap, false)
    assert.equal(registerPush(state, later), null)
    registerPush(state, event('Next', 'a', '0', true))
    assert.equal(state.builds[`Next/${sha('a')}`].versionCode, 100001)
    assert.equal(state.builds[`Next/${sha('b')}`].versionCode, 100002)
    assert.equal(state.initializationSkipped, undefined)
  })
}

test('a failed but recorded first run is allocated before its successor without restarting its worker', async() => {
  const state = createState('1.9.2', 100000)
  registerPush(state, event('Next', 'a', '0'))
  const next = await context(state, [run('Next', 'a', 1, 'completed', 'failure'), run('Next', 'b', 2, 'in_progress')])
  assert.equal(next.bootstrapBefore, sha('0'))
  registerPush(state, next)
  assert.equal(state.builds[`Next/${sha('a')}`].versionCode, 100001)
  assert.equal(state.builds[`Next/${sha('b')}`].versionCode, 100002)
  assert.equal(state.initializationSkipped, undefined)
})

test('bootstrap preserves waiting receipts after an earlier scan failed before registering', async() => {
  const state = createState('1.9.2', 100000)
  registerPush(state, event('Next', 'b', 'a'))
  const next = await context(state, [run('Next', 'a', 1, 'completed', 'failure'), run('Next', 'b', 2, 'completed', 'failure'), run('Next', 'c', 3, 'in_progress')], 'c', 'b')
  registerPush(state, next)
  assert.deepEqual(state.initializationSkipped.Next, [sha('a')])
  assert.equal(state.builds[`Next/${sha('b')}`].versionCode, 100001)
  assert.equal(state.builds[`Next/${sha('c')}`].versionCode, 100002)
})

test('a receipt that arrives after the bootstrap snapshot is preserved rather than skipped', async() => {
  const state = createState('1.9.2', 100000)
  const next = await context(null, [run('Next', 'a', 1, 'completed', 'failure'), run('Next', 'b', 2, 'in_progress')])
  registerPush(state, event('Next', 'a', '0'))
  registerPush(state, next)
  assert.equal(state.initializationSkipped, undefined)
  assert.equal(state.builds[`Next/${sha('a')}`].versionCode, 100001)
  assert.equal(state.builds[`Next/${sha('b')}`].versionCode, 100002)
})

test('a previously failed run can retry as the initializer before a later source establishes the branch', async() => {
  const state = createState('1.9.2', 100000)
  const first = await context(null, [run('Next', 'a', 1, 'completed', 'failure')], 'a', '0')
  assert.equal(registerPush(state, first).versionCode, 100001)
  assert.equal(state.initializationSkipped, undefined)
})

test('an already initialized branch does not skip failed missing pushes', async() => {
  const state = createState('1.9.2', 100000)
  registerPush(state, event('Next', 'a', '0', true))
  const next = await context(state, [run('Next', 'b', 2, 'completed', 'failure'), run('Next', 'c', 3, 'in_progress')], 'c', 'b')
  assert.equal(next.bootstrap, false)
  assert.equal(registerPush(state, next), null)
  registerPush(state, event('Next', 'b', 'a'))
  assert.equal(state.builds[`Next/${sha('c')}`].versionCode, 100003)
})

test('a waiting reserve refreshes bootstrap after the previous initializer fails, with bounded polling', async() => {
  const app = githubFixture(createState('1.9.2', 100000))
  let now = 0; let runQueries = 0
  class Clock extends Date { static now() { return now } }
  const pipeline = loadRelease(releaseManifest({ version: '1.9.3-next.1', versionCode: 100001, sourceSha: sha('b') }), {
    clock: Clock, delay: async ms => { now += ms },
  })
  pipeline.files.set('event.json', Buffer.from(JSON.stringify({ ref: 'refs/heads/Next', before: sha('a'), after: sha('b') })))
  const request = app.github.request
  app.github.request = async(method, route, options) => {
    if (route.startsWith('/actions/workflows/')) {
      runQueries++
      return { workflow_runs: [run('Next', 'a', 1, now >= 10000 ? 'completed' : 'in_progress', now >= 10000 ? 'failure' : undefined), run('Next', 'b', 2, 'in_progress')] }
    }
    return request(method, route, options)
  }
  const record = await pipeline.reserve(app.github, { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: '/fixture/event.json' }, () => false)
  assert.equal(record.versionCode, 100001)
  assert.equal(record.sourceSha, sha('b'))
  assert.equal(now, 30000)
  assert.ok(runQueries <= 3)
  assert.deepEqual(app.state.initializationSkipped.Next, [sha('a')])
})

test('a signer-parser failure leaves no reservation and the fixed next push initializes from real SDK output', async() => {
  const app = githubFixture(null)
  const legacy = releaseManifest({ version: '1.9.2', versionCode: 79003, sourceSha: sha('0') })
  legacy.tag = '20261111.r260-Next'
  app.addRelease(legacy)
  const source = require('./fixtures/apksigner/source.json')
  const output = fs.readFileSync(path.join(__dirname, 'fixtures/apksigner/build-tools-37.txt'), 'utf8')
  const fixedInspector = createApkInspector({
    env: { ANDROID_HOME: '/sdk' },
    readFile: () => 'buildToolsVersion = "37.0.0"\n',
    exists: () => true,
    execute: (command, args) => args[0] === 'dump' ? `package: name='${source.applicationId}' versionCode='79003' versionName='1.9.2'` : output,
  })
  const attempt = async(value, before, failed) => {
    const pipeline = loadRelease(releaseManifest({ version: '1.9.3-next.1', versionCode: 100001, sourceSha: sha(value) }), {
      apkInspector: failed ? () => { throw new Error('APK must have exactly one verified signing certificate') } : fixedInspector,
    })
    pipeline.files.set('package.json', Buffer.from(JSON.stringify({ name: 'lx-music-mobile', version: '1.9.2', versionCode: 79 })))
    pipeline.files.set('event.json', Buffer.from(JSON.stringify({ ref: 'refs/heads/Next', before: sha(before), after: sha(value) })))
    const github = app.client()
    const request = github.request
    github.request = async(method, route, options) => route.startsWith('/actions/workflows/')
      ? { workflow_runs: failed ? [run('Next', 'a', 1, 'in_progress')] : [run('Next', 'a', 1, 'completed', 'failure'), run('Next', 'b', 2, 'in_progress')] }
      : request(method, route, options)
    github.downloadAsset = async(asset, file) => { pipeline.files.set(path.basename(file), Buffer.from('historical APK metadata fixture')) }
    return pipeline.reserve(github, { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: '/fixture/event.json' }, () => false)
  }
  await assert.rejects(attempt('a', '0', true), /exactly one verified signing certificate/)
  assert.equal(app.state, null)
  const recovered = await attempt('b', 'a', false)
  assert.equal(recovered.version, '1.9.3-next.1')
  assert.equal(recovered.versionCode, 100001)
  assert.equal(app.state.signingCertificateSha256, source.certificateSha256)
  assert.deepEqual(app.state.initializationSkipped.Next, [sha('a')])
})
