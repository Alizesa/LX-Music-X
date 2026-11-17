const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load } = require('./helpers/load.cjs')

// Exercise the installed JS request coalescer; native SQL rejects more than 999 IN keys.
const harness = () => {
  const values = new Map()
  const reads = []; const removals = []; const writes = []
  const faults = { read: null, remove: null, write: null }
  const respond = (callback, problem, run) => {
    queueMicrotask(() => {
      if (problem) callback([{ message: problem }])
      else callback(null, run())
    })
  }
  const bridge = {
    multiGet: (keys, callback) => {
      reads.push([...keys])
      const problem = keys.length > 999 ? 'too many SQL variables' : faults.read?.(keys, reads.length)
      respond(callback, problem, () => keys.map(key => [key, values.get(key) ?? null]))
    },
    multiSet: (rows, callback) => {
      writes.push(rows.map(row => [...row]))
      respond(callback, faults.write?.(rows, writes.length), () => { for (const [key, value] of rows) values.set(key, value) })
    },
    multiRemove: (keys, callback) => {
      removals.push([...keys])
      const problem = keys.length > 999 ? 'too many SQL variables' : faults.remove?.(keys, removals.length)
      respond(callback, problem, () => { for (const key of keys) values.delete(key) })
    },
    getAllKeys: callback => respond(callback, null, () => [...values.keys()]),
    clear: callback => respond(callback, null, () => values.clear()),
  }
  const native = load('node_modules/@react-native-async-storage/async-storage/src/AsyncStorage.native.ts', {
    './helpers': load('node_modules/@react-native-async-storage/async-storage/src/helpers.ts'),
    './RCTAsyncStorage': { default: bridge },
  }, { setImmediate }).default
  const restart = () => load('src/plugins/storage.ts', {
    '@react-native-async-storage/async-storage': { default: native },
    '@/utils/log': { log: { error() {} } },
  })
  const api = restart()
  const constants = load('src/config/constant.ts')
  const data = load('src/utils/data.ts', {
    '@/plugins/storage': api,
    '@/config/constant': constants,
    './legacyList': {},
    './common': { throttle: () => () => {} },
    './nativeModules/secureStorage': {},
  })
  return { api, native, data, values, reads, removals, writes, faults, restart, constants }
}

const seedFragments = (h, key, count, marker = '@___PART_A___') => {
  const parts = Array.from({ length: count }, (_, index) => key + '/part-' + index)
  const json = JSON.stringify('x'.repeat(count - 2))
  for (let index = 0; index < parts.length; index++) h.values.set(parts[index], json[index])
  h.values.set(key, marker + (marker === '@___PART___' ? parts.join(',') : JSON.stringify(parts)))
  return parts
}
const assertBounded = h => {
  assert.ok(h.reads.every(keys => keys.length <= 500), 'oversized read query')
  assert.ok(h.removals.every(keys => keys.length <= 500), 'oversized delete query')
}

test('several thousand cached URLs clear through the settings data path and preserve user data', async() => {
  const h = harness()
  const prefix = h.constants.storageDataPrefix.musicUrl
  const keys = Array.from({ length: 2501 }, (_, index) => prefix + index)
  for (const key of keys) h.values.set(key, JSON.stringify({ url: 'https://fixture/audio' }))
  const parts = seedFragments(h, keys[500], 4)
  h.values.set('user-playlist', '[1,2]')
  h.values.set('download-history', '[3,4]')
  await h.data.clearMusicUrl()
  assert.deepEqual([...h.values], [['user-playlist', '[1,2]'], ['download-history', '[3,4]']])
  assert.ok([...keys, ...parts].every(key => !h.values.has(key)))
  assertBounded(h)
})

test('concurrent small reads cannot be coalesced back into a query exceeding the SQL limit', async() => {
  const h = harness()
  const groups = Array.from({ length: 4 }, (_, group) => Array.from({ length: 400 }, (_, index) => 'group-' + group + '/' + index))
  for (const keys of groups) for (const key of keys) h.values.set(key, JSON.stringify(key))
  const results = await Promise.all(groups.map(keys => h.api.getDataMultiple(keys)))
  results.forEach((rows, index) => assert.deepEqual(Array.from(rows, row => Array.from(row)), groups[index].map(key => [key, key])))
  assert.equal(h.reads.length, 4)
  assertBounded(h)
})

test('large batch reads preserve order, duplicate keys and missing entries', async() => {
  const h = harness()
  const keys = Array.from({ length: 1503 }, (_, index) => 'cache-' + index)
  for (const key of keys) h.values.set(key, JSON.stringify(key))
  keys.splice(499, 0, 'missing', keys[0])
  const rows = await h.api.getDataMultiple(keys)
  assert.deepEqual(Array.from(rows, row => Array.from(row)), keys.map(key => [key, key === 'missing' ? null : key]))
  assertBounded(h)
})

