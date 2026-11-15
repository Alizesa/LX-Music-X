const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load } = require('./helpers/load.cjs')

test('failed obsolete fragment cleanup retains a durable record and a restarted reader completes cleanup', async() => {
  const values = new Map(); let failCleanup = false
  const native = {
    getItem: async key => values.get(key) ?? null,
    multiGet: async keys => keys.map(key => [key, values.get(key) ?? null]),
    multiSet: async rows => { for (const [key, value] of rows) values.set(key, value) },
    multiRemove: async keys => { if (failCleanup) throw new Error('cleanup failed'); for (const key of keys) values.delete(key) },
    getAllKeys: async() => [...values.keys()],
  }
  const restart = () => load('src/plugins/storage.ts', {
    '@react-native-async-storage/async-storage': { default: native },
    '@/utils/log': { log: { error() {} } },
  })
  const api = restart()
  await api.saveData('songs', 'a'.repeat(600000))
  const oldParts = [...values.keys()].filter(key => key !== 'songs')
  failCleanup = true
  await api.saveData('songs', 'new')
  assert.ok(oldParts.every(key => values.has(key)))
  assert.ok([...values.keys()].some(key => key.startsWith('@___OBSOLETE_PARTS___')))
  assert.equal(await api.getData('songs'), 'new')
  failCleanup = false
  assert.equal(await restart().getData('songs'), 'new')
  assert.deepEqual([...values.keys()], ['songs'])
})

test('100 detail cache writes only enumerate 50000 history keys once and remove all evicted pages', async() => {
  const constants = load('src/config/constant.ts')
  const prefix = constants.storageDataPrefix.browseDetailCacheItem
  const values = new Map(Array.from({ length: 50000 }, (_, i) => [`history-${i}`, null]))
  values.set(constants.storageDataPrefix.browseDetailCacheIndex, { old: -3600000 })
  values.set(prefix + 'old', { value: 'expired' })
  values.set(prefix + 'old::page:1', { list: [1] })
  let enumerations = 0
  const data = load('src/utils/data.ts', {
    '@/config/constant': constants,
    './legacyList': {},
    './common': { throttle: fn => fn },
    './nativeModules/secureStorage': {},
    '@/plugins/storage': {
      getData: async key => structuredClone(values.get(key) ?? null),
      saveData: async(key, value) => { values.set(key, structuredClone(value)) },
      saveDataDirect: async(key, value) => { values.set(key, structuredClone(value)) },
      getAllKeys: async() => { enumerations++; return [...values.keys()] },
      removeDataMultiple: async keys => { for (const key of keys) values.delete(key) },
    },
  })
  let cacheTime = 1000
  const cache = load('src/core/detailCache.ts', { '@/utils/data': data }, { Date: { now: () => cacheTime++ } })
  for (let index = 0; index < 100; index++) {
    cache.saveDetailCache(`group-${index}::page:1`, { list: [index] })
    assert.ok(await cache.getDetailCache(`group-${index}::page:1`))
  }
  assert.equal(enumerations, 1)
  assert.equal(values.has(prefix + 'old'), false)
  assert.equal(values.has(prefix + 'old::page:1'), false)
  assert.equal(values.has(prefix + 'group-0::page:1'), false)
  assert.equal(values.has(prefix + 'group-99::page:1'), true)
  assert.equal(values.has('history-49999'), true)
})
