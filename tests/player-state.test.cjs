const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load, deferred, flush } = require('./helpers/load.cjs')

const options = { volume: 0.8, playRate: 1, cacheSize: 1024, isHandleAudioFocus: true, isEnableAudioOffload: false }
const initHarness = () => {
  const status = { isIniting: false, isInitialized: false }
  const calls = []
  const native = {
    setupPlayer: async() => { calls.push('setup') },
    destroy: async() => { calls.push('destroy') },
  }
  const utils = {
    migratePlayerCache: async() => { calls.push('migrate') },
    updateOptions: async() => { calls.push('options') },
    setVolume: async() => { calls.push('volume') },
    setPlaybackRate: async() => { calls.push('rate') },
  }
  const api = load('src/plugins/player/index.ts', { 'react-native-track-player': { default: native }, './utils': utils }, {
    global: { lx: { playerStatus: status } },
  })
  return { api, native, utils, status, calls }
}

for (const stage of ['migratePlayerCache', 'setupPlayer', 'setVolume']) {
  test(`player initialization can retry after ${stage} fails`, async() => {
    const h = initHarness()
    const target = stage === 'setupPlayer' ? h.native : h.utils
    const original = target[stage]
    target[stage] = async() => { throw new Error('unavailable') }
    await assert.rejects(h.api.initial(options), /unavailable/)
    assert.equal(h.status.isIniting, false)
    assert.equal(h.api.isInitialized(), false)
    target[stage] = original
    await h.api.initial(options)
    assert.equal(h.api.isInitialized(), true)
    assert.equal(h.status.isIniting, false)
  })
}

test('concurrent callers wait for one fully configured player', async() => {
  const h = initHarness()
  const setup = deferred(), configure = deferred()
  h.native.setupPlayer = async() => { h.calls.push('setup'); await setup.promise }
  h.utils.updateOptions = async() => configure.promise
  let finished = 0
  const first = h.api.initial(options).then(() => { finished++ })
  const second = h.api.initial(options).then(() => { finished++ })
  await flush()
  assert.equal(h.calls.filter(call => call === 'setup').length, 1)
  setup.resolve()
  await flush()
  assert.equal(finished, 0)
  assert.equal(h.api.isInitialized(), false)
  configure.resolve()
  await Promise.all([first, second])
  assert.equal(finished, 2)
  assert.equal(h.api.isInitialized(), true)
})

const song = id => ({ id, name: id, singer: 'Artist', source: 'tx', meta: { picUrl: `${id}-cover` } })
const restoreHarness = () => {
  const pic = deferred(), lyric = deferred()
  const songs = [song('A'), song('B')]
  const state = { playInfo: { playerListId: 'queue', playerPlayIndex: 0 }, playMusicInfo: {}, progress: {}, musicInfo: {} }
  const timers = [], events = []
  const appGlobal = { lx: { restorePlayInfo: { time: 23, maxTime: 180 }, isPlayedStop: false }, app_event: {
    setProgress: (...values) => events.push(values), picUpdated() {}, lyricUpdated() {}, pause() {},
  } }
  const api = load('src/core/player/player.ts', {
    '@/plugins/player': { isInitialized: () => true, initTrackInfo: async() => {}, setStop: async() => {} },
    '@/core/player/playStatus': { setStatusText: value => events.push(value) },
    '@/store/player/state': { default: state },
    '@/store/setting/state': { default: { setting: { 'player.isSavePlayTime': true } } },
    '@/core/player/playInfo': {
      setPlayListId: id => { state.playInfo.playerListId = id },
      setPlayMusicInfo: (listId, musicInfo, isTempPlay) => {
        state.playMusicInfo = { listId, musicInfo, isTempPlay }
        state.musicInfo = { id: musicInfo.id, pic: musicInfo.meta.picUrl, lrc: `${musicInfo.id}-current` }
      },
      setMusicInfo: value => { Object.assign(state.musicInfo, value) },
    },
    '@/core/player/playedList': {}, '@/core/player/tempPlayList': { clearTempPlayeList() {} },
    '@/core/music': { getPicPath: () => pic.promise, getLyricInfo: () => lyric.promise },
    '@/utils/message': {}, '@/utils/common': {}, './utils': {}, 'react-native-background-timer': { default: {} },
    '@/utils/tools': { debounceBackgroundTimer: () => Object.assign(() => {}, { cancel() {} }) }, '@/config/constant': { LIST_IDS: { PLAY_QUEUE: 'queue' } },
    '@/core/qqMusicFavorite': {}, '@/core/dislikeList': {}, './playQueue': { getPlayQueue: () => songs.map(musicInfo => ({ musicInfo })) },
    '@/core/qqMusicRecommendSession': {}, '@/core/localList': {}, './preload': {}, '@/core/music/sourcePriority': {},
  }, { global: appGlobal, setTimeout: fn => { timers.push(fn); return timers.length } })
  return { api, state, pic, lyric, timers, events }
}

