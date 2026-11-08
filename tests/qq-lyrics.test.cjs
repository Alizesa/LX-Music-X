const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const ts = require('typescript')
// The package ships a CommonJS main under type=module; execute that bundle directly in Node.
const playerContext = { module: { exports: {} }, setTimeout, clearTimeout }
vm.runInNewContext(fs.readFileSync(require.resolve('lrc-file-parser'), 'utf8'), playerContext)
const Lyric = playerContext.module.exports

const copy = value => value == null ? value : JSON.parse(JSON.stringify(value))
const flush = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve
  const promise = new Promise(_resolve => { resolve = _resolve })
  return { promise, resolve }
}
const load = (file, mocks = {}) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  })
  const context = {
    exports: {},
    Buffer,
    console: { log() {}, warn() {}, error() {} },
    global: { i18n: { t: key => key } },
    require: name => {
      if (name === '@/utils/playbackLog' && !Object.hasOwn(mocks, name)) return require('./helpers/playback-log.cjs')
      assert.ok(Object.hasOwn(mocks, name), `Unexpected import: ${name}`)
      return mocks[name]
    },
  }
  vm.runInNewContext(outputText, context, { filename: file })
  return context.exports
}

const constants = load('src/config/constant.ts')
const message = load('src/utils/message.ts')
const qrc = load('src/utils/musicSdk/tx/qrcDecode.js', { pako: require('pako') })
const sdkHarness = (respond = () => { throw new Error('Unexpected HTTP request') }) => {
  const requests = []
  let cancellations = 0
  const sdk = load('src/utils/musicSdk/tx/lyric.js', {
    he: require('he'),
    '@/config/constant': constants,
    '../../message': message,
    './qrcDecode': qrc,
    '../../request': {
      httpFetch: (url, options) => {
        const index = requests.length
        requests.push({ url, options: copy(options) })
        return {
          promise: Promise.resolve().then(() => respond(index, url, options)),
          cancelHttp: () => { cancellations++ },
        }
      },
    },
  }).default
  return { sdk, requests, cancellations: () => cancellations }
}
const parser = sdkHarness().sdk
const main = '[1000,1000]hello(1000,1000)'
const translated = '[00:01.00]译文'
const reply = body => ({ statusCode: 200, body })
const appReply = data => reply({ code: 0, req: { code: 0, data } })
const song = { songmid: '001EvkSS4O999t', songId: 101825875 }

test('unmatched introductory and middle translation lines do not consume the remaining lyrics', async() => {
  // Same timing pattern as 001EvkSS4O999t; fixture text is synthetic.
  const info = await parser.parseLyric(
    '[856,500]Title(856,500)\n[38054,1000]First(38054,1000)\n[41374,1000]Second(41374,1000)',
    '[00:00.00]署名\n[00:09.51]前奏\n[00:38.05]第一行\n[00:40.00]无对应行\n[00:41.37]第二行',
  )
  assert.equal(info.tlyric, '[00:38.054]第一行\n[00:41.374]第二行')
  assert.match(info.lxlyric, /\[00:38\.054\]<0,1000>First/)
  // Verify the actual player parser attaches the translations to both lyric formats.
  for (const lyric of [info.lyric, info.lxlyric]) {
    const player = new Lyric({ onPlay() {} })
    player.setLyric(lyric, [info.tlyric])
    assert.deepEqual(copy(player.lines.flatMap(line => line.extendedLyrics)), ['第一行', '第二行'])
  }
})

test('translation alignment handles minute boundaries, fractional precision and the 600ms limit', async() => {
  const info = await parser.parseLyric(
    '[59995,1000]First\n[70200,1000]Second\n[80300,1000]Third\n[90009,1000]Fourth',
    '[01:00.00]一\n[01:10.8]二\n[01:20.901]三\n[01:30.009]四',
  )
  assert.equal(info.tlyric, '[00:59.995]一\n[01:10.200]二\n[01:30.009]四')
})

test('alignment chooses the closest translation instead of the first acceptable one', async() => {
  const info = await parser.parseLyric('[10000,1000]Original', '[00:09.50]较远\n[00:10.20]最近')
  assert.equal(info.tlyric, '[00:10.000]最近')
})

