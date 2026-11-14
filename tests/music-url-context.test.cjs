const { test } = require('node:test')
const assert = require('node:assert/strict')
const { load, deferred, flush } = require('./helpers/load.cjs')

const order = load('src/utils/apiSourceOrder.ts')
const cacheContext = load('src/utils/musicUrlCache.ts', { './apiSourceOrder': order })
const constants = load('src/config/constant.ts')
const message = load('src/utils/message.ts')
const song = { id: 'tx_song', source: 'tx', name: 'Song', singer: 'Singer', interval: '03:00', meta: { _qualitys: { '128k': {}, '320k': {}, flac: {} } } }

const harness = ({ request = async(id, music, quality) => ({ url: `https://audio.test/${id}`, type: quality }), account = async() => null, cacheWriteGate } = {}) => {
  const values = new Map(); const requests = []; const accountRequests = []
  const setting = {
    'common.apiSource': 'user_api_A',
    'common.apiSourceOrder': '["user_api_A","user_api_B"]',
    'player.playQuality': '128k',
    'player.urlSource': 'source',
    'player.noVipStandardQuality': false,
  }
  const appGlobal = { lx: { qualityList: { tx: ['128k'] } }, i18n: { t: key => key } }
  const storage = cacheWriteGate ? load('src/plugins/storage.ts', {
    '@react-native-async-storage/async-storage': {
      default: {
        getItem: async key => values.has(key) ? JSON.stringify(values.get(key)) : null,
        multiGet: async keys => keys.map(key => [key, values.has(key) ? JSON.stringify(values.get(key)) : null]),
        multiSet: async entries => { await cacheWriteGate.promise; for (const [key, value] of entries) values.set(key, JSON.parse(value)) },
        multiRemove: async keys => { for (const key of keys) values.delete(key) },
      },
    },
    '@/utils/log': { log: { error() {} } },
  }) : {
    getData: async key => values.get(key),
    saveData: async(key, value) => { values.set(key, structuredClone(value)) },
    getDataMultiple: async keys => keys.map(key => [key, values.get(key)]),
    removeDataMultiple: async keys => { for (const key of keys) values.delete(key) },
  }
  const data = load('src/utils/data.ts', {
    '@/plugins/storage': storage,
    '@/config/constant': constants,
    './legacyList': {},
    './common': { throttle: fn => fn },
    './nativeModules/secureStorage': {},
  })
  const qq = { validateQQMusicUrl: async() => {}, getQQMusicUrlByAccount: async(...args) => { accountRequests.push(args); return account(...args) } }
  const priority = load('src/core/music/sourcePriority.ts', {
    '@/store/setting/state': { default: { setting } },
    '@/store/userApi': { state: { list: ['user_api_A', 'user_api_B'].map(id => ({ id })) } },
    '@/utils/apiSourceOrder': order,
    '@/utils/message': message,
    '@/core/qqMusicUrl': qq,
    '@/core/userApiRuntime': { requestUserApiMusicUrl: async(...args) => { requests.push(args); return request(...args) } },
  }, { global: appGlobal })
  const pipeline = load('src/core/music/utils.ts', {
    '@/utils/musicUrlCache': cacheContext,
    '@/utils/musicSdk': {},
    '@/utils/data': data,
    '@/utils': {},
    '@/store/setting/state': { default: { setting } },
    '@/utils/message': message,
    'react-native-background-timer': { default: { setTimeout, clearTimeout } },
    '@/utils/musicSdk/api-source': {},
    '@/core/qqMusicUrl': qq,
    '@/config/constant': constants,
    './sourcePriority': priority,
  }, { global: appGlobal })
  const online = load('src/core/music/online.ts', {
    '@/utils/musicUrlCache': cacheContext,
    '@/utils/data': data,
    '@/core/list': {},
    '@/store/setting/state': { default: { setting } },
    '@/utils/message': message,
    '@/core/qqMusicUrl': qq,
    './utils': pipeline,
    './sourcePriority': priority,
  }, { global: appGlobal })
  const download = load('src/core/music/download.ts', { './online': online, './utils': {} })
  return {
    values,
    setting,
    requests,
    accountRequests,
    data,
    pipeline,
    global: appGlobal,
    resolve: options => online.getMusicUrl({ musicInfo: song, isRefresh: false, allowToggleSource: false, ...options }),
    resolveDownload: options => download.getMusicUrl({
      musicInfo: { metadata: { musicInfo: song } },
      isRefresh: false,
      allowToggleSource: false,
      ...options,
    }),
  }
}

