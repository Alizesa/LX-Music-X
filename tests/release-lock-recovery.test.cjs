const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createState } = require('../publish/release-state.cjs')

// Execute the actual lock implementation with a virtual clock. No real waits,
// Actions requests, or publication side effects are needed for crash recovery.
const lockClient = () => {
  let now = 1000000
  const intervals = new Map()
  const advance = async ms => {
    const target = now + ms
    while (true) {
      const next = [...intervals.values()].filter(timer => timer.next <= target).sort((a, b) => a.next - b.next)[0]
      if (!next) break
      now = next.next
      next.next += next.period
      next.callback()
      await new Promise(resolve => setImmediate(resolve))
    }
    now = target
    await new Promise(resolve => setImmediate(resolve))
  }
  class VirtualDate extends Date { static now() { return now } }
  const loaded = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../publish/github.cjs'), 'utf8'), {
    module: loaded,
    require: dependency => dependency === 'node:timers/promises' ? { setTimeout: advance } : require(dependency),
    Date: VirtualDate,
    fetch: async() => { assert.fail('Unexpected live GitHub request') },
    setInterval: (callback, period) => {
      const timer = { callback, period, next: now + period, unref() {} }
      intervals.set(timer, timer)
      return timer
    },
    clearInterval: timer => intervals.delete(timer),
  }, { filename: 'publish/github.cjs' })
  const github = new loaded.exports.GitHub('owner/repository', 'test-token', 'release-meta')
  const state = createState('1.9.2', 100000)
  github.updateState = async change => ({ result: change(state), state })
  github.readState = async() => ({ state })
  return { github, state, advance, now: () => now, intervals, leaseMs: loaded.exports.PUBLICATION_LEASE_MS }
}

for (const [key, oldLease] of [['releaseLock:v1.9.3', 3600000], ['promotionLock', 900000]]) {
  test(`a cancelled Actions attempt releases a legacy ${key} immediately for the rerun`, async() => {
    const app = lockClient()
    const started = app.now()
    app.state[key] = { owner: '123/1/cancelled-worker', expiresAt: started + oldLease }
    const requests = []
    app.github.request = async(method, route) => { requests.push(route); return { status: 'completed', conclusion: 'cancelled', run_attempt: 1 } }
    let worked = false
    await app.github.withLock(key, '123/2/rerun-worker', app.leaseMs, async lease => {
      worked = true
      await lease.assertOwned()
      assert.equal(app.state[key].owner, '123/2/rerun-worker')
    })
    assert.equal(worked, true)
    assert.equal(app.now() - started, 0)
    assert.deepEqual(requests, ['/actions/runs/123/attempts/1'])
    assert.equal(app.state[key], undefined)
  })
}

for (const key of ['releaseLock:v1.9.3', 'promotionLock']) {
  test(`an offline owner of ${key} expires within the new worker's acquisition deadline`, async() => {
    const app = lockClient()
    const started = app.now()
    app.state[key] = { owner: 'offline-worker', expiresAt: started + app.leaseMs }
    const work = async lease => { await lease.assertOwned(); return 'recovered' }
    const result = key === 'promotionLock'
      ? await app.github.withPromotionLock('new-worker', work)
      : await app.github.withLock(key, 'new-worker', app.leaseMs, work)
    assert.equal(result, 'recovered')
    assert.equal(app.now() - started, 120000)
    assert.ok(app.now() - started < 180000)
    assert.equal(app.state[key], undefined)
  })
}

test('a healthy publication lease renews throughout work lasting longer than its initial lease', async() => {
  const app = lockClient()
  await app.github.withPromotionLock('123/1/live-worker', async lease => {
    await app.advance(3 * app.leaseMs)
    await lease.assertOwned()
    assert.equal(app.state.promotionLock.owner, '123/1/live-worker')
    assert.ok(app.state.promotionLock.expiresAt > app.now())
  })
  assert.equal(app.state.promotionLock, undefined)
  assert.equal(app.intervals.size, 0)
})

test('an active Actions attempt is not reclaimed even if a rerun waits until its deadline', async() => {
  const app = lockClient()
  const started = app.now()
  app.state.promotionLock = { owner: '123/1/live-worker', expiresAt: started + 900000 }
  let worked = false
  let requests = 0
  app.github.request = async() => { requests++; return { status: 'in_progress' } }
  await assert.rejects(app.github.withPromotionLock('123/2/new-worker', async() => { worked = true }), /Another release owns/)
  assert.equal(worked, false)
  assert.equal(app.state.promotionLock.owner, '123/1/live-worker')
  assert.equal(app.now() - started, 180000)
  assert.ok(requests <= 12)
})

test('run lookup failures and missing attempts do not authorize early lock reclamation', async() => {
  for (const reply of [null, new Error('GitHub unavailable')]) {
    const app = lockClient()
    const started = app.now()
    app.state.promotionLock = { owner: '123/1/offline-worker', expiresAt: started + app.leaseMs }
    app.github.request = async() => { if (reply instanceof Error) throw reply; return reply }
    await app.github.withPromotionLock('456/1/new-worker', async lease => { await lease.assertOwned() })
    assert.equal(app.now() - started, 120000)
  }
})

test('a completed-owner lookup cannot evict a different worker that acquired the lock meanwhile', async() => {
  const app = lockClient()
  app.state.promotionLock = { owner: '123/1/cancelled-worker', expiresAt: app.now() + 900000 }
  app.github.request = async(method, route) => {
    if (route === '/actions/runs/123/attempts/1') {
      app.state.promotionLock = { owner: '456/1/live-worker', expiresAt: app.now() + 900000 }
      return { status: 'completed' }
    }
    return { status: 'in_progress' }
  }
  await assert.rejects(app.github.withPromotionLock('789/1/new-worker', async() => { assert.fail('The healthy new owner must keep its lock') }), /Another release owns/)
  assert.equal(app.state.promotionLock.owner, '456/1/live-worker')
})
