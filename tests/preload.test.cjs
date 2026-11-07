const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const { EventEmitter } = require('node:events')
const ts = require('typescript')

const compiled = new Map()
const load = (file, mocks = {}, globals = {}) => {
  if (!compiled.has(file)) compiled.set(file, ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText)
  const context = { exports: {}, setTimeout, clearTimeout, console: { log() {} },
    require(name) { assert.ok(Object.hasOwn(mocks, name), `Unexpected import ${name} in ${file}`); return mocks[name] }, ...globals }
  vm.runInNewContext(compiled.get(file), context, { filename: file })
  return context.exports
}
const flush = async() => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)) }
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const message = { requestMsg: { cancelRequest: 'cancelled' }, isRequestCancelled: error => error?.message === 'cancelled' }
const order = load('src/utils/apiSourceOrder.ts')
const song = id => ({ id, source: 'tx', name: id, singer: 'Singer', meta: { _qualitys: { '128k': {}, '320k': {}, flac: {} } } })
const settings = () => ({
  'common.apiSource': 'user_api_a', 'common.apiSourceOrder': '["user_api_a","user_api_b"]',
  'player.preloadNext': true, 'player.cacheSize': '1024', 'player.playQuality': '320k', 'player.urlSource': 'source',
})

test('legacy source selection migrates while explicit empty selection and valid ordering are preserved', () => {
  assert.deepEqual([...order.parseApiSourceOrder('', 'user_api_a')], ['user_api_a'])
  assert.deepEqual([...order.parseApiSourceOrder('[]', 'user_api_a')], [])
  assert.deepEqual([...order.parseApiSourceOrder('["user_api_b","user_api_a","user_api_b",null]', 'user_api_a')], ['user_api_b', 'user_api_a'])
  assert.deepEqual([...order.parseApiSourceOrder('{broken', 'user_api_a')], ['user_api_a'])
})

const priorityHarness = (request = async id => ({ url: `https://audio.test/${id}`, type: '320k' })) => {
  const setting = settings()
  const calls = []
  let now = 1000
  const api = load('src/core/music/sourcePriority.ts', {
    '@/store/setting/state': { default: { setting } },
    '@/store/userApi': { state: { list: ['a', 'b', 'c'].map(id => ({ id: `user_api_${id}` })) } },
    '@/utils/apiSourceOrder': order, '@/utils/message': message,
    '@/core/userApiRuntime': { requestUserApiMusicUrl: async(...args) => { calls.push(args[0]); return request(...args) } },
  }, { Date: { now: () => now }, global: { i18n: { t: key => key } } })
  return { api, setting, calls, advance: ms => { now += ms }, get: extra => api.getMusicUrlByPriority({ musicInfo: song('one'), quality: '320k', ...extra }) }
}

test('selected custom sources are tried serially in order and stop at the first usable audio', async() => {
  const h = priorityHarness(async id => {
    if (id === 'user_api_b') throw new Error('source unavailable')
    return { url: `https://audio.test/${id}`, type: '320k' }
  })
  h.setting['common.apiSourceOrder'] = '["user_api_b","user_api_a"]'
  assert.equal((await h.get()).url, 'https://audio.test/user_api_a')
  assert.deepEqual(h.calls, ['user_api_b', 'user_api_a'])
})

test('an unreadable audio response advances to the next source even when URL resolution succeeded', async() => {
  const h = priorityHarness()
  const result = await h.get({ validateUrl: async url => { if (url.endsWith('_a')) throw new Error('403') } })
  assert.equal(result.url, 'https://audio.test/user_api_b')
  assert.deepEqual(h.calls, ['user_api_a', 'user_api_b'])
})

test('failed source cooldown avoids repeated requests without affecting other songs', async() => {
  const h = priorityHarness(async id => {
    if (id === 'user_api_a') throw new Error('offline')
    return { url: 'https://audio.test/b', type: '320k' }
  })
  await h.get()
  await h.get()
  assert.deepEqual(h.calls, ['user_api_a', 'user_api_b', 'user_api_b'])
  await h.get({ musicInfo: song('two') })
  assert.equal(h.calls.filter(id => id === 'user_api_a').length, 2)
  h.advance(31000)
  await h.get()
  assert.equal(h.calls.filter(id => id === 'user_api_a').length, 3)
})

