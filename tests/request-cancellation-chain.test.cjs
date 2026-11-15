const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load, deferred, flush } = require('./helpers/load.cjs')
const { harness: playbackHarness, song, constants } = require('./helpers/playback.cjs')

const response = body => ({ headers: { map: {} }, text: async() => JSON.stringify(body), status: 200, url: 'https://fixture.test', ok: true })
const transport = () => {
  const calls = []; const timers = new Set()
  let cancelled = 0; let bodiesRead = 0
  const raw = load('src/utils/httpRequest.js', {
    'react-native-background-timer': {
      default: {
        setTimeout(fn) { timers.add(fn); return fn },
        clearTimeout(fn) { timers.delete(fn) },
      },
    },
  }, {
    global: {
      AbortController,
      fetch: (url, options) => {
        const gate = deferred()
        options.signal.addEventListener('abort', () => { cancelled++ })
        calls.push({ url, options, gate })
        // 故意不因 abort 结束，覆盖原生已排队/迟到的结果。
        return gate.promise.then(body => ({ ...response(body), text: async() => { bodiesRead++; return JSON.stringify(body) } }))
      },
    },
  })
  const http = load('src/utils/request.js', {
    './httpRequest': raw,
    './musicSdk/options': { bHh: '__fixture_signing' },
    './message': load('src/utils/message.ts'),
    pako: {},
  })
  return { http, raw, calls, timers, cancelled: () => cancelled, bodiesRead: () => bodiesRead }
}

const sdk = (source, kind, http) => {
  const index = { formatPlayTime: String, formatPlayCount: String, decodeName: value => value, sizeFormate: String }
  const wyUtils = load('src/utils/musicSdk/wy/utils/index.js', { '../../../request': http, './crypto': { eapi: () => ({}) } })
  const mgUtils = load('src/utils/musicSdk/mg/utils/index.js', { '../../../request': http })
  const mocks = {
    '../../request': http,
    '../../index': index,
    '../utils': { toMD5: String, formatSingerName: () => '' },
    './util': { formatSinger: value => value, objStr2JSON: value => value, signatureParams: () => '' },
    './album': { default: {} },
    './utils/index': source === 'wy' ? wyUtils : mgUtils,
    './utils/crypto': { linuxapi: () => ({}) },
    './musicDetail': { default: {} },
    './vendors/infSign.min': { default() {} },
    './musicInfo': { filterMusicInfoListV5: value => value },
    './musicSearch': { createSignature: () => ({ deviceId: 'fixture', sign: 'fixture' }) },
  }
  return load(`src/utils/musicSdk/${source}/${kind === 'music' ? 'musicSearch' : 'songList'}.js`, mocks).default
}
const emptyResponse = (source, kind) => kind === 'music'
  ? {
      kw: { TOTAL: '0', SHOW: '0', abslist: [] },
      kg: { error_code: 0, data: { lists: [], total: 0 } },
      wy: { code: 200, data: { resources: [], totalCount: 0 } },
      mg: { code: '000000', songResultData: { resultList: [], totalCount: 0 } },
    }[source]
  : {
      kw: { TOTAL: '0', abslist: [] },
      kg: { errcode: 0, data: { info: [], total: 0 } },
      tx: { code: 0, data: { list: [], sum: 0 } },
      wy: { code: 200, result: { playlists: [], playlistCount: 0 } },
      mg: { code: '000000', data: { songListResultData: { result: [], totalCount: '0' } } },
    }[source]

for (const kind of ['music', 'songlist']) {
  for (const source of kind === 'music' ? ['kw', 'kg', 'wy', 'mg'] : ['kw', 'kg', 'tx', 'wy', 'mg']) {
    test(`${kind}/${source}: changing the query cancels real HTTP and prevents old parse/retry work`, async() => {
      const h = transport()
      const provider = sdk(source, kind, h.http)
      const info = { list: [], key: null, page: 0, total: 0, maxPage: 0, limit: 30 }
      const state = { listInfos: { [source]: info }, source, sources: [source], maxPages: {} }
      const api = load(`src/core/search/${kind}.ts`, {
        [`@/store/search/${kind}/state`]: { default: state },
        [`@/store/search/${kind}/action`]: {
          default: {
            setSearchText: value => { state.searchText = value },
            setSource: value => { state.source = value },
            setListInfo: result => { info.list = result.list; return info.list },
            clearListInfo() {},
          },
        },
        '@/utils/musicSdk': { default: { [source]: { [kind === 'music' ? 'musicSearch' : 'songList']: provider } } },
        './cache': { restoreSearchResult: async() => false, invalidateSearchResult() {} },
        './request': load('src/core/search/request.ts'),
      })
      const old = api.search('old', 1, source)
      await flush()
      assert.equal(h.calls.length, 1)
      const fresh = api.search('fresh', 1, source)
      await flush()
      assert.equal(await old, null, 'cancellation finishes the caller even with a native request still pending')
      assert.equal(h.cancelled(), 1)
      assert.equal(h.calls.length, 2)
      h.calls[1].gate.resolve(emptyResponse(source, kind))
      assert.equal((await fresh).length, 0)
      h.calls[0].gate.resolve({ code: -1, error_code: 999 })
      await flush()
      assert.equal(h.calls.length, 2)
      assert.equal(h.bodiesRead(), 1)
      assert.equal(provider.requestSignal, undefined, 'the singleton SDK never carries a consumer cancellation signal')
      assert.equal(h.timers.size, 0)
    })
  }
}

