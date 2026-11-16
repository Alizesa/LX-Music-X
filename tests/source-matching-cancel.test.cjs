const assert = require('node:assert/strict')
const { test } = require('node:test')
const { spawnSync } = require('node:child_process')
const { harness, song, flush } = require('./helpers/source-matching.cjs')

const observed = promise => {
  const result = { settled: false }
  result.promise = promise.then(value => { Object.assign(result, { settled: true, value }) }, error => { Object.assign(result, { settled: true, error }) })
  return result
}

test('last matching consumer cancellation aborts all four real SDK HTTP requests and suppresses late parse/retry', async() => {
  const h = harness()
  const controller = new AbortController()
  const result = observed(h.api.getOtherSource(song(), false, controller.signal))
  await flush()
  assert.equal(h.calls.length, 4)
  controller.abort()
  await flush()
  assert.equal(result.settled, true)
  assert.match(result.error.message, /取消http请求/)
  assert.equal(h.cancelled(), 4)
  h.calls.forEach(call => call.pending.resolve({ code: -1, error_code: 999 }))
  await flush()
  assert.equal(h.calls.length, 4)
  assert.equal(h.parsed(), 0)
  assert.equal(h.converted(), 0)
  assert.equal(h.timers.size, 0)
})

test('one matching consumer cancellation preserves the shared lookup for another consumer', async() => {
  const h = harness()
  const controller = new AbortController()
  const first = observed(h.api.getOtherSource(song(), false, controller.signal))
  const second = observed(h.api.getOtherSource(song()))
  await flush()
  assert.equal(h.calls.length, 4)
  controller.abort()
  await flush()
  assert.equal(first.settled, true)
  assert.equal(h.cancelled(), 0)
  assert.equal(second.settled, false)
  h.finish()
  await second.promise
  assert.deepEqual([...second.value], [])
  assert.equal(h.calls.length, 4)
  assert.equal(await h.api.getOtherSource(song()), second.value)
})

test('matching timeout ends actual network activity and a later caller starts a fresh lookup', async() => {
  const h = harness()
  const result = observed(h.api.getOtherSource(song()))
  await flush()
  h.clock.fire(12000)
  await flush()
  assert.equal(result.settled, true)
  assert.match(result.error.message, /timeout/)
  assert.equal(h.cancelled(), 4)
  const fresh = observed(h.api.getOtherSource(song()))
  await flush()
  assert.equal(h.calls.length, 8)
  h.finish(4)
  await fresh.promise
  assert.equal(fresh.error, undefined)
  h.calls.slice(0, 4).forEach(call => call.pending.resolve({ code: -1 }))
  await flush()
  assert.equal(h.timers.size, 0)
})

test('clearing matching cache preserves active consumers without allowing obsolete cache refill', async() => {
  const h = harness()
  const result = observed(h.api.getOtherSource(song()))
  await flush()
  h.api.clearOtherSourceCache()
  assert.equal(h.cancelled(), 0)
  h.finish()
  await result.promise
  assert.equal(result.error, undefined)
  const fresh = observed(h.api.getOtherSource(song()))
  await flush()
  assert.equal(h.calls.length, 8)
  h.finish(4)
  await fresh.promise
})

test('an already-cancelled matching consumer starts no HTTP request', async() => {
  const h = harness()
  const controller = new AbortController()
  controller.abort()
  const result = observed(h.api.getOtherSource(song(), false, controller.signal))
  await flush()
  assert.equal(result.settled, true)
  assert.match(result.error.message, /取消http请求/)
  assert.equal(h.calls.length, 0)
})

test('a caller reentering from native HTTP abort starts fresh matching instead of reusing an aborted job', async() => {
  const h = harness()
  const controller = new AbortController()
  const first = observed(h.api.getOtherSource(song(), false, controller.signal))
  await flush()
  let fresh
  h.calls[0].options.signal.addEventListener('abort', () => {
    fresh = observed(h.api.getOtherSource(song()))
  }, { once: true })
  controller.abort()
  await first.promise
  await flush()
  assert.equal(h.calls.length, 8)
  assert.equal(h.cancelled(), 4)
  h.finish(4)
  await fresh.promise
  assert.equal(fresh.error, undefined)
  assert.deepEqual([...fresh.value], [])
  assert.ok([...h.timers.values()].every(timer => timer.delay !== 12000))
  h.calls.slice(0, 4).forEach(call => call.pending.resolve({ code: -1 }))
  await flush()
  assert.equal(h.timers.size, 0)
})