test('cancelled source requests never fall through to another source or poison its cooldown', async() => {
  let cancel
  let firstRequest = true
  const gate = deferred()
  const h = priorityHarness(async(id, music, quality, onCancel) => {
    if (firstRequest) {
      firstRequest = false
      onCancel(() => gate.reject(new Error('cancelled')))
      await gate.promise
    }
    return { url: 'https://audio.test/a', type: quality }
  })
  const pending = h.get({ onCancel: fn => { cancel = fn } })
  const rejection = assert.rejects(pending, /cancelled/)
  cancel()
  await rejection
  assert.deepEqual(h.calls, ['user_api_a'])
  await h.get()
  assert.deepEqual(h.calls, ['user_api_a', 'user_api_a'])
})

test('playback keeps advancing through its failed sources even after the short cooldown expires', async() => {
  const h = priorityHarness()
  h.setting['common.apiSourceOrder'] = '["user_api_a","user_api_b","user_api_c"]'
  const rejectedUrls = new Set()
  rejectedUrls.add((await h.get({ rejectedUrls })).url)
  h.advance(60000)
  rejectedUrls.add((await h.get({ rejectedUrls })).url)
  h.advance(60000)
  assert.equal((await h.get({ rejectedUrls })).url, 'https://audio.test/user_api_c')
  assert.deepEqual(h.calls, ['user_api_a', 'user_api_b', 'user_api_c'])
})

test('failed downloaded bytes invalidate the chosen source and its URL before the next attempt', async() => {
  const h = priorityHarness()
  const first = await h.get()
  h.api.markMusicUrlFailed(first.url)
  assert.equal(h.api.isMusicUrlFailed(first.url), true)
  assert.equal((await h.get()).url, 'https://audio.test/user_api_b')
  assert.deepEqual(h.calls, ['user_api_a', 'user_api_b'])
})

test('unselected and removed sources are never requested, including an explicit empty selection', async() => {
  const h = priorityHarness()
  h.setting['common.apiSourceOrder'] = '["user_api_deleted","user_api_c"]'
  await h.get()
  assert.deepEqual(h.calls, ['user_api_c'])
  h.setting['common.apiSourceOrder'] = '[]'
  await assert.rejects(h.get(), /toggle_source_failed/)
  assert.deepEqual(h.calls, ['user_api_c'])
})

test('with no selected scripts, account fallback does not trigger pointless cross-platform searches', async() => {
  let searches = 0
  const api = load('src/core/music/utils.ts', {
    '@/utils/musicSdk': { default: {}, findMusic: async() => { searches++; return [] } },
    '@/utils/data': {}, '@/utils': {}, '@/store/setting/state': { default: { setting: settings() } },
    '@/utils/message': message, 'react-native-background-timer': { default: { setTimeout, clearTimeout } },
    '@/utils/musicSdk/api-source': {}, '@/core/qqMusicUrl': { getQQMusicUrlByAccount: async() => ({ url: 'https://audio.test/account', quality: '128k' }) },
    '@/config/constant': {}, './sourcePriority': { getEnabledMusicSourceIds: () => [], isMusicUrlFailed: () => false,
      getMusicUrlByPriority: async() => { throw new Error('no source') } },
  })
  const result = await api.handleGetOnlineMusicUrl({ musicInfo: song('one'), quality: '128k', allowToggleSource: true,
    isRefresh: false, urlSourceOrder: 'sourceFirst', onToggleSource() {} })
  assert.equal(result.url, 'https://audio.test/account')
  assert.equal(searches, 0)
})

