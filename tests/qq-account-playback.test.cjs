const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const ts = require('typescript')

const load = (file, mocks = {}) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  })
  const context = {
    exports: {},
    require: name => {
      assert.ok(Object.hasOwn(mocks, name), `Unexpected import: ${name}`)
      return mocks[name]
    },
    global: { i18n: { t: key => key } },
    console: { log() {}, warn() {} },
  }
  vm.runInNewContext(outputText, context, { filename: file })
  return context.exports
}
const cookies = load('src/core/qqMusicCookie.ts')
const message = load('src/utils/message.ts')
const song = {
  source: 'tx',
  id: 'tx_song',
  name: 'Song',
  interval: '03:00',
  meta: { songId: 'song', strMediaMid: 'media' },
}
const response = (purl, extra = {}) => ({
  code: 0, req_1: { code: 0, data: { sip: ['https://audio.example/'], midurlinfo: [{ result: 0, purl }], ...extra } },
})
const standard = 'https://audio.example/M500media.mp3'

// Use the actual authenticated request builder as well as the account URL resolver.
const harness = ({ ticket = () => response('M500media.mp3'), probe = () => ({ readable: true }), cookie = 'uin=123; qm_keyst=Q_KEY' } = {}) => {
  const requests = []
  const probes = []
  const account = load('src/core/qqMusic.ts', {
    '@/utils/request': {
      httpFetch: (url, options) => ({
        promise: (async() => {
          requests.push({ url, ...options })
          return { statusCode: 200, body: await ticket(options.body.req_1.param, requests.length) }
        })(),
      }),
    },
    '@/utils/data': {},
    '@/utils': {},
    '@/utils/musicSdk': {},
    './qqMusicPlaylistSongsCache': {},
    '@react-native-cookies/cookies': {},
    './qqMusicCookie': cookies,
    './qqMusicLogin': {},
    './qqMusicProfile': {},
  })
  const playback = load('src/core/qqMusicUrl.ts', {
    './qqMusic': { ...account, getQQMusicSession: async() => ({ cookie }) },
    '@/utils/message': message,
    '@/utils/nativeModules/remoteAudio': {
      probeRemoteAudio: async(url, inspect) => {
        probes.push({ url, inspect })
        return probe(url, inspect)
      },
    },
  })
  return { requests, probes, account, resolve: (track = song, preferred = '128k', max = '128k') => playback.getQQMusicUrlByAccount(track, preferred, max) }
}

