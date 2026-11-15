const assert = require('node:assert/strict')
const { test } = require('node:test')
const { spawnSync } = require('node:child_process')
const { load, deferred, flush } = require('./helpers/load.cjs')
const { metadataHarness } = require('./helpers/metadata-cancellation.cjs')

const song = () => ({ id: 'song', source: 'kw', name: 'Song', singer: 'Singer', meta: {} })

for (const source of ['kw', 'kg', 'tx', 'wy', 'mg']) {
  for (const kind of source === 'tx' ? ['lyric'] : ['pic', 'lyric']) {
    test(`${source}/${kind} forwards the caller signal through its actual SDK adapters to HTTP`, async() => {
      const gate = deferred(); const native = []; const abort = load('src/utils/abort.ts')
      const http = {
        httpFetch: (url, options = {}, signal = options.signal) => {
          abort.throwIfAborted(signal)
          const entry = { signal, cancelled: false }
          native.push(entry)
          const cancelHttp = () => { entry.cancelled = true }
          return { promise: abort.withAbort(gate.promise, signal, cancelHttp), cancelHttp }
        },
      }
      const utility = { decodeLyric: async() => '', lrcTools: { rxps: {} } }
      const mgUtilities = load('src/utils/musicSdk/mg/utils/index.js', { '../../../request': http })
      const mgInfo = load('src/utils/musicSdk/mg/musicInfo.js', {
        './utils': mgUtilities,
        '../../index': {},
        '../utils': {},
      })
      const mocks = {
        '../../request': http,
        '../../index': {},
        './util': utility,
        './utils/crypto': { eapi: () => ({}), weapi: () => ({}) },
        './musicInfo': source === 'mg' ? mgInfo : { default: load('src/utils/musicSdk/wy/musicInfo.js', { '../../request': http, './utils/crypto': { weapi: () => ({}) } }).default },
        './qrcDecode': { decodeQrc: async() => '' },
        './utils/mrc': { decrypt: value => value },
        '../../message': load('src/utils/message.ts'),
        '@/config/constant': { QQ_LYRIC_CACHE_VERSION: 1 },
        he: { decode: value => value },
      }
      const metadata = load(`src/utils/musicSdk/${source}/${kind === 'pic' && source !== 'wy' ? 'pic' : 'lyric'}.js`, mocks)
      const provider = load(`src/utils/musicSdk/${source}/index.js`, {
        './tipSearch': {},
        './musicSearch': {},
        './songList': {},
        './hotSearch': {},
        './comment': {},
        './singer': {},
        './album': {},
        './lyric': kind === 'lyric' ? metadata : {},
        './pic': kind === 'pic' ? metadata : {},
        './musicInfo': mocks['./musicInfo'],
      }).default
      const h = metadataHarness({ [source]: provider }); const controller = new AbortController()
      const musicInfo = { ...song(), source, songmid: 'mid', hash: 'hash', meta: {} }
      const loading = kind === 'pic' ? h.api.getPicPath({ musicInfo, isRefresh: true, signal: controller.signal }) : h.api.getLyricInfo({ musicInfo, isRefresh: true, signal: controller.signal })
      const rejected = assert.rejects(loading, /取消http请求/)
      await flush()
      assert.equal(native.length, 1)
      assert.equal(native[0].signal, controller.signal)
      controller.abort()
      await rejected
      assert.equal(native[0].cancelled, true)
      assert.equal(native.length, 1)
      assert.equal(h.writes.length, 0)
    })
  }
}

for (const downloaded of [false, true]) {
  for (const kind of ['pic', 'lyric']) {
    test(`${downloaded ? 'downloaded' : 'online'} ${kind} cancellation ends the caller and suppresses late writes and fallback`, async() => {
      const h = metadataHarness(); const controller = new AbortController()
      h.setting['player.isS2t'] = true
      const musicInfo = downloaded ? { progress: {}, metadata: { musicInfo: song() } } : song()
      const args = { musicInfo, signal: controller.signal, isRefresh: true, listId: 'library' }
      const loading = kind === 'pic' ? h.api.getPicPath(args) : h.api.getLyricInfo(args)
      const rejected = assert.rejects(loading, /取消http请求/)
      await flush()
      assert.equal(h.calls.length, 1)
      assert.equal(h.calls[0].signal, controller.signal)
      controller.abort()
      await rejected
      assert.equal(h.cancelled(), kind === 'lyric' ? 1 : 0)
      h.pending.resolve(kind === 'pic' ? 'https://fixture/cover' : { lyric: '[00:01.00]old lyric' })
      await flush()
      assert.equal(h.calls.length, 1)
      assert.equal(h.writes.length, 0)
      assert.equal(h.conversions.length, 0)
      assert.equal(musicInfo.meta?.picUrl, undefined)
    })
  }
}