for (const marker of ['@___PART___', '@___PART_A___']) {
  test(marker + ' fragmented values read across SQL batches without changing their content', async() => {
    const h = harness()
    seedFragments(h, 'large', 1103, marker)
    assert.equal(await h.api.getData('large'), 'x'.repeat(1101))
    assertBounded(h)
  })
}

test('large replacements bound the previous-value read and keep the new write atomic', async() => {
  const h = harness()
  const rows = Array.from({ length: 1503 }, (_, index) => ['cache-' + index, index])
  for (const [key] of rows) h.values.set(key, JSON.stringify('old'))
  await h.api.saveDataMultiple(rows)
  assert.equal(h.writes.length, 1)
  assert.equal(h.writes[0].length, rows.length)
  assert.ok(rows.every(([key, value]) => h.values.get(key) === JSON.stringify(value)))
  h.faults.write = () => 'disk full'
  await assert.rejects(h.api.saveDataMultiple(rows.map(([key]) => [key, 'replacement'])), /disk full/)
  assert.ok(rows.every(([key, value]) => h.values.get(key) === JSON.stringify(value)))
  assertBounded(h)
})

test('direct record deletion also stays below the SQL limit without reading record bodies', async() => {
  const h = harness()
  const keys = Array.from({ length: 2003 }, (_, index) => 'history-' + index)
  for (const key of keys) h.values.set(key, '1')
  h.values.set('retained', '2')
  await h.api.removeDataMultipleDirect(keys)
  assert.deepEqual([...h.values], [['retained', '2']])
  assert.equal(h.reads.length, 0)
  assertBounded(h)
})

test('a failed deletion batch leaves remaining logical values and their fragments intact for retry', async() => {
  const h = harness()
  const keys = Array.from({ length: 400 }, (_, index) => 'lyric-' + index)
  const groups = keys.map(key => [key, ...seedFragments(h, key, 3)])
  h.faults.remove = (_keys, count) => count === 2 ? 'delete unavailable' : null
  await assert.rejects(h.api.removeDataMultiple(keys), /delete unavailable/)
  for (const group of groups) {
    const remaining = group.filter(key => h.values.has(key)).length
    assert.ok(remaining === 0 || remaining === group.length, 'a logical value lost only some fragments')
  }
  h.faults.remove = null
  await h.api.removeDataMultiple(keys)
  assert.equal(h.values.size, 0)
  assertBounded(h)
})

test('interrupted deletion of an oversized fragmented value retains its index for retry after restart', async() => {
  const h = harness()
  const parts = seedFragments(h, 'large-cache', 1103)
  h.values.set('retained', '1')
  h.faults.remove = (_keys, count) => count === 2 ? 'delete unavailable' : null
  await assert.rejects(h.api.removeData('large-cache'), /delete unavailable/)
  assert.ok(h.values.has('large-cache'))
  assert.ok(parts.some(key => !h.values.has(key)))
  h.faults.remove = null
  await h.restart().removeData('large-cache')
  assert.deepEqual([...h.values], [['retained', '1']])
  assertBounded(h)
})

test('a replacement after an interrupted oversized deletion cannot be removed by late cleanup', async() => {
  const h = harness()
  const parts = seedFragments(h, 'large-cache', 1103)
  h.faults.remove = (_keys, count) => count === 2 ? 'delete unavailable' : null
  await assert.rejects(h.api.removeData('large-cache'), /delete unavailable/)
  h.faults.remove = null
  await h.api.saveData('large-cache', 'replacement')
  assert.equal(await h.restart().getData('large-cache'), 'replacement')
  assert.ok(parts.every(key => !h.values.has(key)))
  assert.deepEqual([...h.values], [['large-cache', JSON.stringify('replacement')]])
  assertBounded(h)
})

test('large obsolete-fragment cleanup retains its journal on a later batch failure and never removes the replacement', async() => {
  const h = harness()
  const parts = seedFragments(h, 'large-cache', 1103)
  h.faults.remove = (_keys, count) => count === 2 ? 'delete unavailable' : null
  await h.api.saveData('large-cache', 'new value')
  assert.equal(h.values.get('large-cache'), JSON.stringify('new value'))
  assert.ok([...h.values.keys()].some(key => key.startsWith('@___OBSOLETE_PARTS___')))
  h.faults.remove = null
  assert.equal(await h.restart().getData('large-cache'), 'new value')
  assert.ok(parts.every(key => !h.values.has(key)))
  assert.deepEqual([...h.values], [['large-cache', JSON.stringify('new value')]])
  assertBounded(h)
})
