const assert = require('node:assert/strict')
const { test } = require('node:test')
const { scopeHarness } = require('./helpers/user-api-scope.cjs')
const { flush } = require('./helpers/load.cjs')
const { song } = require('./helpers/user-api.cjs')

const initialized = "lx.send(lx.EVENT_NAMES.inited, { sources: { kw: { type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } } })"
const script = "const get = url => new Promise((resolve, reject) => lx.request(url, {}, (error, response, body) => error ? reject(error) : resolve(body))); lx.on('request', async ({info}) => { await get('https://audio.test/' + info.musicInfo.id); return 'https://audio.test/' + info.musicInfo.id }); " + initialized
const clock = () => {
  let now = 0; let next = 0
  const timers = new Map()
  return {
    timers,
    setTimeout(fn, delay) { const id = ++next; timers.set(id, { fn, at: now + delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    async advance(delay, pump) {
      const end = now + delay
      while (timers.size) {
        const [id, timer] = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0] ?? []
        if (!timer) break
        now = timer.at; timers.delete(id); timer.fn(); await pump()
      }
      now = end
      await pump()
    },
  }
}

test('five healthy eight-second primary requests retain a full execution deadline after waiting in the queue', async() => {
  const time = clock(); const h = await scopeHarness(script, { clock: time }); const outcomes = []
  const requests = Array.from({ length: 5 }, (_, id) => h.start(String(id)).then(value => { outcomes.push(value); return value }, error => { outcomes.push(error); return error }))
  await h.pump()
  for (let index = 0; index < 5; index++) {
    await time.advance(8000, h.pump)
    assert.ok(h.http[index], 'the request must have reached the provider')
    assert.equal(h.http[index].aborted, false)
    await h.respond(index)
  }
  await Promise.all(requests)
  assert.deepEqual(outcomes.map(value => value.url), Array.from({ length: 5 }, (_, id) => 'https://audio.test/' + id))
  assert.equal(time.timers.size, 0)
})
test('a queued primary request times out twelve seconds after its own dispatch and cancels its HTTP', async() => {
  const time = clock(); const h = await scopeHarness(script, { clock: time })
  const first = h.start('first'); const second = h.start('second'); let finished = false
  const rejected = assert.rejects(second, /Source request timeout/).then(() => { finished = true })
  await h.pump(); await time.advance(8000, h.pump); await h.respond(0); await first
  await time.advance(11999, h.pump)
  assert.equal(finished, false)
  assert.equal(h.http[1].aborted, false)
  await time.advance(1, h.pump); await rejected
  assert.equal(h.http[1].aborted, true)
  assert.equal(time.timers.size, 0)
})

test('direct primary API callers start the twenty-second timeout when dispatched', async() => {
  const time = clock(); const h = await scopeHarness(script, { clock: time })
  const api = h.global.lx.apis.kw
  const first = api.getMusicUrl({ ...song, id: 'first' }, '128k')
  const second = api.getMusicUrl({ ...song, id: 'second' }, '128k')
  let finished = false
  const rejected = assert.rejects(second.promise, /request timeout/).then(() => { finished = true })
  await h.pump(); await time.advance(15000, h.pump); await h.respond(0); await first.promise
  await time.advance(19999, h.pump)
  assert.equal(finished, false)
  assert.equal(h.http[1].aborted, false)
  await time.advance(1, h.pump); await rejected
  assert.equal(h.http[1].aborted, true)
})

test('a queued request remains cancellable without executing provider work', async() => {
  const time = clock(); const h = await scopeHarness(script, { clock: time }); let cancel
  const first = h.start('first')
  const second = h.start('second', callback => { cancel = callback })
  const rejected = assert.rejects(second, /取消http请求/)
  await h.pump(); await time.advance(8000, h.pump); cancel(); await rejected; await h.respond(0); await first
  assert.equal(h.http.length, 1)
  assert.equal(time.timers.size, 0)
})

test('a stalled recovery initialization fails queued callers instead of leaving them without a deadline', async() => {
  const time = clock()
  const h = await scopeHarness("lx.on('request', () => new Promise(() => {})); " + initialized, { clock: time })
  const first = h.start('first'); const second = h.start('second')
  const outcomes = Promise.all([first.catch(error => error), second.catch(error => error)])
  await h.pump()
  const stopBeforeRecovery = async() => { await flush() }
  await time.advance(12100, stopBeforeRecovery)
  assert.equal(h.loads.length, 2)
  await time.advance(12000, stopBeforeRecovery)
  const errors = await outcomes
  assert.match(errors[0].message, /timeout/)
  assert.match(errors[1].message, /timeout/)
  assert.equal(time.timers.size, 0)
  await h.pump()
})


test('switching sources during recovery clears the old initialization deadline', async() => {
  const time = clock()
  const h = await scopeHarness("lx.on('request', () => new Promise(() => {})); " + initialized, { clock: time })
  const first = h.start('first'); const second = h.start('second')
  const timedOut = assert.rejects(first, /Source request timeout/)
  const cancelled = assert.rejects(second, /\u53d6\u6d88http\u8bf7\u6c42/)
  await h.pump(); await time.advance(12100, async() => { await flush() }); await timedOut
  h.api.setApiSource('user_api_B')
  await cancelled; await h.pump(); await time.advance(12000, h.pump)
  assert.equal(h.state.status.status, true)
  assert.ok(h.global.lx.apis.kw)
  assert.equal(time.timers.size, 0)
})

test('a delayed selection notification preserves the same generation recovery deadline', async() => {
  const time = clock()
  const h = await scopeHarness("lx.on('request', () => new Promise(() => {})); " + initialized, { clock: time })
  const first = h.start('first'); const second = h.start('second')
  const timedOut = assert.rejects(first, /Source request timeout/)
  let failure
  const pending = second.catch(error => { failure = error })
  const stopBeforeRecovery = async() => { await flush() }
  await h.pump(); await time.advance(12100, stopBeforeRecovery); await timedOut
  h.global.state_event.apiSourceUpdated('user_api_A')
  await flush()
  await time.advance(12000, stopBeforeRecovery)
  assert.match(failure?.message ?? '', /Source recovery timeout/)
  await pending
  assert.equal(time.timers.size, 0)
})