for (const kind of ['pic', 'lyric']) {
  test(`${kind} cancellation before local lookup finishes prevents any online request`, async() => {
    const h = metadataHarness(); const controller = new AbortController(); const gate = deferred()
    h.localLookup.read = () => gate.promise
    const args = { musicInfo: song(), signal: controller.signal }
    const loading = kind === 'pic' ? h.api.getPicPath(args) : h.api.getLyricInfo(args)
    const rejected = assert.rejects(loading, /取消http请求/)
    await flush()
    controller.abort()
    await rejected
    gate.resolve(null)
    await flush()
    assert.equal(h.calls.length, 0)
  })
}

test('cancelling a lyric cache read cannot return stale cached lyrics or begin an upgrade', async() => {
  const h = metadataHarness(); const controller = new AbortController(); const gate = deferred()
  h.data.getPlayerLyric = () => gate.promise
  const loading = h.api.getLyricInfo({ musicInfo: song(), signal: controller.signal })
  const rejected = assert.rejects(loading, /取消http请求/)
  await flush()
  controller.abort()
  await rejected
  gate.resolve({ lyric: '[00:01.00]cached', tlyric: '', rlyric: '' })
  await flush()
  assert.equal(h.calls.length, 0)
  assert.equal(h.writes.length, 0)
})

test('cancelling during display conversion prevents starting the remaining lyric fields', async() => {
  const h = metadataHarness(); const controller = new AbortController(); const gate = deferred()
  h.setting['player.isS2t'] = true
  let converted = 0
  h.converter.run = () => { converted++; return gate.promise }
  const loading = h.utils.buildLyricInfo({ lyric: 'main', tlyric: 'translation', rlyric: 'romanized', lxlyric: 'words' }, controller.signal)
  const rejected = assert.rejects(loading, /取消http请求/)
  await flush()
  controller.abort()
  await rejected
  gate.resolve('converted')
  await flush()
  assert.equal(converted, 1)
})

test('QQ cancellation after its first decode prevents decoding or parsing subsequent fields', async() => {
  const controller = new AbortController(); const gate = deferred()
  let decoded = 0
  const api = load('src/utils/musicSdk/tx/lyric.js', {
    he: { decode: value => value },
    '@/config/constant': { QQ_LYRIC_CACHE_VERSION: 1 },
    '../../request': {},
    '../../message': load('src/utils/message.ts'),
    './qrcDecode': { decodeQrc: () => { decoded++; return gate.promise } },
  })
  const ciphertext = '0123456789abcdef'
  const loading = api.default.parseLyric(ciphertext, ciphertext, ciphertext, controller.signal)
  const rejected = assert.rejects(loading, /取消http请求/)
  await flush()
  controller.abort()
  gate.resolve('[0,1000]text')
  await rejected
  assert.equal(decoded, 1)
})

test('cancelled waiters and metadata calls release business payloads while original promises remain pending', () => {
  const result = spawnSync(process.execPath, ['--expose-gc', '-e', `
    const assert = require('node:assert/strict')
    const { load, deferred, flush } = require('./tests/helpers/load.cjs')
    const { metadataHarness } = require('./tests/helpers/metadata-cancellation.cjs')
    const { withAbort } = load('src/utils/abort.ts')
    ;(async () => {
      const raw = deferred(), controller = new AbortController()
      let payload = { songs: new Array(10000).fill('song') }
      const reference = new WeakRef(payload)
      const loading = (async value => { try { await withAbort(raw.promise, controller.signal); return value.songs.length } catch {} })(payload)
      payload = null
      await flush(); global.gc()
      assert.ok(reference.deref(), 'the pending waiter is the positive retention control')
      await flush()
      controller.abort(); await loading
      const h = metadataHarness(), signals = [], calls = [], references = [reference]
      const startMetadata = kind => {
        const music = { id: kind, source: 'kw', name: kind, singer: '', meta: { payload: new Array(10000).fill('song') } }
        references.push(new WeakRef(music))
        const signal = new AbortController(); signals.push(signal)
        calls.push((kind === 'pic' ? h.api.getPicPath({ musicInfo: music, isRefresh: true, signal: signal.signal }) : h.api.getLyricInfo({ musicInfo: music, isRefresh: true, signal: signal.signal })).catch(() => {}))
      }
      startMetadata('pic'); startMetadata('lyric')
      await flush()
      signals.forEach(signal => signal.abort()); await Promise.all(calls)
      for (let i = 0; i < 10; i++) { await flush(); global.gc() }
      assert.ok(references.every(reference => reference.deref() === undefined), 'retained indices: ' + references.map((reference, index) => reference.deref() ? index : '').filter(String).join(','))
      assert.equal(h.calls.length, 2)
      assert.equal(raw.promise instanceof Promise, true)
    })().catch(error => { console.error(error); process.exitCode = 1 })
  `], { cwd: process.cwd(), encoding: 'utf8', timeout: 15000 })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
