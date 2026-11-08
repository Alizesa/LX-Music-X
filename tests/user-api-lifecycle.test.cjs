const { test } = require('node:test')
const assert = require('node:assert/strict')
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
