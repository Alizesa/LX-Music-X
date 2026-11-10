const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const { userApiHarness, song, deferred, flush, message } = require('./helpers/user-api.cjs')
const { harness, constants } = require('./helpers/playback.cjs')

test('a request waiting for successful source initialization is not cancelled by its ready event', async() => {
  const h = await userApiHarness()
  h.api.setApiSourceOrder(['user_api_A'])
  await flush()
  const result = h.runtime.requestUserApiMusicUrl('user_api_A', song, '128k')
  h.initialize()
  assert.equal((await result).url, 'https://audio.test/user_api_A')
  assert.equal(h.timers.size, 0)
})

test('a delayed selection notification cannot cancel a request made by that selection', async() => {
  const h = await userApiHarness()
  h.api.setApiSourceOrder(['user_api_A'])
  await flush()
  h.global.state_event.apiSourceUpdated('user_api_A')
  h.initialize()
  const result = await h.runtime.requestUserApiMusicUrl('user_api_A', song, '128k')
  assert.equal(result.url, 'https://audio.test/user_api_A')
})

test('the last selected source wins even when the previous script read finishes later', async() => {
  const pending = deferred()
  const h = await userApiHarness({ scripts: { user_api_A: pending } })
  h.api.setApiSourceOrder(['user_api_A'])
  h.api.setApiSourceOrder(['user_api_B'])
  await flush()
  pending.resolve('A script')
  await flush()
  assert.deepEqual(h.loads.map(entry => entry.info.id), ['user_api_B'])
  h.initialize()
  assert.equal(await h.global.lx.apiInitPromise[0], true)
})

test('disabling the source invalidates a script read still in flight', async() => {
  const pending = deferred()
  const h = await userApiHarness({ scripts: { user_api_A: pending } })
  h.api.setApiSourceOrder(['user_api_A'])
  h.api.setApiSourceOrder([])
  pending.resolve('A script')
  await flush()
  assert.equal(h.loads.length, 0)
  assert.equal(h.setting['common.apiSource'], '')
})

for (const nextSource of ['user_api_B', 'user_api_A']) {
  test(`late native initialization cannot initialize a newer ${nextSource} runtime`, async() => {
    const h = await userApiHarness()
    h.api.setApiSource('user_api_A')
    await flush()
    const old = h.loads.at(-1)
    h.api.setApiSource(nextSource)
    await flush()
    const current = h.loads.at(-1)
    h.initialize(old, ['flac'])
    await flush()
    assert.equal(h.global.lx.apiInitPromise[1], false)
    assert.equal(h.state.status.message, 'initing')
    h.initialize(current)
    assert.equal(await h.global.lx.apiInitPromise[0], true)
    assert.deepEqual([...h.global.lx.qualityList.kw], ['128k'])
  })
}

test('changing the source cancels old HTTP work without forwarding its response to the new script', async() => {
  const h = await userApiHarness()
  h.api.setApiSource('user_api_A')
  await flush()
  h.initialize()
  const old = h.loads.at(-1)
  h.emit(old.runtimeId, 'request', { requestKey: 'old_http', url: 'https://audio.test/lookup', options: {} })
  h.api.setApiSource('user_api_B')
  await flush()
  assert.equal(h.http[0].aborted, true)
  assert.equal(h.sends.some(send => send.action === 'response' && send.data.requestKey === 'old_http'), false)
})

for (const selection of ['B', 'B-A', 'reload-A']) {
  test(`foreground playback restarts once after source selection ${selection}`, async() => {
    const player = await harness()
    const h = await userApiHarness({ appGlobal: player.globals, setting: player.setting, autoReply: false })
    h.api.setApiSourceOrder(['user_api_A'])
    await flush()
    h.initialize()
    await flush()
    player.music.getMusicUrl = async args => (await h.runtime.requestUserApiMusicUrl(h.setting['common.apiSource'], args.musicInfo, '128k', args.onCancel)).url
    await player.player.playList(constants.LIST_IDS.PLAY_QUEUE, 0)
    await player.advance(200)
    assert.equal(h.sends.filter(send => send.action === 'request').length, 1)
    if (selection === 'reload-A') h.api.setApiSource('user_api_A')
    else {
      h.api.setApiSourceOrder(['user_api_B'])
      if (selection === 'B-A') h.api.setApiSourceOrder(['user_api_A'])
    }
    await flush()
    h.initialize()
    await flush()
    const requests = h.sends.filter(send => send.action === 'request')
    assert.equal(requests.length, 2)
    const current = requests[1]
    h.emit(current.runtimeId, 'response', { status: true, requestKey: current.data.requestKey, result: { data: { url: 'https://audio.test/B' } } })
    await flush()
    assert.equal(player.nativeCalls.filter(call => call.action === 'play').length, 1)
    assert.equal(player.nativeTracks[0].url, 'https://audio.test/B')
  })
}

