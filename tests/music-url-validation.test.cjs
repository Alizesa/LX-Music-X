const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load, deferred, flush } = require('./helpers/load.cjs')

const message = load('src/utils/message.ts')
const abort = load('src/utils/abort.ts', { './message': message })
const order = load('src/utils/apiSourceOrder.ts')
const song = { id: 'tx_song', source: 'tx', name: 'Song', singer: 'Singer', interval: '04:00',
  meta: { songId: 'song', strMediaMid: 'media', _qualitys: { '128k': {}, '320k': {}, flac: {} } } }
const preview = 'https://isure.stream.qqmusic.qq.com/M500media.mp3?vkey=preview'
const full = 'https://isure.stream.qqmusic.qq.com/M500media.mp3?vkey=full'
const audio = (durationMs = 240000, mime = 'audio/mpeg') => ({ readable: true, durationMs, mime })

// Exercise the real source selector, URL cache and preloader together. Only HTTP/native IO is mocked.
const harness = ({ cachedUrl, inspect = url => audio(url === preview ? 60000 : 240000),
  request = id => ({ url: id === 'user_api_a' ? preview : full, type: '128k' }), account = async() => null } = {}) => {
  const probes = [], cancelled = [], requests = [], writes = [], cacheReads = []
  const setting = {
    'common.apiSource': 'user_api_a', 'common.apiSourceOrder': '["user_api_a","user_api_b"]',
    'player.playQuality': '128k', 'player.urlSource': 'source', 'player.noVipStandardQuality': true,
    'player.preloadNext': true, 'player.cacheSize': '1024',
  }
  const media = load('src/utils/nativeModules/remoteAudio.ts', {
    'react-native': { NativeModules: { UtilsModule: {
      startRemoteAudioProbe: async(id, url, duration, timeoutMs) => {
        probes.push({ id, url, duration, timeoutMs })
        return inspect(url)
      },
      cancelRemoteAudioProbe: id => { cancelled.push(id) },
    } } },
    'react-native-background-timer': { default: { setTimeout, clearTimeout } }, '@/utils/abort': abort,
  })
  const qq = load('src/core/qqMusicUrl.ts', {
    './qqMusic': {}, '@/utils/nativeModules/remoteAudio': media, '@/utils/message': message, '@/utils/abort': abort,
    'react-native-background-timer': { default: { setTimeout, clearTimeout } },
  })
  const priority = load('src/core/music/sourcePriority.ts', {
    '@/store/setting/state': { default: { setting } },
    '@/store/userApi': { state: { list: ['user_api_a', 'user_api_b', 'user_api_c'].map(id => ({ id })) } },
    '@/utils/apiSourceOrder': order, '@/utils/message': message, '@/core/qqMusicUrl': qq,
    '@/core/userApiRuntime': { requestUserApiMusicUrl: async(...args) => { requests.push(args[0]); return request(...args) } },
  }, { global: { i18n: { t: key => key } } })
  const cache = new Map(cachedUrl ? [[`${song.id}:128k`, cachedUrl]] : [])
  const data = {
    getMusicUrl: async(music, quality) => cache.get(`${music.id}:${quality}`),
    saveMusicUrl: async(music, quality, url) => { writes.push({ music, quality, url }); cache.set(`${music.id}:${quality}`, url) },
  }
  const pipeline = load('src/core/music/utils.ts', {
    '@/utils/musicUrlCache': load('src/utils/musicUrlCache.ts', { './apiSourceOrder': load('src/utils/apiSourceOrder.ts') }),
    '@/utils/musicSdk': {}, '@/utils/data': data, '@/utils': {},
    '@/store/setting/state': { default: { setting } }, '@/utils/message': message,
    'react-native-background-timer': { default: { setTimeout, clearTimeout } },
    '@/utils/musicSdk/api-source': {}, '@/core/qqMusicUrl': { ...qq, getQQMusicUrlByAccount: account },
    '@/config/constant': {}, './sourcePriority': priority,
  })
  const online = load('src/core/music/online.ts', {
    '@/utils/musicUrlCache': load('src/utils/musicUrlCache.ts', { './apiSourceOrder': load('src/utils/apiSourceOrder.ts') }),
    '@/utils/data': data, '@/core/list': {}, '@/store/setting/state': { default: { setting } },
    '@/utils/message': message, '@/core/qqMusicUrl': qq, './utils': pipeline, './sourcePriority': priority,
  })
  const music = load('src/core/music/index.ts', {
    './online': online, './download': {},
    './local': { findLocalMusicInfo: async() => null, getMusicUrl: async() => 'content://local/song' },
    '@/utils/music': {}, '@/config/constant': {},
  })
  const preload = load('src/core/player/preload.ts', {
    '@/core/music': music, '@/core/music/sourcePriority': priority, '@/store/setting/state': { default: { setting } },
    '@/utils/message': message, '@/utils/apiSourceOrder': order,
    '@/plugins/player/preload': { canPreloadAudio: () => true, preloadAudio: async(url, bytes) => {
      cacheReads.push({ url, bytes })
      return { cachedBytes: bytes, complete: true }
    } },
  })
  return { setting, probes, cancelled, requests, writes, cacheReads, cache, priority, pipeline, preload,
    resolve: options => music.getMusicUrl({ musicInfo: song, quality: '128k', allowToggleSource: false, ...options }) }
}