const preloadHarness = ({ local = false, resolveGate, cacheHeadGate, nativeAvailable = true, cacheWritable = true } = {}) => {
  const setting = settings()
  const resolutions = [], cacheCalls = [], cancelledCache = [], failed = new Set()
  const background = []
  let cancelledResolve = 0
  let nextUrl = local ? 'content://local/song' : 'https://audio.test/one'
  const api = load('src/core/player/preload.ts', {
    '@/store/setting/state': { default: { setting } }, '@/utils/apiSourceOrder': order, '@/utils/message': message,
    '@/core/music/sourcePriority': { isMusicUrlFailed: url => failed.has(url), markMusicUrlFailed: url => failed.add(url) },
    '@/core/music': { getMusicUrl: async options => {
      resolutions.push(options)
      options.onCancel(() => { cancelledResolve++ })
      if (resolveGate) await resolveGate.promise
      const url = nextUrl
      if (!local) await options.validateUrl(url)
      return url
    } },
    '@/plugins/player/preload': { canPreloadAudio: () => nativeAvailable, preloadAudio: async(url, bytes, onCancel) => {
      const entry = { url, bytes }
      cacheCalls.push(entry)
      const gate = bytes > 0 ? cacheHeadGate : deferred()
      onCancel(() => { cancelledCache.push(entry); gate?.reject(new Error('cancelled')) })
      if (bytes === 0) background.push(gate)
      if (gate) await gate.promise
      return cacheWritable ? { cachedBytes: bytes, complete: false } : null
    } },
  })
  return { api, setting, resolutions, cacheCalls, cancelledCache, background, failed, cancelledResolve: () => cancelledResolve,
    setUrl: url => { nextUrl = url } }
}

test('preloading reads audio bytes and foreground playback takes over the same URL and cache', async() => {
  const h = preloadHarness()
  await h.api.preloadMusic(song('one'))
  assert.deepEqual(h.cacheCalls.map(call => call.bytes), [256 * 1024, 0])
  const url = await h.api.takePreloadedMusicUrl(song('one'), () => {})
  assert.equal(url, 'https://audio.test/one')
  assert.equal(h.resolutions.length, 1)
  assert.deepEqual(h.cancelledCache.map(call => call.bytes), [0])
})

test('switching early to the pending track shares the in-flight source request', async() => {
  const gate = deferred()
  const h = preloadHarness({ resolveGate: gate })
  const pending = h.api.preloadMusic(song('one'))
  h.api.keepPreloadFor(song('one'))
  h.api.pausePreload()
  const playing = h.api.takePreloadedMusicUrl(song('one'), () => {})
  gate.resolve()
  assert.equal(await pending, await playing)
  assert.equal(h.resolutions.length, 1)
  assert.deepEqual(h.cacheCalls.map(call => call.bytes), [256 * 1024])
})

test('switching to a different track cancels preloading and late responses cannot cache audio', async() => {
  const gate = deferred()
  const h = preloadHarness({ resolveGate: gate })
  const pending = h.api.preloadMusic(song('one'))
  const rejection = assert.rejects(pending, /cancelled/)
  h.api.keepPreloadFor(song('two'))
  gate.resolve()
  await rejection
  assert.equal(h.cancelledResolve(), 1)
  assert.equal(h.cacheCalls.length, 0)
  assert.equal(h.api.takePreloadedMusicUrl(song('one'), () => {}), null)
})

test('buffering pauses background bytes and resumes using the already-resolved URL', async() => {
  const h = preloadHarness()
  await h.api.preloadMusic(song('one'))
  h.api.pausePreload()
  assert.equal(h.api.isPreloadPaused(), true)
  await flush()
  await h.api.preloadMusic(song('one'))
  assert.equal(h.resolutions.length, 1)
  assert.deepEqual(h.cacheCalls.map(call => call.bytes), [256 * 1024, 0, 0])
  h.api.cancelPreload()
})

test('a background transfer failure rejects that URL and prepares a replacement before playback', async() => {
  const h = preloadHarness()
  await h.api.preloadMusic(song('one'))
  h.setUrl('https://audio.test/replacement')
  h.background[0].reject(new Error('download failed'))
  await flush()
  assert.equal(h.failed.has('https://audio.test/one'), true)
  assert.equal(h.resolutions[1].isRefresh, true)
  assert.equal(await h.api.takePreloadedMusicUrl(song('one'), () => {}), 'https://audio.test/replacement')
})

test('local resources bypass HTTP and disabling preloading or cache prevents background work', async() => {
  const h = preloadHarness({ local: true })
  assert.equal(await h.api.preloadMusic(song('local')), 'content://local/song')
  assert.equal(h.cacheCalls.length, 0)
  h.api.cancelPreload()
  h.setting['player.preloadNext'] = false
  assert.equal(h.api.preloadMusic(song('two')), null)
  h.setting['player.preloadNext'] = true
  h.setting['player.cacheSize'] = '0'
  assert.equal(h.api.preloadMusic(song('two')), null)
  assert.equal(h.resolutions.length, 1)
  const oldApp = preloadHarness({ nativeAvailable: false })
  assert.equal(oldApp.api.preloadMusic(song('one')), null)
})

