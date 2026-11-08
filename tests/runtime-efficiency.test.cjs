const assert = require('node:assert/strict')
const { test } = require('node:test')
const { EventEmitter } = require('node:events')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const { load, deferred, flush } = require('./helpers/load.cjs')
const { hookHost, jsx, elements } = require('./helpers/react.cjs')

const scheduled = load('src/utils/scheduledTask.ts')
const clock = () => {
  let id = 0
  const tasks = new Map()
  return {
    tasks,
    setTimeout(fn, delay) { const key = id++; tasks.set(key, { fn, delay }); return key },
    clearTimeout(id) { tasks.delete(id) },
    fire() { const [id, task] = tasks.entries().next().value; tasks.delete(id); task.fn() },
  }
}

for (const restart of [false, true]) {
  test(`${restart ? 'debouncing' : 'throttling'} keeps only the latest call and supports cancellation and reentry`, () => {
    const timers = clock(), calls = []
    const run = scheduled.createScheduledTask(value => { calls.push(value); if (value === 'latest') run('next') }, 100, restart, timers)
    run('first')
    run('latest')
    assert.equal(timers.tasks.size, 1)
    timers.fire()
    assert.deepEqual(calls, ['latest'])
    assert.equal(timers.tasks.size, 1)
    timers.fire()
    assert.deepEqual(calls, ['latest', 'next'])
    run('cancelled')
    run.cancel()
    assert.equal(timers.tasks.size, 0)
    run('after cancel')
    timers.fire()
    assert.deepEqual(calls, ['latest', 'next', 'after cancel'])
  })
}