for (const urlSourceOrder of ['sourceFirst', 'sourceOnly', 'accountFirst']) {
  test(`the first ${urlSourceOrder} play rejects 60 seconds for a 240 second song before caching`, async() => {
    const h = harness()
    assert.equal(await h.resolve({ urlSourceOrder }), full)
    assert.deepEqual(h.requests, ['user_api_a', 'user_api_b'])
    assert.deepEqual(h.writes.map(item => item.url), [full])
    assert.equal(await h.resolve({ urlSourceOrder }), full)
    assert.equal(h.requests.length, 2)
    assert.deepEqual(h.probes.map(item => item.url), [preview, full])
    assert.ok(h.probes.every(item => item.duration))
  })
}

test('preloading rejects a readable preview before writing audio bytes or handing off to playback', async() => {
  const h = harness()
  assert.equal(await h.preload.preloadMusic(song), full)
  assert.deepEqual(h.cacheReads, [{ url: full, bytes: 256 * 1024 }])
  assert.equal(await h.preload.takePreloadedMusicUrl(song, () => {}), full)
  assert.deepEqual(h.requests, ['user_api_a', 'user_api_b'])
  assert.deepEqual(h.writes.map(item => item.url), [full])
})

test('QQ previews behind a proxy are checked on both fresh resolution and cached playback', async() => {
  const proxy = 'https://audio.example/proxy/song'
  for (const cachedUrl of [undefined, proxy]) {
    const h = harness({ cachedUrl, inspect: url => audio(url === proxy ? 60000 : 240000),
      request: id => ({ url: id === 'user_api_a' ? proxy : full, type: '128k' }) })
    assert.equal(await h.resolve(), full)
    assert.deepEqual(h.writes.map(item => item.url), [full])
    assert.equal(h.probes.filter(item => item.url === proxy).length, 1)
  }
})

test('cross-platform fallback rejects newly resolved and cached QQ previews before preloading', async() => {
  for (const cachedUrl of [undefined, preview]) {
    const h = harness({ cachedUrl })
    const accepted = []
    const result = await h.pipeline.getOnlineOtherSourceMusicUrl({
      musicInfos: [song], quality: '128k', isRefresh: false, onToggleSource() {},
      validateUrl: async url => { accepted.push(url) },
    })
    assert.equal(result.url, full)
    assert.deepEqual(accepted, [full])
    assert.equal(h.priority.isMusicUrlFailed(preview), true)
    assert.deepEqual(h.probes.map(item => item.url), [preview, full])
  }
})

test('a QQ CDN preview remains invalid when cached under another platform song', async() => {
  const h = harness({ cachedUrl: preview })
  assert.equal(await h.resolve({ musicInfo: { ...song, source: 'wy' } }), full)
  assert.equal(h.priority.isMusicUrlFailed(preview), true)
  assert.deepEqual(h.writes.map(item => item.url), [full])
})

test('unknown duration, unreadable data and wrong formats advance to the next selected source', async() => {
  for (const invalid of [{ readable: true }, audio(0), audio(60000), audio(60000, 'audio/mp4a-latm'), audio(240000, 'text/html'), { readable: false }]) {
    const h = harness({ inspect: url => url === preview ? invalid : audio() })
    assert.equal(await h.preload.preloadMusic(song), full)
    assert.deepEqual(h.cacheReads.map(item => item.url), [full])
    assert.deepEqual(h.requests, ['user_api_a', 'user_api_b'])
  }
})