test('V8 releases cancelled matching input while the original HTTP promises stay pending', () => {
  const result = spawnSync(process.execPath, ['--expose-gc', '-e', `
    const assert = require('node:assert/strict')
    const { harness, song, flush } = require('./tests/helpers/source-matching.cjs')
    ;(async() => {
      const h = harness()
      const controller = new AbortController()
      let music = { ...song(), payload: new Array(5000).fill('business data') }
      const ref = new WeakRef(music)
      const control = { payload: new Array(5000).fill('still owned') }
      const controlRef = new WeakRef(control)
      const pending = h.api.getOtherSource(music, false, controller.signal).catch(error => error)
      music = null
      await flush()
      controller.abort()
      await pending
      global.keepPendingHTTP = { h, controller, control }
      for (let i = 0; i < 12; i++) { await flush(); global.gc() }
      assert.equal(h.calls.length, 4)
      assert.equal(h.cancelled(), 4)
      assert.equal(controlRef.deref() !== undefined, true)
      assert.equal(ref.deref() === undefined, true, 'cancelled matching must release its caller payload')
    })().catch(error => { console.error(error); process.exitCode = 1 })
  `], { cwd: process.cwd(), encoding: 'utf8', timeout: 20000 })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})

for (const source of ['kw', 'local']) {
  for (const kind of ['url', 'pic', 'lyric']) {
    test(`${source}/${kind} cancellation stops the real SDK lookup after entering alternate-source matching`, async() => {
      const h = harness()
      const controller = new AbortController()
      const musicInfo = { ...song(source), meta: { ...song().meta, filePath: '/missing/song.mp3' } }
      let cancel
      const args = { musicInfo, isRefresh: true, allowToggleSource: true, onToggleSource() {}, signal: controller.signal, onCancel: fn => { cancel = fn } }
      const promise = source === 'local'
        ? h.local[kind === 'url' ? 'getMusicUrl' : kind === 'pic' ? 'getPicUrl' : 'getLyricInfo'](args)
        : kind === 'url' ? h.api.handleGetOnlineMusicUrl(args) : kind === 'pic' ? h.api.handleGetOnlinePicUrl(args) : h.api.handleGetOnlineLyricInfo(args)
      const result = observed(promise)
      await flush()
      const expected = source === 'local' ? 5 : 4
      assert.equal(h.calls.length, expected)
      if (kind === 'url') cancel()
      else controller.abort()
      await flush()
      assert.equal(result.settled, true)
      assert.match(result.error.message, /取消http请求/)
      assert.equal(h.cancelled(), expected)
      h.calls.forEach(call => call.pending.resolve({ code: -1 }))
      await flush()
      assert.equal(h.calls.length, expected)
      assert.equal(h.parsed(), 0)
    })
  }
}

test('cancelling matching during QQ retry backoff prevents the next real HTTP request', async() => {
  const h = harness()
  const controller = new AbortController()
  const result = observed(h.api.getOtherSource(song(), false, controller.signal))
  await flush()
  const tx = h.calls.find(call => call.source === 'tx')
  tx.pending.resolve({ code: -999, 'music.search.SearchCgiService': { code: -999 } })
  for (const call of h.calls.filter(call => call.source !== 'tx')) call.pending.resolve(require('./helpers/source-matching.cjs').bodies[call.source])
  await flush()
  assert.ok([...h.timers.values()].some(timer => timer.delay === 500))
  controller.abort()
  await result.promise
  h.clock.fire(500)
  await flush()
  assert.equal(h.calls.length, 4)
  assert.equal(h.timers.size, 0)
  assert.equal(h.providers.tx.default.musicSearch.requestSignal, undefined)
})

test('local URL cancellation remains linked when matching retries another file-name interpretation after URL failure', async() => {
  const h = harness()
  const findMusic = h.sdk.findMusic
  let matched = false
  h.sdk.findMusic = async(...args) => {
    if (!matched) {
      matched = true
      return [song('kw')]
    }
    return findMusic(...args)
  }
  let cancel
  const musicInfo = { ...song('local'), name: 'Song - Singer', meta: { ...song().meta, filePath: '/missing/Song - Singer.mp3' } }
  const result = observed(h.local.getMusicUrl({ musicInfo, isRefresh: true, onCancel: handle => { cancel = handle } }))
  await flush()
  assert.equal(h.calls.length, 5)
  cancel()
  await flush()
  assert.equal(result.settled, true)
  assert.match(result.error.message, /取消http请求/)
  assert.equal(h.cancelled(), 5)
  h.calls.forEach(call => call.pending.resolve({ code: -1 }))
  await flush()
  assert.equal(h.calls.length, 5)
})