test('unavailable disk cache preserves a usable URL without failing the source or continuing background IO', async() => {
  const h = preloadHarness({ cacheWritable: false })
  await h.api.preloadMusic(song('one'))
  assert.equal(await h.api.takePreloadedMusicUrl(song('one'), () => {}), 'https://audio.test/one')
  assert.equal(h.cacheCalls.length, 1)
  assert.equal(h.failed.size, 0)
})

test('changed quality or source order invalidates previously prepared audio', async() => {
  const h = preloadHarness()
  await h.api.preloadMusic(song('one'))
  h.setting['player.playQuality'] = 'flac'
  assert.equal(h.api.takePreloadedMusicUrl(song('one'), () => {}), null)
  assert.equal(h.cancelledCache.length, 1)
})

test('preloading honors a saved alternate recording and invalidates it when that choice changes', async() => {
  const h = preloadHarness()
  const music = song('one')
  music.meta.toggleMusicInfo = song('alternate')
  await h.api.preloadMusic(music)
  assert.equal(h.resolutions[0].musicInfo.id, 'alternate')
  music.meta.toggleMusicInfo = song('new-alternate')
  assert.equal(h.api.takePreloadedMusicUrl(music, () => {}), null)
})

test('cancelled cache lookups cannot start validation or source requests', async() => {
  const gate = deferred()
  let cancel, requests = 0, validations = 0
  const api = load('src/core/music/online.ts', {
    '@/utils/data': { getMusicUrl: () => gate.promise }, '@/core/list': {},
    '@/store/setting/state': { default: { setting: settings() } }, '@/utils/message': message,
    './sourcePriority': { isMusicUrlFailed: () => false },
    './utils': { handleGetOnlineMusicUrl: async() => { requests++ } },
  })
  const pending = api.getMusicUrl({ musicInfo: song('one'), isRefresh: false, onCancel: fn => { cancel = fn }, validateUrl: async() => { validations++ } })
  const rejection = assert.rejects(pending, /cancelled/)
  cancel()
  gate.resolve('https://audio.test/one')
  await rejection
  assert.equal(requests, 0)
  assert.equal(validations, 0)
})

test('a late source response after cancellation is never persisted to the URL cache', async() => {
  const gate = deferred(), writes = []
  let cancel
  const api = load('src/core/music/online.ts', {
    '@/utils/data': { getMusicUrl: async() => '', saveMusicUrl: async(...args) => writes.push(args) }, '@/core/list': {},
    '@/store/setting/state': { default: { setting: settings() } }, '@/utils/message': message,
    './sourcePriority': {}, './utils': { handleGetOnlineMusicUrl: () => gate.promise },
  })
  const pending = api.getMusicUrl({ musicInfo: song('one'), isRefresh: false, onCancel: fn => { cancel = fn } })
  const rejection = assert.rejects(pending, /cancelled/)
  await flush()
  cancel()
  gate.resolve({ musicInfo: song('one'), url: 'https://audio.test/one', quality: '320k' })
  await rejection
  assert.equal(writes.length, 0)
})

const schedulerHarness = () => {
  const app = new EventEmitter(), state = new EventEmitter()
  const setting = settings()
  const player = { isPlay: true, playMusicInfo: { musicInfo: song('current') }, progress: { nowPlayTime: 5, maxPlayTime: 180 } }
  let now = 1000, buffered = 30, selections = 0, bufferReads = 0, resetRandom = 0
  let next = { musicInfo: song('next'), isTempPlay: false, listId: 'queue' }, selecting
  let prepared, paused = false
  const calls = []
  const api = load('src/core/init/player/preloadNextMusic.ts', {
    'react-native-track-player': { default: { getBufferedPosition: async() => { bufferReads++; return buffered } } },
    '@/store/player/state': { default: player }, '@/store/setting/state': { default: { setting } }, '@/utils/message': message,
    '@/plugins/player/preload': { canPreloadAudio: () => true },
    '@/core/player/player': {
      getNextPlayMusicInfo: async() => { selections++; const value = next; if (selecting) await selecting.promise; return value },
      resetRandomNextMusicInfo: () => { resetRandom++ },
    },
    '@/core/player/preload': {
      cancelPreload: () => { prepared = undefined },
      keepPreloadFor: music => { if (prepared !== music?.id) prepared = undefined },
      pausePreload: () => { paused = true }, isPreloadPaused: () => paused,
      hasPreloadMusic: music => prepared === music.id,
      preloadMusic: async music => { calls.push(music.id); prepared = music.id; paused = false; return 'url' },
    },
  }, { Date: { now: () => now }, global: { lx: { isPlayedStop: false }, app_event: app, state_event: state } })
  api.default()
  return { app, state, setting, player, calls, selections: () => selections, bufferReads: () => bufferReads, resetRandom: () => resetRandom,
    tick: async(ms = 3000) => { now += ms; state.emit('playProgressChanged', {}); await flush() },
    buffer: value => { buffered = value }, setNext: value => { next = value }, setSelecting: value => { selecting = value } }
}

