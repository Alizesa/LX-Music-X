const { test } = require('node:test')
const { harness, song, load, deferred, flush, constants, assert } = require('./helpers/playback.cjs')

const QUEUE = constants.LIST_IDS.PLAY_QUEUE
const start = async(h, index = 0) => { await h.player.playList(QUEUE, index); await h.advance(200) }
const finishUrl = async(h, index = h.sourceRequests.length - 1) => {
  const request = h.sourceRequests[index]
  request.gate.resolve(`https://audio.test/${request.musicInfo.id}`)
  await flush()
}
const plays = h => h.nativeCalls.filter(call => call.action === 'play')
const addErrorHandling = h => load('src/core/init/player/playerEvent.ts', {
  '@/core/player/player': h.player, '@/core/player/playStatus': h.status, '@/plugins/player': h.plugin,
  '@/utils/tools': { isActive: () => true }, 'react-native-background-timer': { default: h.clock },
  '@/store/player/state': { default: h.state }, '@/core/player/progress': h.progress,
  '@/store/setting/state': { default: { setting: h.setting } }, '@/core/player/playHistory': {},
  '@/utils/apiSourceOrder': load('src/utils/apiSourceOrder.ts'),
}, { global: h.globals, setTimeout: h.clock.setTimeout }).default()

test('invalid list selections leave the current URL request playable', async() => {
  const h = await harness()
  await start(h)
  await h.player.playList(QUEUE, -1)
  await h.player.playList(QUEUE, 1000)
  await h.player.playList('missing', 0)
  await finishUrl(h)
  assert.equal(h.sourceRequests.length, 1)
  assert.deepEqual(plays(h).map(call => call.id), ['A'])
  assert.equal(h.globals.lx.gettingUrlId, '')
})

for (const index of [1, 0]) {
  test(`a stale native query cannot start an earlier ${index ? 'different-song' : 'same-song'} playback`, async() => {
    const query = deferred()
    let queries = 0
    const h = await harness({ beforeCurrent: () => ++queries === 1 ? query.promise : Promise.resolve() })
    await start(h)
    await finishUrl(h)
    await h.player.playList(QUEUE, index)
    query.resolve()
    await flush()
    assert.equal(plays(h).length, 0)
    await h.advance(200)
    await finishUrl(h)
    await h.advance(800)
    assert.deepEqual(plays(h).map(call => [call.id, call.selected]), [[h.lists.library[index].id, h.lists.library[index].id]])
  })
}

test('pausing an unresolved URL keeps the resolved track paused and resume reuses it', async() => {
  const h = await harness()
  await start(h)
  await h.player.pause()
  await finishUrl(h)
  assert.equal(plays(h).length, 0)
  h.player.play()
  await flush()
  assert.equal(plays(h).length, 1)
  assert.equal(h.sourceRequests.length, 1)
})

test('resume during URL resolution reuses the pending request', async() => {
  const h = await harness()
  await start(h)
  await h.player.pause()
  h.player.play()
  await finishUrl(h)
  assert.equal(h.sourceRequests.length, 1)
  assert.equal(plays(h).length, 1)
})

test('pause during native loading prevents its later play call', async() => {
  const query = deferred()
  const h = await harness({ beforeCurrent: () => query.promise })
  await start(h)
  await finishUrl(h)
  await h.player.pause()
  query.resolve()
  await flush()
  assert.equal(plays(h).length, 0)
})

test('resume during native queue cleanup starts the prepared track without another URL request', async() => {
  const h = await harness()
  await start(h)
  await finishUrl(h)
  const removed = deferred()
  const remove = h.native.remove
  h.native.remove = async indices => { await removed.promise; await remove(indices) }
  await start(h, 1)
  await h.player.pause()
  await finishUrl(h)
  await h.advance(800)
  h.player.play()
  removed.resolve()
  await flush()
  assert.deepEqual(plays(h).map(call => call.id), ['A', 'B'])
  assert.equal(h.sourceRequests.length, 2)
})

test('stop invalidates native work already awaiting a result', async() => {
  const query = deferred()
  const h = await harness({ beforeCurrent: () => query.promise })
  await start(h)
  await finishUrl(h)
  await h.player.stop()
  query.resolve()
  await h.advance(1000)
  assert.equal(plays(h).length, 0)
})

