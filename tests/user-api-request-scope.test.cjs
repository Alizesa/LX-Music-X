const assert = require('node:assert/strict')
const { test } = require('node:test')
const { scopeHarness } = require('./helpers/user-api-scope.cjs')

const initialized = 'lx.send(lx.EVENT_NAMES.inited, { sources: { kw: { type: \'music\', actions: [\'musicUrl\'], qualitys: [\'128k\'] } } })'
const fetch = 'const get = url => new Promise((resolve, reject) => lx.request(url, {}, (error, response, body) => error ? reject(error) : resolve(body)))'

test('normal asynchronous primary requests reuse initialization and serially dispatch their own HTTP', async() => {
  const h = await scopeHarness(`${fetch}; lx.on('request', async ({info}) => { await get('https://audio.test/' + info.musicInfo.id); return 'https://audio.test/' + info.musicInfo.id }); ${initialized}`)
  const first = h.start('A'); const second = h.start('B')
  await h.pump()
  assert.equal(h.http.length, 1)
  assert.equal(h.sends.filter(send => send.action === 'request').length, 1)
  await h.respond(0)
  assert.equal((await first).url, 'https://audio.test/A')
  assert.equal(h.http.length, 2)
  await h.respond(1)
  assert.equal((await second).url, 'https://audio.test/B')
  assert.equal(h.loads.length, 1)
  assert.equal(h.destroyed.filter(id => id !== 'main').length, 0)
  assert.equal(h.events.filter(event => event.action === 'init').length, 1)
})

test('a response arriving before the settled acknowledgement cannot dispatch the next handler', async() => {
  const h = await scopeHarness(`${fetch}; lx.on('request', async ({info}) => { await get('https://audio.test/' + info.musicInfo.id); return 'https://audio.test/' + info.musicInfo.id }); ${initialized}`)
  const first = h.start('A'); const second = h.start('B')
  await h.pump(); h.holdSettled(); await h.respond(0)
  assert.equal((await first).url, 'https://audio.test/A')
  assert.equal(h.http.length, 1)
  assert.equal(h.sends.filter(send => send.action === 'request').length, 1)
  await h.releaseSettled()
  assert.equal(h.http.length, 2)
  await h.respond(1)
  assert.equal((await second).url, 'https://audio.test/B')
})

test('cancelling an async handler cancels its HTTP, clears its timers and prevents a retry without canceling the queued consumer', async() => {
  const h = await scopeHarness(`${fetch}; lx.on('request', async ({info}) => {
    if (info.musicInfo.id === 'A') {
      setTimeout(() => lx.request('https://audio.test/timer', {}, () => {}), 10000)
      try { await get('https://audio.test/A') } catch { await get('https://audio.test/late-retry') }
    } else await get('https://audio.test/B')
    return 'https://audio.test/' + info.musicInfo.id
  }); ${initialized}`)
  let cancel
  const first = h.start('A', handle => { cancel = handle })
  const rejected = assert.rejects(first, /取消http请求/)
  const second = h.start('B')
  await h.pump()
  assert.equal(h.scriptTimers.size, 1)
  const oldNative = h.http[0]
  oldNative.abort = () => { oldNative.aborted = true }
  cancel(); await rejected; await h.pump()
  assert.equal(oldNative.aborted, true)
  assert.equal(h.scriptTimers.size, 0)
  assert.equal(h.http.length, 2)
  assert.equal(h.events.some(event => event.action === 'request' && /late-retry|timer/.test(event.data.url)), false)
  await h.respond(1)
  assert.equal((await second).url, 'https://audio.test/B')
  assert.equal(h.loads.length, 1, 'a handler that settles after cancellation needs no new initialization')
})

test('cancelling a queued request leaves the active handler and its HTTP untouched', async() => {
  const h = await scopeHarness(`${fetch}; lx.on('request', async ({info}) => { await get('https://audio.test/' + info.musicInfo.id); return 'https://audio.test/' + info.musicInfo.id }); ${initialized}`)
  const first = h.start('A')
  let cancel
  const queued = h.start('B', handle => { cancel = handle })
  const rejected = assert.rejects(queued, /取消http请求/)
  await h.pump(); cancel(); await rejected; await h.pump()
  assert.equal(h.http.length, 1)
  assert.equal(h.http[0].aborted, false)
  await h.respond(0)
  assert.equal((await first).url, 'https://audio.test/A')
  assert.equal(h.loads.length, 1)
  assert.equal(h.sends.filter(send => send.action === 'request').length, 1)
})

