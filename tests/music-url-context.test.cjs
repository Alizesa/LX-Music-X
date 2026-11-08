const { test } = require('node:test')
const assert = require('node:assert/strict')
const { load, deferred, flush } = require('./helpers/load.cjs')

const order = load('src/utils/apiSourceOrder.ts')
const cacheContext = load('src/utils/musicUrlCache.ts', { './apiSourceOrder': order })
const constants = load('src/config/constant.ts')
const message = load('src/utils/message.ts')
const song = { id: 'tx_song', source: 'tx', name: 'Song', singer: 'Singer', interval: '03:00', meta: { _qualitys: { '128k': {}, '320k': {}, flac: {} } } }

const harness = ({ request = async(id, music, quality) => ({ url: `https://audio.test/${id}`, type: quality }), account = async() => null } = {}) => {
  const values = new Map(), requests = [], accountRequests = []
  const setting = { 'common.apiSource': 'user_api_A', 'common.apiSourceOrder': '["user_api_A","user_api_B"]',
    'player.playQuality': '128k', 'player.urlSource': 'source', 'player.noVipStandardQuality': false }
  const appGlobal = { lx: { qualityList: { tx: ['128k'] } }, i18n: { t: key => key } }
  const data = load('src/utils/data.ts', {
    '@/plugins/storage': { getData: async key => values.get(key), saveData: async(key, value) => { values.set(key, structuredClone(value)) },
      getDataMultiple: async keys => keys.map(key => [key, values.get(key)]), removeDataMultiple: async keys => { for (const key of keys) values.delete(key) } },
    '@/config/constant': constants, './legacyList': {}, './common': { throttle: fn => fn }, './nativeModules/secureStorage': {},
  })
  const qq = { validateQQMusicUrl: async() => {}, getQQMusicUrlByAccount: async(...args) => { accountRequests.push(args); return account(...args) } }
  const priority = load('src/core/music/sourcePriority.ts', {
    '@/store/setting/state': { default: { setting } }, '@/store/userApi': { state: { list: ['user_api_A', 'user_api_B'].map(id => ({ id })) } },
    '@/utils/apiSourceOrder': order, '@/utils/message': message, '@/core/qqMusicUrl': qq,
    '@/core/userApiRuntime': { requestUserApiMusicUrl: async(...args) => { requests.push(args); return request(...args) } },
  }, { global: appGlobal })
  const pipeline = load('src/core/music/utils.ts', {
    '@/utils/musicUrlCache': cacheContext, '@/utils/musicSdk': {}, '@/utils/data': data, '@/utils': {},
    '@/store/setting/state': { default: { setting } }, '@/utils/message': message,
    'react-native-background-timer': { default: { setTimeout, clearTimeout } }, '@/utils/musicSdk/api-source': {},
    '@/core/qqMusicUrl': qq, '@/config/constant': constants, './sourcePriority': priority,
  }, { global: appGlobal })
  const online = load('src/core/music/online.ts', {
    '@/utils/musicUrlCache': cacheContext, '@/utils/data': data, '@/core/list': {}, '@/store/setting/state': { default: { setting } },
    '@/utils/message': message, '@/core/qqMusicUrl': qq, './utils': pipeline, './sourcePriority': priority,
  }, { global: appGlobal })
  return { values, setting, requests, accountRequests, data, global: appGlobal,
    resolve: options => online.getMusicUrl({ musicInfo: song, isRefresh: false, allowToggleSource: false, ...options }) }
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