test('resuming after stop cannot be stopped by its delayed notification', async() => {
  const h = await harness()
  await start(h)
  await h.player.stop()
  h.player.play()
  await flush()
  assert.equal(h.sourceRequests.length, 2)
  await finishUrl(h)
  await h.advance(1)
  assert.equal(h.state.isPlay, true)
  assert.equal(plays(h).length, 1)
})

test('an old error position cannot seek the next song or an explicit replay', async() => {
  for (const index of [1, 0]) {
    const position = deferred()
    const h = await harness({ getPosition: () => position.promise })
    addErrorHandling(h)
    await start(h)
    await finishUrl(h)
    h.globals.app_event.playerError()
    await flush()
    await h.player.playList(QUEUE, index)
    position.resolve(120)
    await flush()
    assert.equal(h.state.progress.nowPlayTime, 0)
    await h.advance(200)
    await finishUrl(h)
    await h.advance(800)
    assert.equal(h.nativeCalls.some(call => call.action === 'seek' && call.time === 120), false)
  }
})

test('initial buffering has a 25 second deadline and repeated notifications do not extend it', async() => {
  const h = await harness()
  addErrorHandling(h)
  h.native.play = async() => { h.emitNative('PlaybackState', { state: 'Connecting' }); h.emitNative('PlaybackState', { state: 'Buffering' }) }
  await start(h)
  await finishUrl(h)
  await h.advance(20000)
  h.emitNative('PlaybackState', { state: 'Buffering' })
  await flush()
  await h.advance(5000)
  assert.equal(h.sourceRequests.length, 2)
  assert.equal(h.sourceRequests[1].isRefresh, true)
})

test('pausing buffered playback stops its recovery timer', async() => {
  const h = await harness()
  addErrorHandling(h)
  h.native.play = async() => { h.emitNative('PlaybackState', { state: 'Buffering' }) }
  await start(h)
  await finishUrl(h)
  await h.advance(10000)
  await h.player.pause()
  await h.advance(30000)
  assert.equal(h.sourceRequests.length, 1)
})

test('deleting a previous queue row updates selection before its storage write finishes', async() => {
  const h = await harness()
  await start(h, 1)
  const saved = deferred()
  h.io.savePlayQueue = () => saved.promise
  const removing = h.player.removeQueueMusic(0)
  await flush()
  assert.equal(h.state.playInfo.playerPlayIndex, 0)
  await h.player.playNext()
  assert.equal(h.state.playMusicInfo.musicInfo.id, 'C')
  saved.resolve()
  await removing
  assert.equal(h.state.playInfo.playerPlayIndex, 1)
})

test('moving a queue row updates the current index before saving and cannot overwrite a newer selection', async() => {
  const h = await harness()
  await start(h, 1)
  const saved = deferred()
  h.io.savePlayQueue = () => saved.promise
  const moving = h.player.moveQueueMusic(0, 2)
  await flush()
  assert.equal(h.state.playInfo.playerPlayIndex, 0)
  await h.player.playNext()
  assert.equal(h.state.playMusicInfo.musicInfo.id, 'C')
  saved.resolve()
  await moving
  assert.equal(h.state.playInfo.playerPlayIndex, 1)
})

test('removing the current queue row changes track without waiting for storage', async() => {
  const h = await harness()
  await start(h, 1)
  const saved = deferred()
  h.io.savePlayQueue = () => saved.promise
  const removing = h.player.removeQueueMusic(1)
  await flush()
  assert.equal(h.state.playMusicInfo.musicInfo.id, 'C')
  await h.player.playList(QUEUE, 0)
  saved.resolve()
  await removing
  assert.equal(h.state.playMusicInfo.musicInfo.id, 'A')
})

test('removing the queue anchor during temporary playback resumes at its successor', async() => {
  const h = await harness()
  await start(h)
  h.info.setPlayMusicInfo('library', song('temporary'), true)
  await h.player.removeQueueMusic(0)
  assert.equal(h.state.playMusicInfo.musicInfo.id, 'temporary')
  await h.player.playNext()
  assert.equal(h.state.playMusicInfo.musicInfo.id, 'B')
})