test('unchanged source selection reuses a URL, but a new order and an empty selection do not', async() => {
  const h = harness()
  assert.equal(await h.resolve(), 'https://audio.test/user_api_A')
  assert.equal(await h.resolve(), 'https://audio.test/user_api_A')
  assert.equal(h.requests.length, 1)
  h.setting['common.apiSource'] = 'user_api_B'
  h.setting['common.apiSourceOrder'] = '["user_api_B","user_api_A"]'
  assert.equal(await h.resolve(), 'https://audio.test/user_api_B')
  h.setting['common.apiSource'] = ''
  h.setting['common.apiSourceOrder'] = '[]'
  await assert.rejects(h.resolve(), /toggle_source_failed/)
  assert.equal(h.requests.length, 2)
})

test('legacy URLs without source metadata are refreshed once and remain clearable by song', async() => {
  const h = harness()
  h.values.set(`${constants.storageDataPrefix.musicUrl}${song.id}_128k`, 'https://audio.test/unknown-old-source')
  assert.equal(await h.resolve(), 'https://audio.test/user_api_A')
  assert.equal(await h.resolve(), 'https://audio.test/user_api_A')
  assert.equal(h.requests.length, 1)
  assert.equal(await h.data.hasMusicUrlByMusic(song), true)
  await h.data.clearMusicUrlByMusic(song)
  assert.equal(await h.data.hasMusicUrlByMusic(song), false)
})

test('source-only resolution does not reuse a cached account URL', async() => {
  const h = harness({ account: async() => ({ quality: '128k', url: 'https://audio.test/account' }) })
  h.setting['player.urlSource'] = 'account'
  assert.equal(await h.resolve(), 'https://audio.test/account')
  assert.equal(await h.resolve({ urlSourceOrder: 'sourceOnly' }), 'https://audio.test/user_api_A')
  assert.equal(h.accountRequests.length, 1)
})

test('a late old-source response cannot overwrite the cache populated by the new selection', async() => {
  const old = deferred()
  const h = harness({ request: async(id, music, type) => id === 'user_api_A' ? old.promise : { url: 'https://audio.test/B', type } })
  const pending = h.resolve()
  await flush()
  h.setting['common.apiSource'] = 'user_api_B'
  h.setting['common.apiSourceOrder'] = '["user_api_B"]'
  assert.equal(await h.resolve(), 'https://audio.test/B')
  old.resolve({ url: 'https://audio.test/A', type: '128k' })
  await pending
  assert.equal(await h.resolve(), 'https://audio.test/B')
  assert.equal(h.requests.length, 2)
})

for (const primary of [undefined, ['128k']]) {
  test(`account FLAC playback is independent of ${primary ? 'a standard-only primary script' : 'having no script'}`, async() => {
    const h = harness({ account: async(music, quality) => ({ url: `https://audio.test/account-${quality}`, quality }) })
    h.setting['player.playQuality'] = 'flac'
    h.setting['player.urlSource'] = 'account'
    h.global.lx.qualityList = primary ? { tx: primary } : {}
    if (!primary) { h.setting['common.apiSource'] = ''; h.setting['common.apiSourceOrder'] = '[]' }
    assert.equal(await h.resolve(), 'https://audio.test/account-flac')
    assert.deepEqual(h.accountRequests.map(([, preferred, max]) => [preferred, max]), [['flac', 'flac']])
    assert.equal(await h.resolve(), 'https://audio.test/account-flac')
    assert.equal(h.accountRequests.length, 1)
  })
}