test('scheduler waits for stable playback and enough buffer, then avoids repeated selection or polling', async() => {
  const h = schedulerHarness()
  await h.tick(2999)
  assert.equal(h.selections(), 0)
  h.buffer(7)
  await h.tick(1)
  assert.equal(h.calls.length, 0)
  h.buffer(40)
  await h.tick()
  assert.deepEqual(h.calls, ['next'])
  for (let i = 0; i < 10; i++) await h.tick()
  assert.equal(h.selections(), 1)
  assert.equal(h.bufferReads(), 2)
})

test('scheduler invalidates a changed queue and mode, while respecting pause and the preload setting', async() => {
  const h = schedulerHarness()
  await h.tick()
  h.setNext({ musicInfo: song('temporary'), isTempPlay: true, listId: 'queue' })
  h.state.emit('playTempPlayListChanged')
  await h.tick()
  assert.deepEqual(h.calls, ['next', 'temporary'])
  h.setting['player.preloadNext'] = false
  h.state.emit('configUpdated', ['player.preloadNext'])
  await h.tick()
  assert.equal(h.calls.length, 2)
  h.setting['player.preloadNext'] = true
  h.player.isPlay = false
  h.app.emit('pause')
  await h.tick()
  assert.equal(h.calls.length, 2)
  h.player.isPlay = true
  h.app.emit('playerPlaying')
  h.state.emit('configUpdated', ['player.togglePlayMethod'])
  await h.tick()
  assert.equal(h.calls.length, 3)
  assert.equal(h.resetRandom(), 1)
})

test('a queue update during asynchronous selection prevents the old next track from preloading', async() => {
  const h = schedulerHarness()
  const gate = deferred()
  h.setSelecting(gate)
  await h.tick()
  h.setNext({ musicInfo: song('replacement'), listId: 'queue' })
  h.app.emit('playQueueUpdate')
  gate.resolve()
  await flush()
  assert.equal(h.calls.length, 0)
  h.setSelecting(null)
  await h.tick()
  assert.deepEqual(h.calls, ['replacement'])
})

const timers = () => {
  let id = 0
  const entries = new Map()
  return { setTimeout: (fn, ms) => { entries.set(++id, { fn, ms }); return id }, clearTimeout: key => entries.delete(key),
    fire: async ms => { for (const [key, entry] of [...entries]) if (entry.ms === ms) { entries.delete(key); entry.fn() }; await flush() }, entries }
}