for (const returnToFirst of [false, true]) {
  test(`restored metadata cannot overwrite a later ${returnToFirst ? 'same-song' : 'different-song'} playback`, async() => {
    const h = restoreHarness()
    await h.api.playList('queue', 0)
    await h.api.playList('queue', 1)
    if (returnToFirst) await h.api.playList('queue', 0)
    const current = { ...h.state.musicInfo }
    h.pic.resolve('stale-cover')
    h.lyric.resolve({ lyric: 'stale-lyric', rawlrcInfo: { lyric: 'stale-raw' } })
    h.timers.forEach(fn => fn())
    await flush()
    assert.deepEqual(h.state.musicInfo, current)
    assert.equal(h.events.length, 0)
  })
}

test('metadata and playback position still restore for the current song', async() => {
  const h = restoreHarness()
  await h.api.playList('queue', 0)
  h.pic.resolve('restored-cover')
  h.lyric.resolve({ lyric: 'restored-lyric', rawlrcInfo: { lyric: 'raw' } })
  h.timers.forEach(fn => fn())
  await flush()
  assert.equal(h.state.musicInfo.pic, 'restored-cover')
  assert.equal(h.state.musicInfo.lrc, 'restored-lyric')
  assert.deepEqual(h.events, [[23, 180]])
})

const filter = load('src/core/player/utils.ts', {
  './playedList': {}, '@/config/constant': { SPLIT_CHAR: { DISLIKE_NAME: '::', DISLIKE_NAME_ALIAS: '__' } }, '@/store/dislikeList': {},
}).filterMusicList
const dislikeInfo = () => ({ names: new Set(), musicNames: new Set(), singerNames: new Set() })
test('played-song filtering preserves list ownership, temporary tracks and duplicate handling', () => {
  const result = filter({
    listId: 'queue', list: [song('A'), song('B'), song('C'), song('C')], isNext: true, dislikeInfo: dislikeInfo(),
    playedList: [
      { listId: 'other', musicInfo: song('A') },
      { listId: 'queue', isTempPlay: true, musicInfo: song('B') },
      { listId: 'queue', musicInfo: song('C') },
    ],
  })
  assert.deepEqual(Array.from(result.filteredList, item => item.id), ['A', 'B', 'C'])
})

test('large random queues read played IDs only once instead of scanning them per song', () => {
  let reads = 0
  const playedList = Array.from({ length: 2000 }, (_, i) => ({ listId: 'queue', musicInfo: { get id() { reads++; return String(i) } } }))
  const list = [...Array.from({ length: 2000 }, (_, i) => song(String(i + 2000))), ...Array.from({ length: 2000 }, (_, i) => song(String(i)))]
  const result = filter({ playedList, listId: 'queue', list, isNext: true, dislikeInfo: dislikeInfo() })
  assert.equal(result.filteredList.length, 2000)
  assert.ok(reads <= 4000, `Unexpected quadratic work: ${reads} played-ID reads`)
})

const sessionHarness = () => {
  let stored = { songs: [song('old')], index: 0, savedAt: Date.now() }
  const data = {
    getQQMusicRecommendSession: async() => stored,
    saveQQMusicRecommendSession: async value => { stored = value },
    removeQQMusicRecommendSession: async() => { stored = null },
  }
  const api = load('src/core/qqMusicRecommendSession.ts', {
    '@/core/player/playQueue': { isPlayQueueFromList: () => true, getPlayQueueMusic: () => [song('new')], getPlayQueueSourceFirstMusicId: () => 'new', getPlayQueueSourceBatchKey: () => undefined },
    '@/store/player/state': { default: { playInfo: { playerPlayIndex: 0 } } }, '@/utils/data': data, '@/config/constant': {},
  })
  return { api, data, stored: () => stored }
}

test('clearing a recommendation snapshot invalidates an already running read', async() => {
  const h = sessionHarness(), gate = deferred()
  const old = h.stored()
  h.data.getQQMusicRecommendSession = async() => { await gate.promise; return old }
  const reading = h.api.getRecommendSession()
  await flush()
  await h.api.dropRecommendSession()
  gate.resolve()
  assert.equal(await reading, null)
  assert.equal(await h.api.getRecommendSession(), null)
})

test('clearing waits for an earlier snapshot write before removing it', async() => {
  const h = sessionHarness(), gate = deferred()
  const save = h.data.saveQQMusicRecommendSession
  h.data.saveQQMusicRecommendSession = async value => { await gate.promise; await save(value) }
  const parking = h.api.parkRecommendQueue()
  await flush()
  const clearing = h.api.dropRecommendSession()
  gate.resolve()
  await Promise.all([parking, clearing])
  assert.equal(h.stored(), null)
  assert.equal(await h.api.getRecommendSession(), null)
})

test('a newer parked queue survives an earlier snapshot deletion', async() => {
  const h = sessionHarness(), gate = deferred()
  const remove = h.data.removeQQMusicRecommendSession
  h.data.removeQQMusicRecommendSession = async() => { await gate.promise; await remove() }
  const clearing = h.api.dropRecommendSession()
  const parking = h.api.parkRecommendQueue()
  gate.resolve()
  await Promise.all([clearing, parking])
  assert.equal(h.stored().songs[0].id, 'new')
  assert.equal((await h.api.getRecommendSession()).songs[0].id, 'new')
})