test('the explicit standard-quality account limit still applies', async() => {
  const h = harness({ account: async(music, quality) => ({ url: `https://audio.test/account-${quality}`, quality }) })
  Object.assign(h.setting, { 'player.playQuality': 'flac', 'player.urlSource': 'account', 'player.noVipStandardQuality': true })
  assert.equal(await h.resolve(), 'https://audio.test/account-128k')
  assert.equal(h.accountRequests[0][2], '128k')
})

test('a 320k playback request reuses the account standard-quality result without another ticket', async() => {
  const h = harness({ account: async(music, quality) => ({ url: `https://audio.test/account-${quality}`, quality }) })
  Object.assign(h.setting, { 'player.playQuality': '320k', 'player.urlSource': 'account', 'player.noVipStandardQuality': true })
  assert.equal(await h.resolve(), 'https://audio.test/account-128k')
  assert.equal(await h.resolve(), 'https://audio.test/account-128k')
  assert.equal(h.accountRequests.length, 1)
  const context = cacheContext.getMusicUrlCacheContext(h.setting)
  assert.equal(await h.data.getMusicUrl(song, '128k', context), 'https://audio.test/account-128k')
  assert.equal(await h.data.getMusicUrl(song, '320k', context), '')
  assert.equal(h.values.get(`${constants.storageDataPrefix.musicUrl}${song.id}_320k`).actualQuality, '128k')
})

test('a script downgrade is reusable for playback while an exact download must request its own quality', async() => {
  const h = harness({
    request: async(id, music, quality, onCancel, allowFallback) => ({
      url: `https://audio.test/${id}-${allowFallback ? '128k' : quality}`, type: allowFallback ? '128k' : quality,
    }),
  })
  h.setting['player.playQuality'] = '320k'
  assert.equal(await h.resolve(), 'https://audio.test/user_api_A-128k')
  assert.equal(await h.resolve(), 'https://audio.test/user_api_A-128k')
  assert.equal(h.requests.length, 1)
  assert.equal(await h.resolveDownload({ quality: '128k' }), 'https://audio.test/user_api_A-128k')
  assert.equal(h.requests.length, 1)
  assert.equal(await h.resolveDownload({ quality: '320k' }), 'https://audio.test/user_api_A-320k')
  assert.equal(h.requests.length, 2)
  assert.equal(h.requests[1][4], false)
})

test('an account downgrade does not satisfy an explicit higher-quality download', async() => {
  const h = harness({ account: async(music, quality) => ({ url: `https://audio.test/account-${quality}`, quality }) })
  Object.assign(h.setting, { 'player.playQuality': '320k', 'player.urlSource': 'account', 'player.noVipStandardQuality': true })
  await h.resolve()
  assert.equal(await h.resolveDownload({ quality: '320k' }), 'https://audio.test/account-320k')
  assert.equal(h.accountRequests.length, 2)
  assert.equal(h.accountRequests[1][3].allowQualityFallback, false)
})

test('an unavailable exact download rejects instead of accepting its playback downgrade', async() => {
  const h = harness({
    request: async(id, music, quality, onCancel, allowFallback) => {
      if (!allowFallback) throw new Error('Unsupported music quality')
      return { url: 'https://audio.test/standard', type: '128k' }
    },
  })
  h.setting['player.playQuality'] = '320k'
  await h.resolve()
  await assert.rejects(h.resolveDownload({ quality: '320k' }), /toggle_source_failed/)
  assert.equal(h.requests.length, 3)
})