test('full AAC and Opus source audio remains playable through fresh URLs, caching and preloading', async() => {
  const url = 'https://audio.example/proxy/full'
  for (const mime of ['audio/mp4a-latm', 'audio/aac', 'audio/opus']) {
    for (const cachedUrl of [undefined, url]) {
      const h = harness({ cachedUrl, inspect: () => audio(240000, mime), request: () => ({ url, type: '128k' }) })
      assert.equal(await h.resolve(), url)
      assert.equal(await h.preload.preloadMusic(song), url)
      assert.deepEqual(h.cacheReads, [{ url, bytes: 256 * 1024 }])
      assert.equal(h.probes.length, 1)
      assert.equal(h.requests.length, cachedUrl ? 0 : 1)
    }
  }
})

test('sources returning the same rejected preview do not re-probe it or cache a failed URL', async() => {
  const h = harness({ request: () => ({ url: preview, type: '128k' }) })
  await assert.rejects(h.resolve(), /toggle_source_failed/)
  await assert.rejects(h.resolve(), /toggle_source_failed/)
  assert.deepEqual(h.requests, ['user_api_a', 'user_api_b'])
  assert.deepEqual(h.probes.map(item => item.url), [preview])
  assert.equal(h.writes.length, 0)
})

test('source audio is validated at its actual downgraded quality', async() => {
  const h = harness()
  const result = await h.priority.getMusicUrlByPriority({ musicInfo: song, quality: 'flac' })
  assert.equal(result.url, full)
  assert.equal(result.quality, '128k')
  assert.deepEqual(h.probes.map(item => item.url), [preview, full])
})

test('forced source refresh does not trust an earlier full-duration probe', async() => {
  let duration = 240000
  const h = harness({ inspect: url => audio(url === preview ? duration : 240000) })
  assert.equal(await h.resolve(), preview)
  duration = 60000
  assert.equal(await h.resolve({ isRefresh: true }), full)
  assert.deepEqual(h.probes.map(item => item.url), [preview, preview, full])
})

test('cancelling source duration inspection stops native IO without fallback or cache writes', async() => {
  const gate = deferred()
  let checking = true, cancel
  const h = harness({ inspect: () => checking ? gate.promise : audio() })
  const pending = h.resolve({ onCancel: fn => { cancel = fn } })
  const rejection = assert.rejects(pending, { message: message.requestMsg.cancelRequest })
  await flush()
  cancel()
  await rejection
  assert.deepEqual(h.cancelled, [h.probes[0].id])
  assert.deepEqual(h.requests, ['user_api_a'])
  assert.equal(h.writes.length, 0)
  assert.equal(h.priority.isMusicUrlFailed(preview), false)
  checking = false
  gate.resolve(audio(60000))
  assert.equal(await h.resolve(), preview)
  assert.deepEqual(h.requests, ['user_api_a', 'user_api_a'])
})

test('cancelling preloading during duration inspection cannot hand a late URL to playback', async() => {
  const gate = deferred()
  const h = harness({ inspect: () => gate.promise })
  const pending = h.preload.preloadMusic(song)
  const rejection = assert.rejects(pending, { message: message.requestMsg.cancelRequest })
  await flush()
  h.preload.cancelPreload()
  await rejection
  gate.resolve(audio())
  await flush()
  assert.deepEqual(h.cancelled, [h.probes[0].id])
  assert.deepEqual(h.requests, ['user_api_a'])
  assert.equal(h.cacheReads.length, 0)
  assert.equal(h.writes.length, 0)
  assert.equal(h.preload.takePreloadedMusicUrl(song, () => {}), null)
})

test('cancellation during a cross-platform cache lookup prevents all subsequent work', async() => {
  const h = harness({ cachedUrl: preview })
  let cancel
  const pending = h.pipeline.getOnlineOtherSourceMusicUrl({
    musicInfos: [song], quality: '128k', isRefresh: false, onToggleSource() {},
    onCancel: fn => { cancel = fn },
  })
  cancel()
  await assert.rejects(pending, { message: message.requestMsg.cancelRequest })
  assert.equal(h.probes.length, 0)
  assert.equal(h.requests.length, 0)
  assert.equal(h.priority.isMusicUrlFailed(preview), false)
})

test('a genuine one-minute song and local files still play without unnecessary requests', async() => {
  const h = harness()
  assert.equal(await h.resolve({ musicInfo: { ...song, interval: '01:00' } }), preview)
  assert.deepEqual(h.requests, ['user_api_a'])
  assert.equal(h.probes.length, 1)
  assert.equal(await h.resolve({ musicInfo: { ...song, source: 'local' } }), 'content://local/song')
  assert.equal(h.probes.length, 1)
})