const playlist = () => {
  const h = transport()
  const converted = []
  const provider = {
    getListDetail(id, page) {
      return h.http.httpFetch(`https://fixture.test/list/${id}/${page}`, {}, this.requestSignal).promise.then(({ body }) => body)
    },
  }
  const api = load('src/core/songlist.ts', {
    '@/store/songlist/action': {},
    '@/utils': { deduplicationList: value => value, toNewMusicInfo: value => { converted.push(value.id); return value } },
    '@/utils/musicSdk': { default: { mg: { songList: provider } } },
  })
  const page = (number, total = 300) => ({
    list: Array.from({ length: 30 }, (_, index) => ({ id: String((number - 1) * 30 + index) })),
    limit: 30,
    total,
    source: 'mg',
    info: { name: 'Fixture' },
  })
  return { ...h, api, converted, page }
}

test('cancelling a ten-page playlist stops after the current page and keeps completed pages reusable', async t => {
  const h = playlist(); const controller = new AbortController()
  const loading = h.api.getListDetailAll('mg', 'list', false, controller.signal)
  const rejected = assert.rejects(loading, /取消http请求/)
  await flush()
  h.calls[0].gate.resolve(h.page(1))
  await flush()
  assert.equal(h.calls.length, 2)
  controller.abort()
  await rejected
  h.calls[1].gate.resolve(h.page(2))
  await flush()
  assert.equal(h.calls.length, 2)
  assert.equal(h.cancelled(), 1)
  assert.equal(h.converted.length, 30)
  assert.equal((await h.api.getListDetail('list', 'mg', 1)).list.length, 30)
  assert.equal(h.calls.length, 2)
  t.diagnostic('source_pages_started=2 of 10, cancelled_http=1, normalized_rows=30')
})

test('one cancelled playlist consumer leaves the shared page available to another consumer', async() => {
  const h = playlist(); const controller = new AbortController()
  const hidden = h.api.getListDetail('shared', 'mg', 1, false, controller.signal)
  const rejected = assert.rejects(hidden, /取消http请求/)
  const visible = h.api.getListDetail('shared', 'mg', 1)
  await flush()
  assert.equal(h.calls.length, 1)
  controller.abort()
  await rejected
  assert.equal(h.cancelled(), 0)
  h.calls[0].gate.resolve(h.page(1, 30))
  assert.equal((await visible).list.length, 30)
  assert.equal(h.calls.length, 1)
})

test('a last cancelled playlist consumer cannot block a reopened page or publish its late rows', async() => {
  const h = playlist(); const controller = new AbortController()
  const old = h.api.getListDetail('shared', 'mg', 1, false, controller.signal)
  const rejected = assert.rejects(old, /取消http请求/)
  await flush()
  controller.abort()
  await rejected
  const current = h.api.getListDetail('shared', 'mg', 1)
  await flush()
  assert.equal(h.calls.length, 2)
  h.calls[0].gate.resolve(h.page(1, 30))
  await flush()
  assert.equal(h.converted.length, 0)
  h.calls[1].gate.resolve(h.page(1, 30))
  assert.equal((await current).list.length, 30)
  assert.equal(h.converted.length, 30)
})

test('selection cancellation follows newer user intent while queue completion survives a pause', async() => {
  const h = await playbackHarness()
  const first = h.player.createPlaySelection()
  const next = h.player.createPlaySelection()
  assert.equal(first.signal.aborted, true)
  assert.equal(next.signal.aborted, false)
  await h.queue.replacePlayQueue('library', [song('A')])
  const queueSignal = h.player.getPlayQueueSignal()
  await h.player.pause()
  assert.equal(next.signal.aborted, true)
  assert.equal(queueSignal.aborted, false)
  await h.queue.replacePlayQueue('new', [song('B')])
  assert.equal(queueSignal.aborted, true)
  const currentSignal = h.player.getPlayQueueSignal()
  await h.queue.clearPlayQueue()
  assert.equal(currentSignal.aborted, true)
})

for (const kind of ['songlist', 'deeplink']) {
  test(`${kind}: replacing its committed queue cancels full pagination through the actual entry point`, async() => {
    const h = playlist(); const player = await playbackHarness()
    const dependencies = {
      '@/config/constant': constants,
      '@/core/list': { setTempList: async(id, songs) => { player.lists[constants.LIST_IDS.TEMP] = songs } },
      '@/core/player/player': player.player,
      '@/core/songlist': h.api,
      '@/core/qqMusic': {},
      '@/core/qqMusicFavorite': {},
      '@/utils/tools': {},
      '@/store/songlist/state': { default: {} },
    }
    const entry = load(kind === 'songlist' ? 'src/screens/SonglistDetail/listAction.ts' : 'src/core/init/deeplink/playSonglist.ts', dependencies)
    const loading = kind === 'songlist' ? entry.handlePlay('fixture', 'mg') : entry.playSonglist('mg', 'fixture')
    await flush()
    const first = h.page(1)
    first.list = first.list.map(item => song(item.id))
    h.calls[0].gate.resolve(first)
    await flush()
    assert.equal(h.calls.length, 2)
    await player.queue.replacePlayQueue('replacement', [song('replacement')])
    await loading
    assert.equal(h.cancelled(), 1)
    h.calls[1].gate.resolve(h.page(2))
    await flush()
    assert.equal(h.calls.length, 2)
    assert.equal(player.queue.getPlayQueue()[0].musicInfo.id, 'replacement')
  })
}
