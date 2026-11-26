const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load, deferred, flush } = require('./helpers/load.cjs')

const message = load('src/utils/message.ts')
const abort = load('src/utils/abort.ts', { './message': message })
const order = load('src/utils/apiSourceOrder.ts')
const song = {
  id: 'tx_song',
  source: 'tx',
  name: 'Song',
  singer: 'Singer',
  interval: '04:00',
  meta: { songId: 'song', strMediaMid: 'media', _qualitys: { '128k': {}, '320k': {}, flac: {} } },
}
const preview = 'https://isure.stream.qqmusic.qq.com/M500media.mp3?vkey=preview'
const full = 'https://isure.stream.qqmusic.qq.com/M500media.mp3?vkey=full'
const kugouSong = { ...song, id: 'kg_song', source: 'kg' }
const kugouAd = 'https://webfs.yun.kugou.com/song/vip-notice.mp3'
const sources = ['tx', 'kg', 'kw', 'wy', 'mg']
const audio = (durationMs = 240000, mime = 'audio/mpeg') => ({ readable: true, durationMs, mime })

// Exercise the real source selector, URL cache and preloader together. Only HTTP/native IO is mocked.
const harness = ({
  cachedUrl, inspect = url => audio(url === preview ? 60000 : 240000),
  request = id => ({ url: id === 'user_api_a' ? preview : full, type: '128k' }), account = async() => null,
  otherSources = [], localPath = 'content://local/song',
  localRequest = () => { throw new Error('Local source unavailable') },
} = {}) => {
  const probes = []; const cancelled = []; const requests = []; const writes = []; const cacheReads = []
  const setting = {
    'common.apiSource': 'user_api_a',
    'common.apiSourceOrder': '["user_api_a","user_api_b"]',
    'player.playQuality': '128k',
    'player.urlSource': 'source',
    'player.noVipStandardQuality': true,
    'player.preloadNext': true,
    'player.cacheSize': '1024',
  }
  const media = load('src/utils/nativeModules/remoteAudio.ts', {
    'react-native': {
      NativeModules: {
        UtilsModule: {
          startRemoteAudioProbe: async(id, url, duration, timeoutMs) => {
            probes.push({ id, url, duration, timeoutMs })
            return inspect(url)
          },
          cancelRemoteAudioProbe: id => { cancelled.push(id) },
        },
      },
    },
    'react-native-background-timer': { default: { setTimeout, clearTimeout } },
    '@/utils/abort': abort,
  })
  const qq = load('src/core/musicUrlValidation.ts', {
    './qqMusic': {},
    '@/utils/nativeModules/remoteAudio': media,
    '@/utils/message': message,
    '@/utils/abort': abort,
    'react-native-background-timer': { default: { setTimeout, clearTimeout } },
  })
  const priority = load('src/core/music/sourcePriority.ts', {
    '@/store/setting/state': { default: { setting } },
    '@/store/userApi': { state: { list: ['user_api_a', 'user_api_b', 'user_api_c'].map(id => ({ id })) } },
    '@/utils/apiSourceOrder': order,
    '@/utils/message': message,
    '@/core/musicUrlValidation': qq,
    '@/core/userApiRuntime': { requestUserApiMusicUrl: async(...args) => { requests.push(args[0]); return request(...args) } },
  }, { global: { i18n: { t: key => key } } })
  const cache = new Map(cachedUrl ? [[`${song.id}:128k`, cachedUrl]] : [])
  const data = {
    getMusicUrl: async(music, quality) => cache.get(`${music.id}:${quality}`),
    saveMusicUrl: async(music, quality, url, context, actualQuality = quality) => { writes.push({ music, quality, url, actualQuality }); cache.set(`${music.id}:${quality}`, url) },
  }
  const pipeline = load('src/core/music/utils.ts', {
    '@/utils/musicUrlCache': load('src/utils/musicUrlCache.ts', { './apiSourceOrder': load('src/utils/apiSourceOrder.ts') }),
    '@/utils/musicSdk': { findMusic: async() => otherSources },
    '@/utils/data': data,
    '@/utils': { toNewMusicInfo: music => music, toOldMusicInfo: music => music },
    '@/store/setting/state': { default: { setting } },
    '@/utils/message': message,
    'react-native-background-timer': { default: { setTimeout, clearTimeout } },
    '@/utils/musicSdk/api-source': { apis: () => ({ getMusicUrl: localRequest }) },
    '@/core/qqMusicUrl': { getQQMusicUrlByAccount: account },
    '@/core/musicUrlValidation': qq,
    '@/config/constant': {},
    './sourcePriority': priority,
  }, { global: { i18n: { t: key => key }, lx: { apiInitPromise: [Promise.resolve(true)] } } })
  const online = load('src/core/music/online.ts', {
    '@/utils/musicUrlCache': load('src/utils/musicUrlCache.ts', { './apiSourceOrder': load('src/utils/apiSourceOrder.ts') }),
    '@/utils/data': data,
    '@/core/list': {},
    '@/store/setting/state': { default: { setting } },
    '@/utils/message': message,
    '@/core/musicUrlValidation': qq,
    './utils': pipeline,
    './sourcePriority': priority,
  })
  const local = load('src/core/music/local.ts', {
    '@/utils/data': data,
    '@/core/list': {},
    './utils': pipeline,
    '@/utils/music': { getLocalFilePath: async() => localPath },
    '@/utils/localMediaMetadata': {},
    '@/utils/fs': { stat: async() => ({ name: 'song.mp3' }) },
    '@/utils/localMatchIndex': {},
    '@/core/localList': {},
    '@/config/constant': {},
    '@/utils/message': message,
    './sourcePriority': priority,
    '@/utils/musicUrlCache': load('src/utils/musicUrlCache.ts', { './apiSourceOrder': order }),
    '@/store/setting/state': { default: { setting } },
  })
  const download = load('src/core/music/download.ts', { './online': online, './utils': pipeline })
  const music = load('src/core/music/index.ts', {
    './online': online,
    './download': download,
    './local': { ...local, findLocalMusicInfo: async() => null },
    '@/utils/music': {},
    '@/config/constant': {},
  })
  const preload = load('src/core/player/preload.ts', {
    '@/core/music': music,
    '@/core/music/sourcePriority': priority,
    '@/store/setting/state': { default: { setting } },
    '@/utils/message': message,
    '@/utils/apiSourceOrder': order,
    '@/plugins/player/preload': {
      canPreloadAudio: () => true,
      preloadAudio: async(url, bytes) => {
        cacheReads.push({ url, bytes })
        return { cachedBytes: bytes, complete: true }
      },
    },
  })
  return {
    setting,
    probes,
    cancelled,
    requests,
    writes,
    cacheReads,
    cache,
    priority,
    pipeline,
    preload,
    resolve: options => music.getMusicUrl({ musicInfo: song, quality: '128k', allowToggleSource: false, ...options }),
  }
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

test('account-first waits for the account, then each custom script and its audio check in the selected order', async() => {
  const accountGate = deferred(); const scriptGate = deferred(); const probeGate = deferred()
  const h = harness({
    account: () => accountGate.promise,
    request: id => id === 'user_api_b' ? scriptGate.promise : { url: full, type: '128k' },
    inspect: url => url === preview ? probeGate.promise : audio(),
  })
  h.setting['player.urlSource'] = 'account'
  h.setting['common.apiSourceOrder'] = '["user_api_b","user_api_a","user_api_c"]'
  const pending = h.resolve()
  await flush()
  assert.deepEqual(h.requests, [])
  accountGate.resolve(null)
  await flush()
  assert.deepEqual(h.requests, ['user_api_b'])
  assert.equal(h.probes.length, 0)
  // A script may try several internal channels before its one URL promise resolves.
  scriptGate.resolve({ url: preview, type: '128k' })
  await flush()
  assert.deepEqual(h.requests, ['user_api_b'])
  assert.deepEqual(h.probes.map(item => item.url), [preview])
  probeGate.resolve(audio(60000))
  assert.equal(await pending, full)
  assert.deepEqual(h.requests, ['user_api_b', 'user_api_a'])
  assert.deepEqual(h.probes.map(item => item.url), [preview, full])
  assert.deepEqual(h.writes.map(item => item.url), [full])
})

test('QQ previews behind a proxy are checked on both fresh resolution and cached playback', async() => {
  const proxy = 'https://audio.example/proxy/song'
  for (const cachedUrl of [undefined, proxy]) {
    const h = harness({
      cachedUrl,
      inspect: url => audio(url === proxy ? 60000 : 240000),
      request: id => ({ url: id === 'user_api_a' ? proxy : full, type: '128k' }),
    })
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
      musicInfos: [song],
      quality: '128k',
      isRefresh: false,
      onToggleSource() {},
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

test('QQ failure followed by a Kugou VIP notice continues to the next platform before preloading', async() => {
  const attempted = []
  const alternate = { ...song, id: 'wy_song', source: 'wy' }
  const h = harness({
    otherSources: [kugouSong, alternate],
    request: (apiId, music) => {
      attempted.push([music.source, apiId])
      if (music.source === 'tx') throw new Error('Old QQ API is unavailable')
      return { url: music.source === 'kg' ? kugouAd : full, type: '128k' }
    },
    inspect: url => audio(url === kugouAd ? 12000 : 240000),
  })
  assert.equal(await h.resolve({ allowToggleSource: true, quality: undefined }), full)
  assert.equal(await h.preload.preloadMusic(song), full)
  assert.deepEqual(attempted, [
    ['tx', 'user_api_a'], ['tx', 'user_api_b'], ['kg', 'user_api_a'], ['kg', 'user_api_b'], ['wy', 'user_api_a'],
  ])
  assert.deepEqual(h.probes.map(item => item.url), [kugouAd, full])
  assert.deepEqual(h.cacheReads, [{ url: full, bytes: 256 * 1024 }])
  assert.deepEqual(h.writes.map(item => item.url), [full, full])
  assert.equal(h.priority.isMusicUrlFailed(kugouAd), true)
  assert.equal(await h.preload.takePreloadedMusicUrl(song, () => {}), full)
})

test('fresh and cached Kugou VIP notices, including proxy URLs, advance to another selected script', async() => {
  for (const url of [kugouAd, 'https://audio.example/proxy/kugou']) {
    for (const cached of [false, true]) {
      const h = harness({
        request: apiId => ({ url: apiId === 'user_api_a' ? url : full, type: '128k' }),
        inspect: candidate => audio(candidate === url ? 12000 : 240000),
      })
      if (cached) h.cache.set(`${kugouSong.id}:128k`, url)
      assert.equal(await h.resolve({ musicInfo: kugouSong }), full)
      assert.deepEqual(h.probes.map(item => item.url), [url, full])
      assert.deepEqual(h.writes.map(item => item.url), [full])
      assert.equal(h.priority.isMusicUrlFailed(url), true)
      assert.equal(await h.resolve({ musicInfo: kugouSong }), full)
      assert.equal(h.probes.length, 2)
    }
  }
})

test('cross-platform fallback rejects a cached Kugou VIP notice before accepting another script', async() => {
  const h = harness({
    request: apiId => ({ url: apiId === 'user_api_a' ? kugouAd : full, type: '128k' }),
    inspect: url => audio(url === kugouAd ? 12000 : 240000),
  })
  h.cache.set(`${kugouSong.id}:128k`, kugouAd)
  const result = await h.pipeline.getOnlineOtherSourceMusicUrl({
    musicInfos: [kugouSong], quality: '128k', isRefresh: false, onToggleSource() {},
  })
  assert.equal(result.url, full)
  assert.equal(result.isFromCache, false)
  assert.deepEqual(h.probes.map(item => item.url), [kugouAd, full])
})

test('a Kugou CDN notice cached under another platform is still rejected', async() => {
  const h = harness({
    cachedUrl: kugouAd,
    request: () => ({ url: full, type: '128k' }),
    inspect: url => audio(url === kugouAd ? 12000 : 240000),
  })
  assert.equal(await h.resolve({ musicInfo: { ...song, source: 'wy' } }), full)
  assert.equal(h.priority.isMusicUrlFailed(kugouAd), true)
  assert.deepEqual(h.probes.map(item => item.url), [kugouAd, full])
})

test('Kugou notices alone fail without entering the URL cache or preloaded playback', async() => {
  const h = harness({
    otherSources: [kugouSong],
    request: (_apiId, music) => {
      if (music.source === 'tx') throw new Error('Old QQ API is unavailable')
      return { url: kugouAd, type: '128k' }
    },
    inspect: () => audio(12000),
  })
  await assert.rejects(h.resolve({ allowToggleSource: true }), /toggle_source_failed/)
  await assert.rejects(h.preload.preloadMusic(song), /toggle_source_failed/)
  assert.equal(h.writes.length, 0)
  assert.equal(h.cacheReads.length, 0)
  assert.equal(h.preload.takePreloadedMusicUrl(song, () => {}), null)
  assert.deepEqual(h.probes.map(item => item.url), [kugouAd])
})

test('a genuine 12 second Kugou song remains playable and shares its successful probe', async() => {
  const shortSong = { ...kugouSong, interval: '00:12' }
  const h = harness({ request: () => ({ url: kugouAd, type: '128k' }), inspect: () => audio(12000) })
  assert.equal(await h.preload.preloadMusic(shortSong), kugouAd)
  assert.equal(await h.resolve({ musicInfo: shortSong }), kugouAd)
  assert.deepEqual(h.probes.map(item => item.url), [kugouAd])
  assert.equal(h.requests.length, 1)
})

for (const source of sources) {
  test(`${source} checks fresh and cached proxy audio before playback and preloading`, async() => {
    const music = { ...song, id: `${source}_proxy`, source }
    const proxy = `https://audio.example/proxy/${source}`
    for (const cached of [false, true]) {
      for (const duration of [12000, 60000]) {
        const h = harness({
          request: id => ({ url: id === 'user_api_a' ? proxy : full, type: '128k' }),
          inspect: url => audio(url === proxy ? duration : 240000),
        })
        if (cached) h.cache.set(`${music.id}:128k`, proxy)
        assert.equal(await h.preload.preloadMusic(music), full)
        assert.equal(await h.resolve({ musicInfo: music }), full)
        assert.deepEqual(h.probes.map(item => item.url), [proxy, full])
        assert.deepEqual(h.cacheReads.map(item => item.url), [full])
        assert.deepEqual(h.writes.map(item => item.url), [full])
      }
    }
  })

  test(`${source} rejects unknown duration, non-audio, video and unreadable responses before preloading`, async() => {
    for (const invalid of [{ readable: true }, audio(0), audio(NaN), audio(Infinity), audio(60000), audio(60000, 'audio/mp4a-latm'),
      audio(240000, 'text/html'), { ...audio(), hasVideo: true }, { readable: false }]) {
      const h = harness({ inspect: url => url === preview ? invalid : audio() })
      assert.equal(await h.preload.preloadMusic({ ...song, source }), full)
      assert.deepEqual(h.cacheReads.map(item => item.url), [full])
      assert.deepEqual(h.requests, ['user_api_a', 'user_api_b'])
    }
  })
}

test('all matched platforms are verified in order until complete audio is found', async() => {
  const attempted = []
  const h = harness({
    otherSources: ['kg', 'kw', 'wy', 'mg'].map(source => ({ ...song, id: `${source}_match`, source })),
    request: (id, music) => {
      attempted.push([music.source, id])
      if (music.source === 'tx') throw new Error('QQ API unavailable')
      return { url: `https://audio.example/${music.source}`, type: '128k' }
    },
    inspect: url => audio(url.endsWith('/mg') ? 240000 : 12000),
  })
  assert.equal(await h.resolve({ allowToggleSource: true }), 'https://audio.example/mg')
  assert.deepEqual(attempted.map(([source]) => source), ['tx', 'tx', 'kg', 'kg', 'kw', 'kw', 'wy', 'wy', 'mg'])
  assert.deepEqual(h.probes.map(item => item.url), ['kg', 'kw', 'wy', 'mg'].map(source => `https://audio.example/${source}`))
  assert.deepEqual(h.writes.map(item => item.url), ['https://audio.example/mg', 'https://audio.example/mg'])
})

test('fresh and cached replacements are checked against the original duration across recursive platform fallback', async() => {
  const wrong = { ...kugouSong, interval: '00:12' }
  const right = { ...song, id: 'wy_match', source: 'wy' }
  for (const cached of [false, true]) {
    const h = harness({
      request: (_id, music) => ({ url: music.source === 'kg' ? kugouAd : full, type: '128k' }),
      inspect: url => audio(url === kugouAd ? 12000 : 240000),
    })
    if (cached) h.cache.set(`${wrong.id}:128k`, kugouAd)
    const accepted = []
    const result = await h.pipeline.getOnlineOtherSourceMusicUrl({
      musicInfos: [wrong, right],
      expectedMusicInfo: song,
      quality: '128k',
      isRefresh: false,
      onToggleSource() {},
      validateUrl: async url => { accepted.push(url) },
    })
    assert.equal(result.url, full)
    assert.equal(result.musicInfo.id, right.id)
    assert.deepEqual(accepted, [full])
    assert.deepEqual(h.probes.map(item => item.url), [kugouAd, full])
  }
})

test('missing original duration uses the matched duration while wholly unknown durations remain unverified', async() => {
  const h = harness({ request: () => ({ url: full, type: '128k' }) })
  const result = await h.pipeline.getOnlineOtherSourceMusicUrl({
    musicInfos: [kugouSong], expectedMusicInfo: { ...song, interval: null }, quality: '128k', isRefresh: false, onToggleSource() {},
  })
  assert.equal(result.url, full)
  await assert.rejects(h.priority.getMusicUrlByPriority({ musicInfo: { ...song, interval: null }, quality: '128k' }), /toggle_source_failed/)
  assert.equal(h.priority.isMusicUrlFailed(full), false)
  assert.equal(h.probes.length, 1)
})

test('a remembered alternate version cannot replace the original duration during preloading', async() => {
  const original = { ...song, interval: '01:37', meta: { ...song.meta, toggleMusicInfo: { ...kugouSong, interval: '04:40' } } }
  const h = harness({
    request: (_id, music) => ({ url: music.source === 'kg' ? kugouAd : full, type: '128k' }),
    inspect: url => audio(url === kugouAd ? 280000 : 97000),
  })
  assert.equal(await h.preload.preloadMusic(original), full)
  assert.deepEqual(h.probes.map(item => item.url), [kugouAd, full])
  assert.deepEqual(h.cacheReads.map(item => item.url), [full])
  assert.deepEqual(h.writes.map(item => item.url), [full])
})

test('a complete alternate version rejected for the original remains playable as its own song', async() => {
  const alternate = { ...kugouSong, interval: '04:40' }
  const h = harness({
    request: () => ({ url: kugouAd, type: '128k' }),
    inspect: () => audio(280000),
  })
  await assert.rejects(h.priority.getMusicUrlByPriority({
    musicInfo: alternate, expectedMusicInfo: { ...song, interval: '01:37' }, quality: '128k',
  }), /toggle_source_failed/)
  assert.equal(h.priority.isMusicUrlFailed(kugouAd), false)
  assert.equal(await h.resolve({ musicInfo: alternate }), kugouAd)
  assert.equal(h.probes.length, 1)
})

test('legacy download entries use the same validated cross-platform playback fallback', async() => {
  const h = harness({
    otherSources: [kugouSong],
    request: (id, music) => {
      if (music.source === 'tx') throw new Error('QQ API unavailable')
      return { url: id === 'user_api_a' ? kugouAd : full, type: '128k' }
    },
    inspect: url => audio(url === kugouAd ? 12000 : 240000),
  })
  const download = { id: 'download_song', progress: {}, metadata: { musicInfo: song } }
  assert.equal(await h.resolve({ musicInfo: download, allowToggleSource: true }), full)
  assert.deepEqual(h.probes.map(item => item.url), [kugouAd, full])
  assert.deepEqual(h.writes.map(item => item.url), [full, full])
})

test('missing local files reject fresh and cached script notices before searching online replacements', async() => {
  const local = { ...song, id: 'local_song', source: 'local', meta: { ...song.meta, filePath: '/missing/song.mp3' } }
  for (const cached of [false, true]) {
    const h = harness({
      localPath: null,
      otherSources: [kugouSong],
      localRequest: () => ({ promise: Promise.resolve({ url: kugouAd }) }),
      request: () => ({ url: full, type: '128k' }),
      inspect: url => audio(url === kugouAd ? 12000 : 240000),
    })
    if (cached) h.cache.set(`${local.id}:128k`, kugouAd)
    assert.equal(await h.resolve({ musicInfo: local, allowToggleSource: true }), full)
    assert.deepEqual(h.probes.map(item => item.url), [kugouAd, full])
    assert.deepEqual(h.writes.map(item => item.url), [full])
  }
})

test('cancelling local-to-online media inspection aborts native work without fallback or cache writes', async() => {
  const gate = deferred()
  const h = harness({
    localPath: null,
    otherSources: [kugouSong],
    localRequest: () => ({ promise: Promise.resolve({ url: kugouAd }) }),
    inspect: () => gate.promise,
  })
  let cancel
  const pending = h.resolve({ musicInfo: { ...song, source: 'local' }, allowToggleSource: true, onCancel: fn => { cancel = fn } })
  const rejected = assert.rejects(pending, { message: message.requestMsg.cancelRequest })
  await flush()
  cancel()
  await rejected
  gate.resolve(audio())
  await flush()
  assert.deepEqual(h.cancelled, [h.probes[0].id])
  assert.equal(h.writes.length, 0)
  assert.equal(h.requests.length, 0)
  assert.equal(h.priority.isMusicUrlFailed(kugouAd), false)
})

test('local script file URLs bypass HTTP probing and caller network validation', async() => {
  const local = { ...song, source: 'local' }
  const url = 'content://library/song'
  for (const cached of [false, true]) {
    const h = harness({ localRequest: () => ({ promise: Promise.resolve({ url }) }) })
    if (cached) h.cache.set(`${local.id}:128k`, url)
    let validations = 0
    assert.equal((await h.pipeline.getOnlineOtherSourceMusicUrlByLocal(local, false, { validateUrl: async() => { validations++ } })).url, url)
    assert.equal(validations, 0)
    assert.equal(h.probes.length, 0)
  }
})

for (const cached of [false, true]) {
  test(`a ${cached ? 'cached' : 'fresh'} URL rejected while media inspection is pending cannot be accepted`, async() => {
    const gate = deferred()
    const h = harness({ cachedUrl: cached ? preview : undefined, inspect: url => url === preview ? gate.promise : audio() })
    const rejectedUrls = new Set()
    const accepted = []
    const pending = h.resolve({ rejectedUrls, validateUrl: async url => { accepted.push(url) } })
    await flush()
    rejectedUrls.add(preview)
    gate.resolve(audio())
    assert.equal(await pending, full)
    assert.deepEqual(accepted, [full])
    assert.deepEqual(h.writes.map(item => item.url), [full])
  })
}

test('a source URL rejected during the caller validation cannot be cached or returned', async() => {
  const h = harness({ inspect: () => audio() })
  const rejectedUrls = new Set()
  assert.equal(await h.resolve({ rejectedUrls, validateUrl: async url => { if (url === preview) rejectedUrls.add(url) } }), full)
  assert.deepEqual(h.writes.map(item => item.url), [full])
})

test('preloaded audio is invalidated when the original or remembered alternate duration changes', async() => {
  for (const alternate of [false, true]) {
    const music = { ...song, meta: { ...song.meta, toggleMusicInfo: alternate ? { ...kugouSong } : undefined } }
    const h = harness({ request: () => ({ url: full, type: '128k' }) })
    assert.equal(await h.preload.preloadMusic(music), full)
    if (alternate) music.meta.toggleMusicInfo.interval = '00:12'
    else music.interval = '00:12'
    assert.equal(h.preload.takePreloadedMusicUrl(music, () => {}), null)
  }
})

test('preload probe failures do not cool down every custom script before foreground playback', async() => {
  for (const reason of ['byte_limit', 'metadata_error', 'timeout']) {
    let recovered = false
    const urls = ['user_api_a', 'user_api_b', 'user_api_c'].map(id => `https://audio.example/${id}`)
    const h = harness({
      request: id => ({ url: `https://audio.example/${id}`, type: '128k' }),
      inspect: () => recovered ? audio() : { readable: true, reason },
    })
    h.setting['common.apiSourceOrder'] = '["user_api_a","user_api_b","user_api_c"]'
    h.setting['player.urlSource'] = 'account'
    h.setting['player.playQuality'] = '320k'
    await assert.rejects(h.preload.preloadMusic(song), /toggle_source_failed/)
    assert.deepEqual(h.requests, ['user_api_a', 'user_api_b', 'user_api_c'])
    assert.ok(urls.every(url => !h.priority.isMusicUrlFailed(url)))
    assert.equal(h.writes.length, 0)
    assert.equal(h.cacheReads.length, 0)
    recovered = true
    // Foreground and preload must use the same quality/fallback key, as on the device.
    assert.equal(await h.resolve({ quality: undefined }), urls[0])
    assert.deepEqual(h.requests, ['user_api_a', 'user_api_b', 'user_api_c', 'user_api_a'])
    assert.deepEqual(h.writes.map(({ quality, actualQuality, url }) => ({ quality, actualQuality, url })), [
      { quality: '128k', actualQuality: '128k', url: urls[0] },
      { quality: '320k', actualQuality: '128k', url: urls[0] },
    ])
  }
})

test('a cached URL remains eligible for revalidation after a local metadata failure', async() => {
  let recovered = false
  const h = harness({ cachedUrl: full, inspect: () => recovered ? audio() : { readable: true, reason: 'byte_limit' } })
  await assert.rejects(h.resolve(), /toggle_source_failed/)
  assert.equal(h.priority.isMusicUrlFailed(full), false)
  assert.deepEqual(h.requests, ['user_api_a', 'user_api_b'])
  recovered = true
  assert.equal(await h.resolve(), full)
  assert.deepEqual(h.requests, ['user_api_a', 'user_api_b'])
  assert.equal(h.writes.length, 0)
})

test('an actual HTTP rejection still cools down its source and URL', async() => {
  const h = harness({ inspect: url => url === preview ? { readable: false, reason: 'http_error', httpStatus: 403 } : audio() })
  assert.equal(await h.resolve(), full)
  assert.equal(h.priority.isMusicUrlFailed(preview), true)
  assert.equal((await h.priority.getMusicUrlByPriority({ musicInfo: song, quality: '128k', allowQualityFallback: false })).url, full)
  assert.deepEqual(h.requests, ['user_api_a', 'user_api_b', 'user_api_b'])
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
  let checking = true; let cancel
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
    musicInfos: [song],
    quality: '128k',
    isRefresh: false,
    onToggleSource() {},
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

const downloadAudio = load('src/core/downloadAudio.ts', { '@/utils/nativeModules/remoteAudio': {} })

test('download policy rejects mislabeled FLAC inside source selection and reuses the AAC probe', async() => {
  const bad = 'https://fixture/lossless'
  const good = 'https://fixture/aac'
  const media = { ...audio(240000, 'audio/mp4a-latm'), headerKind: 'mp4', contentLength: 3732392, bitRate: 96000 }
  const h = harness({
    inspect: url => url === bad ? { ...audio(240000, 'audio/flac'), contentLength: 34887849, bitDepth: 16 } : media,
    request: id => ({ url: id === 'user_api_a' ? bad : good, type: '128k' }),
  })
  let accepted
  assert.equal(await h.resolve({ urlSourceOrder: 'sourceOnly', validateUrl: async(_url, info) => { accepted = downloadAudio.validateDownloadMedia('128k', info) } }), good)
  assert.equal(accepted.extension, 'm4a')
  assert.equal(accepted.contentLength, 3732392)
  assert.deepEqual(h.probes.map(item => item.url), [bad, good])
  assert.equal(h.priority.isMusicUrlFailed(bad), false)
  assert.deepEqual(h.requests, ['user_api_a', 'user_api_b'])
})

test('account download passes its already validated media to the download policy', async() => {
  const media = { ...audio(), headerKind: 'mp3', contentLength: 3840000 }
  const h = harness({ account: async() => ({ url: full, quality: '128k', media }) })
  h.setting['player.urlSource'] = 'account'
  let accepted
  assert.equal(await h.resolve({ urlSourceOrder: 'accountFirst', validateUrl: async(_url, info) => { accepted = downloadAudio.validateDownloadMedia('128k', info) } }), full)
  assert.equal(accepted.extension, 'mp3')
  assert.equal(accepted.contentLength, 3840000)
  assert.equal(h.probes.length, 0)
  assert.equal(h.requests.length, 0)
})