test('placeholder and duplicate translations do not render as additional lyric lines', async() => {
  const info = await parser.parseLyric(
    '[1000,1000]First\n[5000,1000]Second\n[10000,1000]Third',
    '[00:01.00]///\n[00:05.00]Second\n[00:10.00]译文',
  )
  assert.equal(info.tlyric, '[00:10.000]译文')
})

test('plaintext, Base64 and QRC ciphertext produce the same lyric and translation', async() => {
  // Encrypted synthetic QRC text: [1000,1000]hello(1000,1000).
  const encrypted = 'd6a2be95d64473721567294db2d38051c347bd0903e95567b795ccc930340c8f'
  for (const encoded of [main, Buffer.from(main).toString('base64'), ` ${encrypted.toUpperCase()}\n`]) {
    const info = await parser.parseLyric(encoded, Buffer.from(translated).toString('base64'))
    assert.equal(info.lyric, '[00:01.000]hello')
    assert.equal(info.lxlyric, '[00:01.000]<0,1000>hello')
    assert.equal(info.tlyric, '[00:01.000]译文')
    assert.equal(info.qqLyricVersion, constants.QQ_LYRIC_CACHE_VERSION)
  }
})

test('XML entities, embedded newlines and romanized LRC survive decoding', async() => {
  const info = await parser.parseLyric(
    '<LyricInfo><Lyric_1 LyricContent="[1000,1000]&quot;hello&amp;bye&quot;(1000,1000)&#10;[4000,1000]next(4000,1000)" /></LyricInfo>',
    '<Lyric_1 LyricContent="[1000,1000]译文(1000,1000)"/>',
    '[00:01.00]romaji\n[00:04.00]tsugi',
  )
  assert.equal(info.lyric, '[00:01.000]"hello&bye"\n[00:04.000]next')
  assert.equal(info.tlyric, '[00:01.000]译文')
  assert.equal(info.rlyric, '[00:01.000]romaji\n[00:04.000]tsugi')
})

test('LRC with repeated timestamps and colon fractions retains each translated occurrence', async() => {
  const info = await parser.parseLyric('[00:01.1][00:05:01]Original', '[00:01.10][00:05.010]译文')
  assert.equal(info.lyric, '[00:01.100]Original\n[00:05.010]Original')
  assert.equal(info.tlyric, '[00:01.100]译文\n[00:05.010]译文')
})

test('QQ lyrics use the MusicOne request parameters and can resolve a song by MID alone', async() => {
  const h = sdkHarness(() => appReply({ lyric: main, trans: translated }))
  const info = await h.sdk.getLyric({ songmid: song.songmid }).promise
  assert.equal(info.tlyric, '[00:01.000]译文')
  assert.equal(h.requests.length, 1)
  const { url, options } = h.requests[0]
  assert.equal(url, 'https://u.y.qq.com/cgi-bin/musicu.fcg')
  assert.equal(options.method, 'post')
  assert.deepEqual(options.body.comm, { ct: 19, cv: 0, tmeAppID: 'qqmusiclight' })
  assert.equal(options.body.req.method, 'GetPlayLyricInfo')
  assert.equal(options.body.req.module, 'music.musichallSong.PlayLyricInfo')
  assert.deepEqual(options.body.req.param, {
    songMID: song.songmid, songID: 0, platform: 0, needNew: 1, crypt: 0, qrc: 1, roma: 1, trans: 1,
  })
})

test('a valid lyric without translation does not trigger an unnecessary fallback request', async() => {
  const h = sdkHarness(() => appReply({ lyric: main, trans: '' }))
  const info = await h.sdk.getLyric(song).promise
  assert.equal(info.lyric, '[00:01.000]hello')
  assert.equal(info.tlyric, '')
  assert.equal(h.requests.length, 1)
})

test('a rejected main request falls back to web lyrics, including its translation', async() => {
  const h = sdkHarness(index => index === 0
    ? reply({ code: 0, req: { code: 500 } })
    : reply({ code: 0, lyric: Buffer.from('[00:01]hello').toString('base64'), trans: translated }))
  const info = await h.sdk.getLyric(song).promise
  assert.equal(info.tlyric, '[00:01.000]译文')
  assert.equal(h.requests.length, 2)
  assert.equal(info.qqLyricVersion, 0)
  const url = new URL(h.requests[1].url)
  assert.equal(url.hostname, 'c.y.qq.com')
  assert.equal(url.searchParams.get('songmid'), song.songmid)
  assert.equal(url.searchParams.get('nobase64'), '1')
})

