const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createState, registerPush } = require('../publish/release-state.cjs')
const { githubFixture, releaseManifest, loadRelease } = require('./helpers/github.cjs')
const { deferred, flush } = require('./helpers/load.cjs')
const { GitHub } = require('../publish/github.cjs')

const setup = () => {
  let now = 1000000
  const startedAt = now
  let onDelay = async() => {}
  class ClockDate extends Date { static now() { return now } }
  const intervals = new Set()
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../publish/github.cjs'), 'utf8'), {
    module,
    require: name => name === 'node:timers/promises' ? { setTimeout: async ms => { await onDelay(ms); now += ms } } : require(name),
    Date: ClockDate,
    AbortController,
    AbortSignal,
    fetch: async() => assert.fail('No live GitHub requests'),
    setInterval: (callback, period) => { const timer = { callback, period, unref() {} }; intervals.add(timer); return timer },
    clearInterval: timer => intervals.delete(timer),
  })
  const state = createState('1.9.2', 100000)
  const first = registerPush(state, { branch: 'master', sha: 'a'.repeat(40), before: '0'.repeat(40), bootstrap: true })
  const second = registerPush(state, { branch: 'master', sha: 'b'.repeat(40), before: 'a'.repeat(40) })
  const oldManifest = releaseManifest(first); const newManifest = releaseManifest(second)
  const app = githubFixture(state)
  const oldRelease = app.addRelease(oldManifest)
  const old = app.github; const fresh = app.client()
  old.withLock = fresh.withLock = module.exports.GitHub.prototype.withLock
  return {
    app,
    old,
    fresh,
    oldRelease,
    oldManifest,
    newManifest,
    intervals,
    setElapsed: value => { now = startedAt + value },
    elapsed: () => now - startedAt,
    onDelay: callback => { onDelay = callback },
    oldPipeline: loadRelease(oldManifest, { clock: ClockDate }),
    newPipeline: loadRelease(newManifest, { clock: ClockDate }),
  }
}

test('slow renewal cannot send an obsolete Latest PATCH with only 20 seconds left on its lease', async() => {
  const h = setup(); const renewal = deferred(); const patch = deferred(); const ready = deferred()
  let stallNextWrite = false; let stalled = false
  const update = h.old.updateState.bind(h.old)
  h.old.updateState = async(...args) => {
    if (stallNextWrite) { stallNextWrite = false; await renewal.promise }
    return update(...args)
  }
  const promotion = h.old.withPromotionLock.bind(h.old)
  h.old.withPromotionLock = (owner, work) => promotion(owner, async lease => {
    let assertions = 0
    return work({
      ...lease,
      assertOwned: async() => {
        if (++assertions === 3 && !stalled) {
          stalled = true
          h.setElapsed(100000)
          stallNextWrite = true
          const timer = [...h.intervals][0]
          timer.callback()
          await flush()
          ready.resolve()
        }
        return lease.assertOwned()
      },
    })
  })
  let obsoletePatches = 0
  const request = h.old.request.bind(h.old)
  h.old.request = async(method, route, options) => {
    if (method === 'PATCH' && route === `/releases/${h.oldRelease.id}` && options?.json?.make_latest === 'true') {
      obsoletePatches++
      await patch.promise
    }
    return request(method, route, options)
  }
  const oldRun = h.oldPipeline.promote(h.old, h.oldManifest, 'old', undefined, () => false).catch(error => error)
  await ready.promise
  await flush()
  h.setElapsed(120001)
  h.app.addRelease(h.newManifest)
  await h.newPipeline.promote(h.fresh, h.newManifest, 'fresh', undefined, () => false)
  assert.equal(h.app.latest.tag_name, 'v1.9.4')
  h.setElapsed(125000)
  patch.resolve()
  renewal.resolve()
  await oldRun
  assert.equal(obsoletePatches, 0)
  assert.equal(h.app.latest.tag_name, 'v1.9.4')
  assert.equal(h.app.channel('stable').version, '1.9.4')
})

test('a transport that completes after lock loss is reconciled against the newest public release', async() => {
  const h = setup(); const patch = deferred(); const ready = deferred()
  const request = h.old.request.bind(h.old)
  let oldSignal
  let publicationActions = 0
  h.old.request = async(method, route, options) => {
    if (method === 'PATCH' && route === `/releases/${h.oldRelease.id}` && options?.json?.make_latest === 'true') {
      oldSignal = options.signal
      ready.resolve()
      // Deliberately ignore cancellation to exercise a late server-side effect.
      await patch.promise
    }
    return request(method, route, options)
  }
  const oldRun = h.oldPipeline.promote(h.old, h.oldManifest, 'old', async() => { publicationActions++ }, () => false).catch(error => error)
  await ready.promise
  h.setElapsed(120001)
  h.app.addRelease(h.newManifest)
  await h.newPipeline.promote(h.fresh, h.newManifest, 'fresh', undefined, () => false)
  assert.equal(h.app.latest.tag_name, 'v1.9.4')
  patch.resolve()
  await oldRun
  assert.equal(h.app.latest.tag_name, 'v1.9.4')
  assert.equal(h.app.channel('stable').version, '1.9.4')
  assert.equal(oldSignal.aborted, true)
  assert.equal(publicationActions, 1)
})

test('a lost lease cancellation reaches the actual GitHub fetch request', async() => {
  const controller = new AbortController()
  let received
  const github = new GitHub('owner/repository', 'fixture-token', 'release-meta', async(url, options) => {
    received = options.signal
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => { reject(new Error('transport cancelled')) }, { once: true })
    })
  })
  const request = github.request('PATCH', '/releases/1', { json: { make_latest: 'true' }, signal: controller.signal })
  const rejected = assert.rejects(request, /transport cancelled/)
  controller.abort()
  await rejected
  assert.equal(received.aborted, true)
})

test('takeover drains a PATCH sent by a legacy publisher before advancing Latest', async() => {
  const h = setup()
  await h.old.updateState(state => { state.promotionLock = { owner: 'legacy', expiresAt: 1000000 + 120000 } })
  h.setElapsed(120001)
  h.app.addRelease(h.newManifest)
  let delivered = false
  const oldPatch = async() => {
    delivered = true
    await h.old.request('PATCH', `/releases/${h.oldRelease.id}`, { json: { make_latest: 'true' } })
  }
  h.onDelay(async() => { if (!delivered) await oldPatch() })
  await h.newPipeline.promote(h.fresh, h.newManifest, 'fresh', undefined, () => false)
  if (!delivered) await oldPatch()
  assert.equal(h.app.latest.tag_name, 'v1.9.4')
  assert.equal(h.app.channel('stable').version, '1.9.4')
  assert.equal(h.elapsed(), 155001)
})