test('an async handler suspended on a cleared timer cannot block queued requests after context recovery', async() => {
  const h = await scopeHarness(`${fetch}; lx.on('request', async ({info}) => {
    if (info.musicInfo.id === 'A') await new Promise(resolve => setTimeout(resolve, 10000))
    else await get('https://audio.test/B')
    return 'https://audio.test/' + info.musicInfo.id
  }); ${initialized}`)
  let cancel
  const first = h.start('A', handle => { cancel = handle })
  const rejected = assert.rejects(first, /取消http请求/)
  const second = h.start('B')
  await h.pump()
  const old = h.loads[0]
  const generation = h.bridge.getScriptGeneration()
  cancel(); await rejected; await h.pump()
  assert.equal(h.scriptTimers.size, 0)
  assert.equal(h.http.length, 0)
  await h.recover()
  assert.equal(h.bridge.getScriptGeneration(), generation)
  assert.equal(h.loads.length, 2)
  assert.notEqual(h.loads[1].runtimeId, old.runtimeId)
  assert.equal(h.destroyed.includes(old.runtimeId), true)
  const current = h.sends.filter(send => send.action === 'request').at(-1)
  h.emit(old.runtimeId, 'request', { requestKey: 'stale', parentRequestKey: current.data.requestKey, url: 'https://audio.test/stale', options: {} })
  assert.equal(h.http.length, 1, 'the old native context cannot impersonate the current owner')
  await h.respond(0)
  assert.equal((await second).url, 'https://audio.test/B')
})

test('canceling an active request that settles leaves unrelated initialization HTTP available', async() => {
  const h = await scopeHarness(`${fetch}; get('https://audio.test/background').catch(() => {}); lx.on('request', async ({info}) => {
    await get('https://audio.test/' + info.musicInfo.id)
    return 'https://audio.test/' + info.musicInfo.id
  }); ${initialized}`)
  let cancel
  const first = h.start('A', handle => { cancel = handle })
  const rejected = assert.rejects(first, /取消http请求/)
  const second = h.start('B')
  await h.pump()
  assert.equal(h.http.length, 2)
  cancel(); await rejected; await h.pump()
  assert.equal(h.http[0].aborted, false)
  assert.equal(h.http[1].aborted, true)
  assert.equal(h.http.length, 3)
  await h.respond(2)
  assert.equal((await second).url, 'https://audio.test/B')
  assert.equal(h.loads.length, 1)
  await h.respond(0)
})

test('a stuck canceled handler reinitializes once and keeps the queued consumer waiting for readiness', async() => {
  const h = await scopeHarness(`${fetch}; lx.on('request', async ({info}) => {
    if (info.musicInfo.id === 'A') await new Promise(resolve => setTimeout(resolve, 10000))
    else await get('https://audio.test/B')
    return 'https://audio.test/' + info.musicInfo.id
  }); get('https://audio.test/startup').then(() => { ${initialized} })`)
  await h.respond(0)
  let cancel
  const first = h.start('A', handle => { cancel = handle })
  const rejected = assert.rejects(first, /取消http请求/)
  const second = h.start('B')
  await h.pump(); cancel(); await rejected; await h.pump(); await h.recover()
  assert.equal(h.loads.length, 2)
  assert.equal(h.http.length, 2, 'only the recovery initialization HTTP has started')
  assert.equal(h.sends.filter(send => send.action === 'request').length, 1)
  await h.respond(1)
  assert.equal(h.http.length, 3)
  await h.respond(2)
  assert.equal((await second).url, 'https://audio.test/B')
  assert.equal(h.events.filter(event => event.action === 'request' && event.data.url.endsWith('/startup')).length, 2)
})

test('an explicit source change cancels both active and queued requests from the previous selection', async() => {
  const h = await scopeHarness(`${fetch}; lx.on('request', async ({info}) => { await get('https://audio.test/' + info.musicInfo.id); return 'https://audio.test/' + info.musicInfo.id }); ${initialized}`)
  const first = h.start('A'); const second = h.start('B')
  const rejected = Promise.all([assert.rejects(first, /取消http请求/), assert.rejects(second, /取消http请求/)])
  await h.pump()
  const generation = h.bridge.getScriptGeneration()
  h.api.setApiSource('user_api_B')
  await rejected; await h.pump()
  assert.notEqual(h.bridge.getScriptGeneration(), generation)
  assert.equal(h.http[0].aborted, true)
  assert.equal(h.sends.filter(send => send.action === 'request').length, 1)
})