test('a metadata-only primary response falls back instead of masquerading as a lyric', async() => {
  const h = sdkHarness(index => index === 0
    ? appReply({ lyric: '[offset:10]' })
    : reply({ code: 0, lyric: '[00:01]hello' }))
  assert.equal((await h.sdk.getLyric(song).promise).lyric, '[00:01.000]hello')
  assert.equal(h.requests.length, 2)
})

test('both lyric endpoints failing reject after two requests and never return a request object', async() => {
  const h = sdkHarness(() => reply({ code: 500 }))
  await assert.rejects(h.sdk.getLyric(song).promise, /Get lyric failed/)
  assert.equal(h.requests.length, 2)
})

test('cancellation stops the active lyric request without starting a fallback', async() => {
  const pending = deferred()
  const h = sdkHarness(() => pending.promise)
  const request = h.sdk.getLyric(song)
  request.cancelHttp()
  pending.resolve(reply({ code: 500 }))
  await assert.rejects(request.promise, error => error.message === message.requestMsg.cancelRequest)
  assert.equal(h.requests.length, 1)
  assert.equal(h.cancellations(), 1)
})

const oldLyrics = { lyric: '[00:01.000]hello', tlyric: '', rlyric: '', lxlyric: '' }
const newLyrics = { ...oldLyrics, tlyric: '[00:01.000]译文', qqLyricVersion: constants.QQ_LYRIC_CACHE_VERSION }
const cacheHarness = ({ cached = oldLyrics, edited, source = 'tx', fetchLyrics = async() => copy(newLyrics) } = {}) => {
  const music = { id: `${source}_song`, source, meta: { songId: song.songmid, id: song.songId } }
  const key = constants.storageDataPrefix.lyric + music.id
  const values = new Map([[key, copy(cached)]])
  if (edited) values.set(key + '_edited', copy(edited))
  let requests = 0
  const data = load('src/utils/data.ts', {
    '@/config/constant': constants,
    './legacyList': {},
    './common': { throttle: fn => fn },
    './nativeModules/secureStorage': {},
    '@/plugins/storage': {
      getDataMultiple: async keys => keys.map(key => [key, copy(values.get(key) ?? null)]),
      saveData: async(key, value) => { values.set(key, copy(value)) },
    },
  })
  const setting = { default: { setting: { 'player.isS2t': false } } }
  const utils = load('src/core/music/utils.ts', {
    '@/utils/musicUrlCache': load('src/utils/musicUrlCache.ts', { './apiSourceOrder': load('src/utils/apiSourceOrder.ts') }),
    './sourcePriority': {},
    '@/config/constant': constants,
    '@/utils/data': data,
    '@/store/setting/state': setting,
    '@/utils': { toOldMusicInfo: info => ({ songmid: info.meta.songId, songId: info.meta.id }) },
    '@/utils/tools': {},
    '@/utils/message': message,
    '@/utils/musicSdk/api-source': {},
    '@/core/qqMusicUrl': {},
    'react-native-background-timer': { default: { setTimeout, clearTimeout } },
    '@/utils/musicSdk': {
      findMusic() { assert.fail('A cache upgrade must not substitute another recording') },
      default: {
        [source]: {
          getLyric: () => {
            requests++
            return { promise: Promise.resolve().then(fetchLyrics) }
          },
        },
      },
    },
  })
  const online = load('src/core/music/online.ts', {
    '@/utils/musicUrlCache': load('src/utils/musicUrlCache.ts', { './apiSourceOrder': load('src/utils/apiSourceOrder.ts') }),
    '@/core/qqMusicUrl': {},
    './sourcePriority': {},
    '@/utils/message': message,
    '@/utils/data': data,
    '@/core/list': {},
    '@/store/setting/state': setting,
    './utils': utils,
  })
  return {
    get: (isRefresh = false) => online.getLyricInfo({ musicInfo: music, isRefresh }),
    cached: () => copy(values.get(key)),
    edited: () => copy(values.get(key + '_edited')),
    requests: () => requests,
  }
}