test('long-lived scheduled callbacks do not retain completed or cancelled payloads', () => {
  const result = spawnSync(process.execPath, ['--expose-gc', '-e', `
    const { load } = require('./tests/helpers/load.cjs')
    const { createScheduledTask } = load('src/utils/scheduledTask.ts')
    const liveCallbacks = [], references = []
    for (const restart of [false, true]) for (const cancel of [false, true]) {
      let callback
      const task = createScheduledTask(() => {}, 10, restart, {
        setTimeout(fn) { callback = fn; return 0 }, clearTimeout() { callback = null },
      })
      let payload = { songs: new Array(10000).fill('song') }
      references.push(new WeakRef(payload))
      task(payload)
      payload = null
      if (cancel) task.cancel()
      else { callback(); callback = null }
      liveCallbacks.push(task)
    }
    setImmediate(() => {
      global.gc()
      if (liveCallbacks.length !== 4 || references.some(ref => ref.deref() !== undefined)) process.exitCode = 1
    })
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 15000 })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})

const song = (id = 'one') => ({ id, source: 'tx', name: id, singer: 'Artist', interval: '04:00', meta: { albumName: 'Album' } })

test('all playback UI subscriptions stop while hidden and restore fresh mutable-store snapshots', () => {
  const host = hookHost(), frame = host.frame(), events = new EventEmitter()
  const state = { musicInfo: { name: 'old' }, playMusicInfo: { musicInfo: song() }, playInfo: { playIndex: 0 },
    statusText: 'old', isPlay: false, progress: { nowPlayTime: 0 } }
  const hooks = load('src/store/player/hook.ts', {
    react: host.react, './state': { default: state }, '@/utils/tools': { isActive: () => true },
    '@/utils/hooks/useScreenVisible': { useScreenVisible: host.visible },
  }, { global: { state_event: events } })
  const render = () => host.render(frame, () => ({
    music: hooks.usePlayerMusicInfo(), playback: hooks.usePlayMusicInfo(), info: hooks.usePlayInfo(),
    status: hooks.useStatusText(), playing: hooks.useIsPlay(), progress: hooks.useProgress(),
  }))
  render()
  const names = ['playerMusicInfoChanged', 'playMusicInfoChanged', 'playInfoChanged', 'playStateTextChanged', 'playStateChanged', 'playProgressChanged']
  assert.ok(names.every(name => events.listenerCount(name) === 1))
  state.progress.nowPlayTime = 10
  events.emit('playProgressChanged', { ...state.progress })
  assert.equal(render().progress.nowPlayTime, 10)
  frame.visible = false
  render()
  assert.ok(names.every(name => events.listenerCount(name) === 0))
  for (let i = 0; i < 200; i++) names.forEach(name => events.emit(name))
  assert.equal(frame.dirty, false)
  state.musicInfo.name = 'new'
  state.playInfo.playIndex = 8
  state.statusText = 'new'
  state.isPlay = true
  state.progress.nowPlayTime = 80
  frame.visible = true
  const current = render()
  assert.equal(current.music.name, 'new')
  assert.equal(current.info.playIndex, 8)
  assert.equal(current.progress.nowPlayTime, 80)
  assert.equal(current.playing, true)
  assert.equal(current.status, 'new')
  host.unmount(frame)
  assert.ok(names.every(name => events.listenerCount(name) === 0))
})

const historyScreen = (read) => {
  const host = hookHost(), frame = host.frame(), events = new EventEmitter()
  const component = load('src/screens/PlayHistory/index.tsx', {
    react: host.react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { FlatList: 'FlatList', View: 'View', TouchableOpacity: 'TouchableOpacity' },
    '@/components/PageContent': {}, '@/components/common/StatusBar': {}, '@/components/SimpleHeader': {},
    '@/components/player/PlayerBar': {}, '@/components/common/Text': {}, '@/components/common/Image': {},
    '@/core/common': { setComponentId() {} }, '@/config/constant': { COMPONENT_IDS: {} }, '@/core/player/tempPlayList': {},
    '@/utils/data': { getPlayHistory: read }, '@/store/theme/hook': { useTheme: () => ({}) },
    '@/lang': { useI18n: () => key => key }, '@/utils/tools': { createStyle: value => value },
    '@/utils/hooks/useScreenVisible': { useScreenVisible: host.visible },
    '@/utils/hooks/useListScrollRestore': { useListScrollRestore: () => ({}) },
  }, { global: { app_event: events } }).default
  return { frame, events, render: () => elements(host.render(frame, () => component({ componentId: 'history' })), 'FlatList')[0].props,
    unmount: () => host.unmount(frame) }
}

test('history screens release hidden rows and a slow initial read cannot overwrite an update', async() => {
  const gate = deferred(), old = [{ musicInfo: song('old'), playedAt: 1 }], latest = [{ musicInfo: song('new'), playedAt: 2 }]
  let reads = 0
  const h = historyScreen(async() => ++reads === 1 ? gate.promise : latest)
  h.render()
  h.events.emit('playHistoryUpdate', latest)
  gate.resolve(old)
  await flush()
  assert.equal(h.render().data, latest)
  h.frame.visible = false
  assert.equal(h.render().data.length, 0)
  assert.equal(h.events.listenerCount('playHistoryUpdate'), 0)
  h.events.emit('playHistoryUpdate', old)
  assert.equal(h.frame.dirty, false)
  h.frame.visible = true
  h.render()
  await flush()
  assert.equal(h.render().data, latest)
  h.unmount()
  assert.equal(h.events.listenerCount('playHistoryUpdate'), 0)
})

test('a late history read cannot restore rows after the screen hides', async() => {
  const gate = deferred(), h = historyScreen(() => gate.promise)
  h.render()
  h.frame.visible = false
  h.render()
  gate.resolve([{ musicInfo: song(), playedAt: 1 }])
  await flush()
  assert.equal(h.render().data.length, 0)
  h.unmount()
})

test('two hundred buffering/resume events save history once, and replaying the song saves again', async() => {
  const events = new EventEmitter(), timers = clock(), writes = []
  events.playHistoryUpdate = history => events.emit('playHistoryUpdate', history)
  const setting = { 'player.isSavePlayHistory': true, 'player.playHistoryMaxCount': 300 }
  const state = { musicInfo: { id: 'one' }, playMusicInfo: { musicInfo: song() } }
  let history = []
  const storage = load('src/core/player/playHistory.ts', {
    '@/utils/data': { getPlayHistory: async() => history, savePlayHistory: async value => { history = value; writes.push(value) } },
    '@/store/setting/state': { default: { setting } },
  }, { global: { app_event: events } })
  load('src/core/init/player/playerEvent.ts', {
    '@/core/player/player': {}, '@/core/player/playStatus': { setStatusText() {} }, '@/plugins/player': {},
    '@/utils/tools': {}, 'react-native-background-timer': { default: timers },
    '@/store/player/state': { default: state }, '@/core/player/progress': {},
    '@/store/setting/state': { default: { setting } }, '@/core/player/playHistory': storage, '@/utils/apiSourceOrder': {},
  }, { global: { app_event: events } }).default()
  for (let i = 0; i < 200; i++) events.emit('playerPlaying')
  await flush()
  assert.equal(writes.length, 1)
  // 应用事件是异步派发的：迟到的切歌通知不能重置当前播放的去重标记。
  events.emit('musicToggled')
  events.emit('playerPlaying')
  await flush()
  assert.equal(writes.length, 1)
  state.playMusicInfo = { musicInfo: song() }
  events.emit('musicToggled')
  events.emit('playerPlaying')
  await flush()
  assert.equal(writes.length, 2)
  assert.equal(history.length, 1)
})

test('concurrent history reads parse one snapshot and cannot overwrite a newer saved history', async() => {
  const timers = clock(), gate = deferred()
  let reads = 0
  const common = load('src/utils/common.ts', { './scheduledTask': scheduled }, { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout })
  const data = load('src/utils/data.ts', {
    '@/plugins/storage': { getData: async() => { reads++; return gate.promise }, saveData: async() => {} },
    '@/config/constant': { storageDataPrefix: {}, DEFAULT_SETTING: {}, LIST_IDS: {} },
    './legacyList': {}, './common': common, './nativeModules/secureStorage': {},
  })
  const first = data.getPlayHistory(), second = data.getPlayHistory()
  assert.equal(reads, 1)
  const latest = [{ musicInfo: song('latest'), playedAt: 2 }]
  await data.savePlayHistory(latest)
  gate.resolve([{ musicInfo: song('old'), playedAt: 1 }])
  assert.equal(await first, latest)
  assert.equal(await second, latest)
  assert.equal(await data.getPlayHistory(), latest)
  assert.equal(reads, 1)
})

test('background images share pending work and skip metadata-only updates and background tracks', async() => {
  const events = new EventEmitter(), changes = new EventEmitter(), requests = [], applied = []
  const app = { currentState: 'active', addEventListener: (event, fn) => changes.on(event, fn) }
  const state = { musicInfo: { pic: 'https://cover/a' }, loadErrorPicUrl: '' }
  const gates = new Map()
  await load('src/core/init/common.ts', {
    'react-native': { AppState: app }, '@/store/player/state': { default: state },
    '@/components/common/ImageBackground': { prefetch: url => { requests.push(url); const gate = deferred(); gates.set(url, gate); return gate.promise } },
    '@/core/common': { setBgPic: url => { applied.push(url) } },
  }, { global: { state_event: events } }).default({ 'theme.dynamicBg': true })
  for (let i = 0; i < 100; i++) events.emit('playerMusicInfoChanged')
  assert.equal(requests.length, 1)
  app.currentState = 'background'
  changes.emit('change', 'background')
  gates.get('https://cover/a').resolve(true)
  await flush()
  for (const pic of ['https://cover/b', 'https://cover/c']) { state.musicInfo.pic = pic; events.emit('playerMusicInfoChanged') }
  assert.equal(requests.length, 1)
  assert.equal(applied.length, 0)
  app.currentState = 'active'
  changes.emit('change', 'active')
  assert.deepEqual(requests, ['https://cover/a', 'https://cover/c'])
  gates.get('https://cover/c').resolve(true)
  await flush()
  for (let i = 0; i < 100; i++) events.emit('playerMusicInfoChanged')
  assert.equal(requests.length, 2)
  assert.deepEqual(applied, ['https://cover/c'])
  events.emit('configUpdated', ['theme.dynamicBg'], { 'theme.dynamicBg': false })
  events.emit('configUpdated', ['theme.dynamicBg'], { 'theme.dynamicBg': true })
  assert.equal(requests.length, 2)
  assert.deepEqual(applied.slice(-2), [null, 'https://cover/c'])
})

const sourceHarness = () => {
  const timers = clock(), requests = []
  let conversions = 0
  const api = load('src/core/music/utils.ts', {
    '@/utils/musicSdk': { findMusic: info => { const gate = deferred(); requests.push({ info, ...gate }); return gate.promise } },
    '@/utils/data': {}, '@/utils': { toNewMusicInfo: value => { conversions++; return value } },
    '@/store/setting/state': {}, '@/utils/message': {}, 'react-native-background-timer': { default: timers },
    '@/utils/musicSdk/api-source': {}, '@/core/qqMusicUrl': {}, '@/config/constant': {}, './sourcePriority': {},
  })
  return { api, timers, requests, conversions: () => conversions,
    resolve: async(music) => { const promise = api.getOtherSource(music); requests.at(-1).resolve([song('match')]); return promise } }
}

test('queue/history copies of the same song share matching requests and cached alternatives', async() => {
  const h = sourceHarness(), music = song()
  const first = h.api.getOtherSource(music)
  const second = h.api.getOtherSource({ ...music, meta: { ...music.meta } })
  assert.equal(h.requests.length, 1)
  h.requests[0].resolve([song('match')])
  assert.equal(await first, await second)
  assert.equal(await h.api.getOtherSource({ ...music }), await first)
  assert.equal(h.requests.length, 1)
  assert.equal(h.timers.tasks.size, 0)
  const fresh = h.api.getOtherSource(music, true)
  assert.equal(h.requests.length, 2)
  h.requests[1].resolve([song('fresh')])
  assert.equal((await fresh)[0].id, 'fresh')
})

test('alternative-song cache evicts only the least recently used entry and includes matching metadata in its key', async() => {
  const h = sourceHarness()
  for (let i = 0; i < 10; i++) await h.resolve(song(String(i)))
  await h.api.getOtherSource(song('0'))
  await h.resolve(song('10'))
  await h.api.getOtherSource(song('0'))
  await h.api.getOtherSource(song('9'))
  assert.equal(h.requests.length, 11)
  await h.resolve(song('1'))
  assert.equal(h.requests.length, 12)
  await h.resolve({ ...song('0'), name: 'different recording' })
  assert.equal(h.requests.length, 13)
})

test('memory cleanup preserves waiting playback but prevents its result from repopulating the cache', async() => {
  const h = sourceHarness()
  const waiting = h.api.getOtherSource(song())
  h.api.clearOtherSourceCache()
  h.requests[0].resolve([song('match')])
  assert.equal((await waiting)[0].id, 'match')
  await h.resolve(song())
  assert.equal(h.requests.length, 2)
})

test('timed-out alternative searches neither convert nor cache their late results', async() => {
  const h = sourceHarness()
  const waiting = h.api.getOtherSource(song())
  const rejected = assert.rejects(waiting, /timeout/)
  h.timers.fire()
  await rejected
  h.requests[0].resolve([song('late')])
  await flush()
  assert.equal(h.conversions(), 0)
  await h.resolve(song())
  assert.equal(h.requests.length, 2)
  assert.equal(h.conversions(), 1)
})
