const { load, deferred, flush } = require('./load.cjs')

const sources = ['kw', 'kg', 'tx', 'wy', 'mg']
const bodies = {
  kw: { TOTAL: '0', SHOW: '0', abslist: [] },
  kg: { error_code: 0, data: { lists: [], total: 0 } },
  wy: { code: 200, data: { resources: [], totalCount: 0 } },
  mg: { code: '000000', songResultData: { resultList: [], totalCount: 0 } },
  tx: { code: 0, 'music.search.SearchCgiService': { code: 0, data: { body: { song: { list: [] } }, meta: { sum: 0 } } } },
}
const song = source => ({ id: 'matching', name: 'Song', singer: 'Singer', source: source ?? 'kw', interval: '03:00', meta: { albumName: 'Album' } })

const harness = () => {
  let timerId = 0
  const timers = new Map()
  const clock = {
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id },
    clearTimeout: id => timers.delete(id),
    fire: delay => { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.fn() } },
  }
  const calls = []
  let cancelled = 0
  let parsed = 0
  const raw = load('src/utils/httpRequest.js', { 'react-native-background-timer': { default: clock } }, {
    global: {
      AbortController,
      fetch: (url, options) => {
        const pending = deferred()
        options.signal.addEventListener('abort', () => { cancelled++ })
        const source = url.includes('/tx') ? 'tx' : url.includes('kuwo') ? 'kw' : url.includes('kugou') ? 'kg' : url.includes('163.com') ? 'wy' : 'mg'
        calls.push({ source, url, options, pending })
        return pending.promise.then(body => ({ headers: { map: {} }, status: 200, ok: true, url, text: async() => { parsed++; return JSON.stringify(body) } }))
      },
    },
  })
  const http = load('src/utils/request.js', {
    './httpRequest': raw,
    './musicSdk/options': { bHh: '__fixture_signing' },
    './message': load('src/utils/message.ts'),
    pako: {},
  })
  const index = { decodeName: value => value, formatPlayTime: String, sizeFormate: String }
  const wy = load('src/utils/musicSdk/wy/utils/index.js', { '../../../request': http, './crypto': { eapi: () => ({}) } })
  const providers = {}
  for (const source of sources) {
    const search = load(`src/utils/musicSdk/${source}/musicSearch.js`, {
      '../../request': http,
      '../../index': index,
      '../utils': { toMD5: String, formatSingerName: () => '' },
      './util': { formatSinger: value => value },
      './utils/index': wy,
      './utils': { comm: {}, signRequest: (data, endpoint, signal) => http.httpFetch('https://fixture.test/tx', { method: 'POST', headers: { 'content-type': 'application/json' }, body: data }, signal).promise },
    }, { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout }).default
    providers[source] = { default: { musicSearch: search, getPic: async() => { throw new Error('no picture') }, getLyric: () => ({ promise: Promise.reject(new Error('no lyric')), cancelHttp() {} }) } }
  }
  const sdk = load('src/utils/musicSdk/index.js', {
    './kw': providers.kw,
    './kg': providers.kg,
    './tx': providers.tx,
    './wy': providers.wy,
    './mg': providers.mg,
    './versionChars': load('src/utils/musicSdk/versionChars.ts'),
  })
  let converted = 0
  const data = { getMusicUrl: async() => null, getPlayerLyric: async() => ({ lyric: '' }) }
  const priority = { getEnabledMusicSourceIds: () => ['script'], getMusicUrlByPriority: async() => { throw new Error('source failed') }, isMusicUrlFailed: () => false }
  const setting = { 'player.playQuality': '128k', 'player.urlSource': 'source', 'player.isS2t': false }
  const api = load('src/core/music/utils.ts', {
    '@/utils/musicSdk': sdk,
    '@/utils/data': data,
    '@/utils': { toNewMusicInfo: value => { converted++; return value }, toOldMusicInfo: value => value },
    '@/store/setting/state': { default: { setting } },
    '@/utils/message': load('src/utils/message.ts'),
    'react-native-background-timer': { default: clock },
    '@/utils/musicSdk/api-source': { apis: () => ({ getMusicUrl: () => ({ promise: Promise.reject(new Error('local unavailable')) }) }) },
    '@/core/qqMusicUrl': {},
    '@/config/constant': {},
    './sourcePriority': priority,
    '@/utils/musicUrlCache': { getMusicUrlCacheContext: () => 'fixture' },
  }, { global: { lx: { apiInitPromise: [Promise.resolve(true)] }, i18n: { t: key => key } } })
  const local = load('src/core/music/local.ts', {
    './utils': api,
    '@/utils/data': data,
    '@/core/list': {},
    '@/utils/music': { getLocalFilePath: async() => null },
    '@/utils/localMediaMetadata': {},
    '@/utils/fs': {},
    '@/utils/localMatchIndex': {},
    '@/core/localList': {},
    '@/config/constant': {},
    '@/utils/message': load('src/utils/message.ts'),
    './sourcePriority': priority,
    '@/utils/musicUrlCache': { getMusicUrlCacheContext: () => 'fixture' },
    '@/store/setting/state': { default: { setting } },
  })
  const finish = from => calls.slice(from ?? 0).forEach(call => call.pending.resolve(bodies[call.source]))
  return { api, local, sdk, providers, calls, timers, clock, data, priority, setting, cancelled: () => cancelled, parsed: () => parsed, converted: () => converted, finish, flush }
}

module.exports = { harness, song, bodies, load, deferred, flush }