test('empty App ticket falls back to a genuine web request with matching comm and UA', async() => {
  const h = harness({ ticket: param => response(param.platform === '23' ? '' : 'M500media.mp3') })
  assert.equal((await h.resolve()).url, standard)
  assert.equal(h.requests.length, 2)
  const [app, web] = h.requests
  assert.equal(app.body.comm.ct, 11)
  assert.equal(app.body.comm.tmeLoginType, 2)
  assert.equal(app.body.comm.authst, 'Q_KEY')
  assert.match(app.headers['User-Agent'], /^QQMusic /)
  assert.equal(web.body.req_1.param.platform, '20')
  assert.equal(web.body.comm.ct, 24)
  assert.equal(web.body.comm.cv, 4747474)
  assert.equal(web.body.comm.platform, 'yqq.json')
  assert.equal(web.body.comm.uin, '123')
  assert.equal(web.body.comm.authst, undefined)
  assert.equal(web.body.comm.tmeLoginType, undefined)
  assert.equal(web.body.req_1.param.quality, undefined)
  assert.match(web.headers['User-Agent'], /^Mozilla\//)
  assert.equal(web.headers.Cookie, app.headers.Cookie)
})

test('App network failure still attempts the web ticket once', async() => {
  const h = harness({
    ticket: param => {
      if (param.platform === '23') throw new Error('offline')
      return response('M500media.mp3')
    },
  })
  assert.equal((await h.resolve()).url, standard)
  assert.equal(h.requests.length, 2)
})

test('a full App URL avoids extra web tickets and duration requests', async() => {
  const h = harness()
  assert.equal((await h.resolve()).url, standard)
  assert.equal(h.requests.length, 1)
  assert.deepEqual(h.probes, [{ url: standard, inspect: false }])
  assert.deepEqual(Array.from(h.requests[0].body.req_1.param.filename), ['M500media.mp3', 'M500mediamedia.mp3'])
})

test('src redirect with matching audio duration is accepted as full playback', async() => {
  const h = harness({
    ticket: () => response('M500media.mp3?src=redirect'),
    probe: () => ({ readable: true, durationMs: 180000, mime: 'audio/mpeg' }),
  })
  assert.equal((await h.resolve()).url, `${standard}?src=redirect`)
  assert.equal(h.requests.length, 1)
  assert.equal(h.probes[0].inspect, true)
})

test('a real 30 second preview falls back to a full web URL', async() => {
  const h = harness({
    ticket: param => response(`M500media.mp3${param.platform === '23' ? '?src=trial' : ''}`),
    probe: () => ({ readable: true, durationMs: 30000, mime: 'audio/mpeg' }),
  })
  assert.equal((await h.resolve()).url, standard)
  assert.equal(h.requests.length, 2)
})

test('previews, unknown durations and wrong audio formats never pass as a complete song', async() => {
  for (const media of [
    { readable: true, durationMs: 30000, mime: 'audio/mpeg' },
    { readable: true, mime: 'audio/mpeg' },
    { readable: true, durationMs: 180000, mime: 'audio/aac' },
  ]) {
    const h = harness({ ticket: () => response('M500media.mp3?src=trial'), probe: () => media })
    assert.equal(await h.resolve(), null)
    assert.equal(h.requests.length, 2)
  }
  const missingDuration = harness({ ticket: () => response('M500media.mp3?src=trial') })
  assert.equal(await missingDuration.resolve({ ...song, interval: null }), null)
  assert.equal(missingDuration.probes.length, 0)
})

test('duration validation follows the MusicOne tolerance of 2 seconds or 2 percent', async() => {
  for (const [interval, actual, full] of [
    ['03:00', 183600, true], ['03:00', 183601, false],
    ['00:45', 43000, true], ['00:45', 42999, false],
    ['01:00:00', 3600000, true],
  ]) {
    const h = harness({
      ticket: () => response('M500media.mp3?src=redirect'),
      probe: () => ({ readable: true, durationMs: actual, mime: 'audio/mpeg' }),
    })
    assert.equal(Boolean(await h.resolve({ ...song, interval })), full)
  }
})

test('a later full wifiurl wins over an earlier preview', async() => {
  const h = harness({
    ticket: () => response('', {
      midurlinfo: [{ result: 0, purl: 'M500media.mp3?src=trial', wifiurl: 'M500media.mp3' }],
    }),
  })
  assert.equal((await h.resolve()).url, standard)
  assert.equal(h.probes.length, 1)
  assert.equal(h.requests.length, 1)
})

test('a failed CDN advances to the next HTTPS candidate within the account', async() => {
  const h = harness({
    ticket: () => response('http://bad.example/M500media.mp3', { sip: ['https://bad.example/', '//audio.example/'] }),
    probe: url => ({ readable: url === standard }),
  })
  assert.equal((await h.resolve()).url, standard)
  assert.deepEqual(h.probes.map(probe => probe.url), ['https://bad.example/M500media.mp3', standard])
  assert.equal(h.requests.length, 1)
})

test('an unreadable App URL falls back to the web URL', async() => {
  const h = harness({
    ticket: param => response(`M500media.mp3?channel=${param.platform}`),
    probe: url => ({ readable: url.endsWith('channel=20') }),
  })
  assert.equal((await h.resolve()).url, `${standard}?channel=20`)
  assert.equal(h.requests.length, 2)
})

test('quality downgrade happens only after both account channels, respecting the ceiling', async() => {
  const h = harness({ ticket: param => response(param.filename[0].startsWith('M500') ? 'M500media.mp3' : '') })
  assert.equal((await h.resolve(song, '320k', '320k')).quality, '128k')
  assert.deepEqual(h.requests.map(req => [req.body.req_1.param.platform, req.body.req_1.param.filename[0]]), [
    ['23', 'M800media.mp3'], ['20', 'M800media.mp3'], ['23', 'M500media.mp3'],
  ])
  const wrongQuality = harness({ ticket: () => response('F000media.flac') })
  assert.equal(await wrongQuality.resolve(), null)
  assert.equal(wrongQuality.probes.length, 0)
})

test('cancelled requests and business rejections stop account retries', async() => {
  const cancelled = harness({ ticket: () => { throw new Error(message.requestMsg.cancelRequest) } })
  await assert.rejects(cancelled.resolve(), { message: message.requestMsg.cancelRequest })
  assert.equal(cancelled.requests.length, 1)
  const expired = harness({ ticket: () => { throw new expired.account.QQMusicSessionExpiredError() } })
  await assert.rejects(expired.resolve(), { message: 'qq_session_expired' })
  assert.equal(expired.requests.length, 1)
  for (const body of [{ code: 429 }, { code: 0, req_1: { code: 403 } }]) {
    const rejected = harness({ ticket: () => body })
    await assert.rejects(rejected.resolve(), /QQ Music vkey/)
    assert.equal(rejected.requests.length, 1)
  }
})

test('missing login or song ID does not request tickets', async() => {
  const loggedOut = harness({ cookie: '' })
  assert.equal(await loggedOut.resolve(), null)
  assert.equal(loggedOut.requests.length, 0)
  const missingId = harness()
  assert.equal(await missingId.resolve({ ...song, meta: { songId: '' } }), null)
  assert.equal(missingId.requests.length, 0)
})

test('App login type respects the credential instead of the opposite web enum', async() => {
  for (const [cookie, expected] of [
    ['uin=123; qm_keyst=Q_KEY; login_type=1', 2],
    ['uin=123; qm_keyst=W_XKEY; login_type=2', 1],
    ['uin=123; qm_keyst=Q_KEY; loginType=1', 1],
    ['uin=123; qm_keyst=W_XKEY; loginType=2', 2],
    ['uin=123; qm_keyst=Q_KEY; loginType=0', 2],
  ]) {
    const h = harness({ cookie })
    await h.resolve()
    assert.equal(h.requests[0].body.comm.tmeLoginType, expected)
  }
})

test('media probes share pending work and cache successful metadata', async() => {
  let calls = 0
  let finish
  const probe = load('src/utils/nativeModules/remoteAudio.ts', {
    'react-native': {
      NativeModules: {
        UtilsModule: {
          probeRemoteAudio: () => { calls++; return new Promise(resolve => { finish = resolve }) },
        },
      },
    },
  }).probeRemoteAudio
  const first = probe(standard, true)
  const second = probe(standard, true)
  assert.equal(calls, 1)
  finish({ readable: true, durationMs: 180000, mime: 'audio/mpeg' })
  await Promise.all([first, second])
  assert.equal((await probe(standard, true)).durationMs, 180000)
  assert.equal(calls, 1)
  const differentCheck = probe(standard, false)
  assert.equal(calls, 2)
  finish({ readable: true })
  await differentCheck
})

test('failed media probes can recover on the next attempt', async() => {
  let calls = 0
  const probe = load('src/utils/nativeModules/remoteAudio.ts', {
    'react-native': {
      NativeModules: {
        UtilsModule: {
          probeRemoteAudio: async() => ({ readable: ++calls > 1 }),
        },
      },
    },
  }).probeRemoteAudio
  assert.equal((await probe(standard, false)).readable, false)
  assert.equal((await probe(standard, false)).readable, true)
  assert.equal(calls, 2)
})