test('downgrade mappings are invalidated by account limits, source order and strategy changes', async() => {
  const account = harness({ account: async(music, quality) => ({ url: `https://audio.test/account-${quality}`, quality }) })
  Object.assign(account.setting, { 'player.playQuality': '320k', 'player.urlSource': 'account', 'player.noVipStandardQuality': true })
  await account.resolve()
  account.setting['player.noVipStandardQuality'] = false
  assert.equal(await account.resolve(), 'https://audio.test/account-320k')
  assert.equal(account.accountRequests.length, 2)

  const source = harness({ request: async id => ({ url: `https://audio.test/${id}-128k`, type: '128k' }) })
  source.setting['player.playQuality'] = '320k'
  await source.resolve()
  source.setting['common.apiSource'] = 'user_api_B'
  source.setting['common.apiSourceOrder'] = '["user_api_B","user_api_A"]'
  assert.equal(await source.resolve(), 'https://audio.test/user_api_B-128k')
  assert.equal(await source.resolve({ urlSourceOrder: 'sourceOnly' }), 'https://audio.test/user_api_B-128k')
  assert.equal(source.requests.length, 3)
})

test('a late downgrade cannot replace the new source request-quality mapping', async() => {
  const old = deferred()
  const h = harness({ request: async id => id === 'user_api_A' ? old.promise : { url: 'https://audio.test/B-128k', type: '128k' } })
  h.setting['player.playQuality'] = '320k'
  const pending = h.resolve()
  await flush()
  h.setting['common.apiSource'] = 'user_api_B'
  h.setting['common.apiSourceOrder'] = '["user_api_B"]'
  assert.equal(await h.resolve(), 'https://audio.test/B-128k')
  old.resolve({ url: 'https://audio.test/A-128k', type: '128k' })
  await pending
  assert.equal(await h.resolve(), 'https://audio.test/B-128k')
  assert.equal(h.requests.length, 2)
})

test('an internal exact-quality fallback ignores a playback request-quality mapping', async() => {
  const h = harness({
    request: async(id, music, quality, onCancel, allowFallback) => ({
      url: `https://audio.test/${allowFallback ? '128k' : quality}`, type: allowFallback ? '128k' : quality,
    }),
  })
  h.setting['player.playQuality'] = '320k'
  await h.resolve()
  const result = await h.pipeline.getOnlineOtherSourceMusicUrl({
    musicInfos: [song],
    quality: '320k',
    isRefresh: false,
    onToggleSource() {},
  })
  assert.equal(result.url, 'https://audio.test/320k')
  assert.equal(result.quality, '320k')
  assert.equal(h.requests[1][4], false)
})

test('a second playback waits for a queued cache write without issuing another account ticket', async() => {
  const gate = deferred()
  const h = harness({ cacheWriteGate: gate, account: async(music, quality) => ({ url: `https://audio.test/account-${quality}`, quality }) })
  Object.assign(h.setting, { 'player.playQuality': '320k', 'player.urlSource': 'account', 'player.noVipStandardQuality': true })
  assert.equal(await h.resolve(), 'https://audio.test/account-128k')
  let finished = false
  const second = h.resolve().then(url => { finished = true; return url })
  await flush()
  assert.equal(h.accountRequests.length, 1)
  assert.equal(finished, false)
  gate.resolve()
  assert.equal(await second, 'https://audio.test/account-128k')
  assert.equal(h.accountRequests.length, 1)
})

test('a cache write failure does not reject a playable URL or leave an unhandled rejection', async() => {
  const gate = deferred()
  const h = harness({ cacheWriteGate: gate, account: async(music, quality) => ({ url: `https://audio.test/account-${quality}`, quality }) })
  Object.assign(h.setting, { 'player.playQuality': '320k', 'player.urlSource': 'account', 'player.noVipStandardQuality': true })
  assert.equal(await h.resolve(), 'https://audio.test/account-128k')
  gate.reject(new Error('Storage unavailable'))
  await flush()
  assert.equal(h.values.size, 0)
})
