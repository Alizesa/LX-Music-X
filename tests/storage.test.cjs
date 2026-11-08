const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load, deferred, flush } = require('./helpers/load.cjs')

const harness = () => {
  const values = new Map()
  const native = {
    getItem: async key => values.get(key) ?? null,
    multiGet: async keys => keys.map(key => [key, values.get(key) ?? null]),
    setItem: async(key, value) => { values.set(key, value) },
    // Match Android's transactional multiSet: all keys commit together.
    multiSet: async entries => { for (const [key, value] of entries) values.set(key, value) },
    multiRemove: async keys => { for (const key of keys) values.delete(key) },
    getAllKeys: async() => [...values.keys()],
    clear: async() => { values.clear() },
  }
  const api = load('src/plugins/storage.ts', {
    '@react-native-async-storage/async-storage': { default: native },
    '@/utils/log': { log: { error() {} } },
  })
  return { api, native, values }
}
const large = value => value.repeat(600000)

for (const previous of ['small', large('a')]) {
  test(`failed replacement preserves the previous ${previous.length > 100 ? 'fragmented' : 'small'} value`, async() => {
    const h = harness()
    await h.api.saveData('songs', previous)
    const saved = [...h.values]
    h.native.multiSet = async() => { throw new Error('disk full') }
    await assert.rejects(h.api.saveData('songs', large('b')), /disk full/)
    assert.equal(await h.api.getData('songs'), previous)
    assert.deepEqual([...h.values], saved)
  })
}

test('batch replacement failure preserves every old value', async() => {
  const h = harness()
  await h.api.saveDataMultiple([['one', large('a')], ['two', 'old']])
  const saved = [...h.values]
  h.native.multiSet = async() => { throw new Error('disk full') }
  await assert.rejects(h.api.saveDataMultiple([['one', 'new'], ['two', large('b')]]), /disk full/)
  assert.deepEqual([...h.values], saved)
})

test('successful replacement uses new fragments and removes obsolete fragments', async() => {
  const h = harness()
  await h.api.saveData('songs', large('a'))
  const oldParts = [...h.values.keys()].filter(key => key !== 'songs')
  await h.api.saveData('songs', large('b'))
  assert.equal(await h.api.getData('songs'), large('b'))
  assert.ok(oldParts.every(key => !h.values.has(key)))
  await h.api.saveData('songs', 'small again')
  assert.deepEqual([...h.values.keys()], ['songs'])
  assert.equal(await h.api.getData('songs'), 'small again')
})

for (const marker of ['@___PART___', '@___PART_A___']) {
  test(`${marker} legacy fragments remain readable and are removed only after replacement`, async() => {
    const h = harness()
    const parts = ['part-one', 'part-two']
    h.values.set('songs', marker + (marker === '@___PART___' ? parts.join(',') : JSON.stringify(parts)))
    h.values.set(parts[0], '["old ')
    h.values.set(parts[1], 'song"]')
    assert.equal((await h.api.getData('songs'))[0], 'old song')
    await h.api.saveData('songs', ['new song'])
    assert.equal((await h.api.getData('songs'))[0], 'new song')
    assert.deepEqual([...h.values.keys()], ['songs'])
  })
}

test('a reader retains its fragments until the complete value has been read', async() => {
  const h = harness()
  await h.api.saveData('songs', large('a'))
  const gate = deferred()
  const read = h.native.multiGet
  h.native.multiGet = async keys => {
    if (keys[0].startsWith('@___PART_A___')) await gate.promise
    return read(keys)
  }
  const reading = h.api.getData('songs')
  await flush()
  let replaced = false
  const writing = h.api.saveData('songs', large('b')).then(() => { replaced = true })
  await flush()
  assert.equal(replaced, false)
  gate.resolve()
  assert.equal(await reading, large('a'))
  await writing
  assert.equal(await h.api.getData('songs'), large('b'))
})

test('same-key failures release the queue while independent keys can still be read', async() => {
  const h = harness()
  const gate = deferred()
  h.native.multiSet = async() => gate.promise
  const failing = h.api.saveData('songs', ['new'])
  const rejected = assert.rejects(failing, /failure/)
  const next = h.api.saveDataDirect('songs', 'recovered')
  assert.equal(await h.api.getData('independent'), null)
  gate.reject(new Error('failure'))
  await rejected
  await next
  assert.equal(await h.api.getData('songs'), 'recovered')
})

test('deletion waits for a pending replacement and removes its new fragments', async() => {
  const h = harness()
  const gate = deferred()
  const commit = h.native.multiSet
  h.native.multiSet = async values => { await gate.promise; await commit(values) }
  const writing = h.api.saveData('songs', large('a'))
  const removing = h.api.removeData('songs')
  gate.resolve()
  await Promise.all([writing, removing])
  assert.equal(h.values.size, 0)
})

test('clear is ordered between earlier and later writes', async() => {
  const h = harness()
  const gate = deferred()
  const commit = h.native.multiSet
  h.native.multiSet = async values => { await gate.promise; await commit(values) }
  const writing = h.api.saveData('old', large('a'))
  const clearing = h.api.clearAll()
  const later = h.api.saveDataDirect('new', 'kept')
  gate.resolve()
  await Promise.all([writing, clearing, later])
  assert.deepEqual([...h.values.keys()], ['new'])
})

test('cleanup failure does not report a committed new value as a failed write', async() => {
  const h = harness()
  await h.api.saveData('songs', large('a'))
  h.native.multiRemove = async() => { throw new Error('cleanup unavailable') }
  await h.api.saveData('songs', ['new'])
  assert.equal((await h.api.getData('songs'))[0], 'new')
})