test('an old QQ lyric cache refreshes once and persists the recovered translation', async() => {
  const h = cacheHarness()
  assert.equal((await h.get()).tlyric, newLyrics.tlyric)
  await flush()
  assert.deepEqual(h.cached(), newLyrics)
  assert.equal((await h.get()).tlyric, newLyrics.tlyric)
  assert.equal(h.requests(), 1)
})

test('a current QQ cache with no translation remains reusable', async() => {
  const h = cacheHarness({ cached: { ...newLyrics, tlyric: '' } })
  assert.equal((await h.get()).tlyric, '')
  assert.equal(h.requests(), 0)
})

test('old QQ caches with partial translations are also upgraded', async() => {
  const h = cacheHarness({ cached: { ...oldLyrics, tlyric: '[00:01.000]旧翻译' } })
  assert.equal((await h.get()).tlyric, newLyrics.tlyric)
  assert.equal(h.requests(), 1)
})

test('manually edited lyrics survive cache upgrades, including an intentionally absent translation', async() => {
  const edited = { lyric: '[00:01.000]My edit' }
  const h = cacheHarness({ edited })
  const result = await h.get()
  assert.equal(result.lyric, edited.lyric)
  assert.equal(result.tlyric, undefined)
  assert.equal(result.isEdited, true)
  assert.equal(h.requests(), 0)
  assert.deepEqual(h.edited(), edited)
  assert.deepEqual(h.cached(), oldLyrics)
})

test('failed cache upgrades preserve old lyrics and can recover on a later request', async() => {
  let offline = true
  const h = cacheHarness({
    fetchLyrics: async() => {
      if (offline) throw new Error('offline')
      return copy(newLyrics)
    },
  })
  assert.equal((await h.get()).lyric, oldLyrics.lyric)
  assert.deepEqual(h.cached(), oldLyrics)
  offline = false
  assert.equal((await h.get()).tlyric, newLyrics.tlyric)
  assert.equal(h.requests(), 2)
})

test('QQ parser upgrades do not invalidate another provider cache', async() => {
  const h = cacheHarness({ source: 'wy' })
  assert.equal((await h.get()).lyric, oldLyrics.lyric)
  assert.equal(h.requests(), 0)
})

test('explicit refresh still bypasses a current lyric cache', async() => {
  const h = cacheHarness({ cached: { ...newLyrics, tlyric: '' } })
  assert.equal((await h.get(true)).tlyric, newLyrics.tlyric)
  assert.equal(h.requests(), 1)
})

test('a web fallback is provisional and upgrades when the main lyric endpoint recovers', async() => {
  const api = sdkHarness(index => index === 0
    ? reply({ code: 500 })
    : index === 1 ? reply({ code: 0, lyric: '[00:01]hello' }) : appReply({ lyric: main, trans: translated }))
  const h = cacheHarness({ cached: null, fetchLyrics: () => api.sdk.getLyric(song).promise })
  assert.equal((await h.get()).tlyric, '')
  await flush()
  assert.equal((await h.get()).tlyric, newLyrics.tlyric)
  await flush()
  assert.equal(h.cached().qqLyricVersion, constants.QQ_LYRIC_CACHE_VERSION)
  assert.equal((await h.get()).tlyric, newLyrics.tlyric)
  assert.equal(h.requests(), 2)
  assert.equal(api.requests.length, 3)
})

test('a temporary web fallback cannot replace cached translations and word timing during an upgrade', async() => {
  const cached = { ...oldLyrics, tlyric: '[00:01.000]已有译文', lxlyric: '[00:01.000]<0,1000>hello' }
  const api = sdkHarness(index => index === 0 ? reply({ code: 500 }) : reply({ code: 0, lyric: '[00:01]hello' }))
  const h = cacheHarness({ cached, fetchLyrics: () => api.sdk.getLyric(song).promise })
  const info = await h.get()
  await flush()
  assert.equal(info.tlyric, cached.tlyric)
  assert.equal(info.lxlyric, cached.lxlyric)
  assert.deepEqual(h.cached(), cached)
})