test('a waiter from an earlier initialization is cancelled even after selecting the same source again', async() => {
  const h = await userApiHarness()
  h.api.setApiSource('user_api_A')
  await flush()
  const result = h.runtime.requestUserApiMusicUrl('user_api_A', song, '128k')
  const cancelled = assert.rejects(result, error => error.message === message.requestMsg.cancelRequest)
  h.api.setApiSource('user_api_A')
  await flush()
  h.initialize()
  await cancelled
})

for (const termination of ['cancel', 'timeout']) {
  test(`primary initialization ${termination} only releases that request's waiter`, async() => {
    const h = await userApiHarness()
    h.api.setApiSource('user_api_A')
    await flush()
    const initialization = h.global.lx.apiInitPromise[0]
    let cancel
    const first = h.runtime.requestUserApiMusicUrl('user_api_A', { ...song, id: 'cancelled' }, '128k', fn => { cancel = fn })
    const timeout = [...h.timers.values()][0]
    const expected = termination === 'cancel' ? message.requestMsg.cancelRequest : 'Source request timeout'
    const rejected = assert.rejects(first, error => error.message === expected)
    const second = h.runtime.requestUserApiMusicUrl('user_api_A', { ...song, id: 'active' }, '128k')
    const destroyed = h.destroyed.length
    if (termination === 'cancel') cancel()
    else timeout()
    await rejected
    assert.equal(h.destroyed.length, destroyed)
    assert.equal(h.timers.size, 1)
    assert.equal(h.global.lx.apiInitPromise[0], initialization)
    assert.equal(h.global.lx.apiInitPromise[1], false)
    assert.equal(h.sends.length, 0)
    h.initialize()
    assert.equal((await second).url, 'https://audio.test/user_api_A')
    assert.equal(h.destroyed.length, destroyed)
    assert.equal(h.timers.size, 0)
    assert.deepEqual(h.sends.filter(entry => entry.action === 'request').map(entry => entry.data.data.info.musicInfo.id), ['active'])
  })
}

test('cancelled and timed-out primary initialization waiters release songs and errors before initialization settles', () => {
  const result = spawnSync(process.execPath, ['--expose-gc', '-e', `
    const assert = require('node:assert/strict')
    const { userApiHarness, song, flush, message } = require('./tests/helpers/user-api.cjs')
    ;(async() => {
      const h = await userApiHarness()
      h.api.setApiSource('user_api_A')
      await flush()
      const references = []
      const requestOne = async(index, termination) => {
        const music = { ...song, id: termination + index }
        references.push(new WeakRef(music))
        let cancel
        const request = h.runtime.requestUserApiMusicUrl('user_api_A', music, '128k', fn => { cancel = fn })
        const expected = termination === 'cancel' ? message.requestMsg.cancelRequest : 'Source request timeout'
        const rejected = assert.rejects(request, error => {
          references.push(new WeakRef(error))
          return error.message === expected
        })
        assert.equal(h.timers.size, 1)
        if (termination === 'cancel') cancel()
        else for (const timeout of [...h.timers.values()]) timeout()
        await rejected
      }
      for (const termination of ['cancel', 'timeout']) {
        for (let index = 0; index < 20; index++) await requestOne(index, termination)
      }
      assert.equal(h.timers.size, 0)
      assert.equal(h.global.lx.apiInitPromise[1], false)
      for (let attempt = 0; attempt < 8; attempt++) { await flush(); global.gc() }
      assert.equal(references.filter(ref => ref.deref() !== undefined).length, 0, 'disposed requests must not remain attached to shared initialization')
      h.initialize()
      await flush()
      assert.equal(h.sends.filter(entry => entry.action === 'request').length, 0)
    })().catch(error => { console.error(error); process.exitCode = 1 })
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 15000 })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