const runtimeHarness = ({ autoReply = true, autoInit = true, primary } = {}) => {
  const setting = settings(), clock = timers(), handlers = new Map(), loaded = [], destroyed = [], sent = [], http = []
  const info = id => ({ id, name: id, sources: { tx: { type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k'] } } })
  const api = load('src/core/userApiRuntime.ts', {
    'react-native-background-timer': { default: clock },
    '@/store/userApi': { state: { list: ['a', 'b', 'c'].map(id => info(`user_api_${id}`)) } },
    '@/store/setting/state': { default: { setting } }, '@/utils/data': { getUserApiScript: async() => 'fixture script' },
    '@/utils': { toOldMusicInfo: music => music }, '@/utils/message': message,
    '@/core/init/userApi/request': { fetchData: () => { const gate = deferred(); const item = { request: gate.promise, abort: () => { item.aborted = true; gate.reject(new Error('aborted')) } }; http.push(item); return item } },
    '@/utils/nativeModules/userApi': {
      supportsIsolatedUserApi: () => true,
      onScriptAction: (handler, id) => { handlers.set(id, handler); return () => handlers.delete(id) },
      loadScript: (source, id) => { loaded.push({ source, id }); if (autoInit) handlers.get(id)({ action: 'init', data: { status: true, info: source } }) },
      destroy: id => destroyed.push(id),
      sendAction: (action, data, id) => {
        sent.push({ action, data, id })
        if (autoReply && action === 'request') handlers.get(id)({ action: 'response', data: { status: true, requestKey: data.requestKey, result: { data: { url: `https://audio.test/${id}` } } } })
      },
    },
  }, { global: { lx: {
    apiInitPromise: [Promise.resolve(true)],
    qualityList: { tx: ['128k', '320k'] },
    apis: { tx: { getMusicUrl: primary ?? (() => ({ canceleFn() {}, promise: Promise.resolve({ url: 'https://audio.test/main' }) })) } },
  } } })
  return { api, setting, clock, handlers, loaded, destroyed, sent, http }
}

test('the primary custom source reuses its runtime and negotiates quality without starting another script', async() => {
  let requested
  const h = runtimeHarness({ primary: (music, quality) => { requested = quality; return { canceleFn() {}, promise: Promise.resolve({ url: 'https://audio.test/main' }) } } })
  const result = await h.api.requestUserApiMusicUrl('user_api_a', song('one'), 'flac')
  assert.equal(result.url, 'https://audio.test/main')
  assert.equal(requested, '320k')
  assert.equal(h.loaded.length, 0)
  assert.equal(h.clock.entries.size, 0)
})

test('simultaneous backup source requests have isolated responses and release both runtimes', async() => {
  const h = runtimeHarness({ autoReply: false })
  const first = h.api.requestUserApiMusicUrl('user_api_b', song('one'), '320k')
  const second = h.api.requestUserApiMusicUrl('user_api_c', song('two'), '320k')
  await flush()
  const requests = h.sent.filter(item => item.action === 'request')
  assert.notEqual(requests[0].id, requests[1].id)
  for (const item of [...requests].reverse()) h.handlers.get(item.id)({ action: 'response', data: {
    status: true, requestKey: item.data.requestKey, result: { data: { url: `https://audio.test/${item.data.data.info.musicInfo.id}` } },
  } })
  assert.equal((await first).url, 'https://audio.test/one')
  assert.equal((await second).url, 'https://audio.test/two')
  assert.equal(h.destroyed.length, 2)
  assert.equal(h.handlers.size, 0)
  assert.equal(h.setting['common.apiSource'], 'user_api_a')
})

test('cancelling an isolated request aborts its HTTP work and never sends a late response', async() => {
  const h = runtimeHarness({ autoReply: false })
  let cancel
  const result = h.api.requestUserApiMusicUrl('user_api_b', song('one'), '320k', fn => { cancel = fn })
  const rejection = assert.rejects(result, /cancelled/)
  await flush()
  const id = h.loaded[0].id
  h.handlers.get(id)({ action: 'request', data: { requestKey: 'http', url: 'https://api.test', options: {} } })
  cancel()
  await rejection
  await flush()
  assert.equal(h.http[0].aborted, true)
  assert.deepEqual(h.destroyed, [id])
  assert.equal(h.sent.filter(item => item.action === 'response').length, 0)
  assert.equal(h.clock.entries.size, 0)
})

test('a source stuck during initialization times out and releases its runtime', async() => {
  const h = runtimeHarness({ autoInit: false })
  const result = h.api.requestUserApiMusicUrl('user_api_b', song('one'), '320k')
  const rejection = assert.rejects(result, /timeout/)
  await flush()
  await h.clock.fire(12000)
  await rejection
  assert.equal(h.destroyed.length, 1)
  assert.equal(h.handlers.size, 0)
})

test('a script cancellation cleanup error cannot leave the caller or timeout pending', async() => {
  const h = runtimeHarness({ primary: () => ({ canceleFn() { throw new Error('cleanup failed') }, promise: new Promise(() => {}) }) })
  let cancel
  const result = h.api.requestUserApiMusicUrl('user_api_a', song('one'), '320k', fn => { cancel = fn })
  const rejection = assert.rejects(result, /cancelled/)
  await flush()
  assert.doesNotThrow(() => cancel())
  await rejection
  assert.equal(h.clock.entries.size, 0)
})

test('native script events are routed to their runtime and retain that script metadata', () => {
  const hub = new EventEmitter(), sent = []
  const native = { loadScript() {}, loadScriptForRuntime() {}, destroy() {}, destroyRuntime() {},
    sendAction: (...args) => sent.push(['main', ...args]), sendActionForRuntime: (...args) => sent.push(args) }
  const bridge = load('src/utils/nativeModules/userApi.ts', { 'react-native': {
    NativeModules: { UserApiModule: native },
    NativeEventEmitter: class { addListener(name, handler) { hub.on(name, handler); return { remove: () => hub.off(name, handler) } } },
  } })
  const main = [], backup = []
  bridge.loadScript({ id: 'a', name: 'Primary', script: '' })
  bridge.loadScript({ id: 'b', name: 'Backup', script: '' }, 'backup')
  const offMain = bridge.onScriptAction(event => main.push(event))
  const offBackup = bridge.onScriptAction(event => backup.push(event), 'backup')
  hub.emit('api-action', { runtimeId: 'backup', action: 'init', data: JSON.stringify({ status: true, info: {} }) })
  assert.equal(main.length, 0)
  assert.equal(backup[0].data.info.name, 'Backup')
  hub.emit('api-action', { action: 'init', data: JSON.stringify({ status: true, info: {} }) })
  assert.equal(main[0].data.info.name, 'Primary')
  bridge.sendAction('cancelRequest', 'one', 'backup')
  assert.equal(sent[0][0], 'backup')
  offMain(); offBackup(); bridge.destroy('backup')
})

test('audio prefetch uses the actual native module and enforces a deadline for the first bytes', async() => {
  const clock = timers(), gate = deferred(), cancelled = [], started = []
  const api = load('src/plugins/player/preload.ts', {
    'react-native': { NativeModules: { TrackPlayerModule: {
      preloadMusic: (...args) => { started.push(args); return gate.promise }, cancelPreloadMusic: id => { cancelled.push(id); throw new Error('cleanup failed') },
    } } },
    '@/utils/message': message, './playList': { defaultUserAgent: 'fixture-agent' }, 'react-native-background-timer': { default: clock },
  })
  assert.equal(api.canPreloadAudio(), true)
  const result = api.preloadAudio('https://audio.test/a', 262144, () => {})
  const rejection = assert.rejects(result, /timeout/)
  await clock.fire(15000)
  await rejection
  assert.equal(started[0][2], 'fixture-agent')
  assert.deepEqual(cancelled, [started[0][0]])
  gate.reject(new Error('late network failure'))
  await flush()
  assert.equal(clock.entries.size, 0)
})

test('native playback errors allow all selected backup sources to be tried before skipping', async() => {
  const app = new EventEmitter(), clock = timers(), requests = []
  const setting = settings()
  setting['common.apiSourceOrder'] = '["user_api_a","user_api_b","user_api_c","user_api_d"]'
  const player = { musicInfo: { id: 'one' }, playMusicInfo: { musicInfo: song('one') } }
  let stopped = 0
  const api = load('src/core/init/player/playerEvent.ts', {
    '@/core/player/player': { playNext: async() => {}, setMusicUrl: (...args) => requests.push(args) },
    '@/core/player/playStatus': { setStatusText() {} },
    '@/plugins/player': { getPosition: async() => 0, isEmpty: () => false, setStop: async() => { stopped++ } },
    '@/utils/tools': { isActive: () => true }, 'react-native-background-timer': { default: clock },
    '@/store/player/state': { default: player }, '@/core/player/progress': { setNowPlayTime() {} },
    '@/store/setting/state': { default: { setting } }, '@/core/player/playHistory': { addPlayHistory: async() => {} },
    '@/utils/apiSourceOrder': order,
  }, { global: { app_event: app, lx: { isPlayedStop: false }, i18n: { t: key => key } } })
  api.default()
  for (let i = 0; i < 4; i++) { app.emit('playerError'); await flush() }
  assert.equal(requests.length, 4)
  assert.equal(stopped, 0)
  app.emit('playerError')
  await flush()
  assert.equal(stopped, 1)
  app.emit('musicToggled')
  app.emit('playerError')
  await flush()
  assert.equal(requests.length, 5)
})
