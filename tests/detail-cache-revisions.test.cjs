const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load, deferred, flush } = require('./helpers/load.cjs')

const harness = () => {
  const values = new Map()
  let index = {}
  const data = {
    getBrowseDetailCache: async key => structuredClone(values.get(key) ?? null),
    saveBrowseDetailCache: async(key, value) => { values.set(key, structuredClone(value)) },
    getBrowseDetailCacheIndex: async() => ({ ...index }),
    saveBrowseDetailCacheIndex: async value => { index = { ...value } },
    removeBrowseDetailCaches: async(keys, { includePages = true } = {}) => {
      for (const stored of values.keys()) {
        if (keys.some(key => stored === key || (includePages && stored.startsWith(key + '::')))) values.delete(stored)
      }
    },
  }
  const restart = () => load('src/core/detailCache.ts', { '@/utils/data': data })
  return { api: restart(), data, values, restart }
}

for (const eviction of ['entry count', 'byte budget']) {
  test(`an old write cannot revive a newer snapshot rejected by the ${eviction}`, async() => {
    const h = harness(); const gate = deferred()
    const write = h.data.saveBrowseDetailCache
    let first = true
    h.data.saveBrowseDetailCache = async(key, value) => {
      if (first) { first = false; await gate.promise }
      await write(key, value)
    }
    h.api.saveDetailCache('group::first', { value: 'old' })
    await flush()
    if (eviction === 'entry count') {
      h.api.saveDetailCache('group::first', { value: 'fresh' })
      for (let i = 0; i < 33; i++) h.api.saveDetailCache(`group::page${i}`, { value: i })
    } else h.api.saveDetailCache('group::first', { value: 'large'.repeat(200000) })
    gate.resolve()
    assert.equal(await h.api.getDetailCache('group::first'), null)
    assert.equal(await h.restart().getDetailCache('group::first'), null)
  })
}

test('a successful newer write replaces an invalidated snapshot without deleting sibling pages', async() => {
  const h = harness(); const gate = deferred()
  h.api.saveDetailCache('group::sibling', { value: 'kept' })
  await h.api.getDetailCache('group::sibling')
  const write = h.data.saveBrowseDetailCache
  h.data.saveBrowseDetailCache = async(key, value) => {
    if (value.value === 'old') await gate.promise
    await write(key, value)
  }
  h.api.saveDetailCache('group::first', { value: 'old' })
  await flush()
  h.api.saveDetailCache('group::first', { value: 'large'.repeat(200000) })
  h.api.saveDetailCache('group::first', { value: 'latest' })
  gate.resolve()
  assert.equal((await h.api.getDetailCache('group::first')).value, 'latest')
  assert.equal((await h.api.getDetailCache('group::sibling')).value, 'kept')
})

test('a rejected snapshot stays invalid when cleanup fails and a later valid save can recover', async() => {
  const h = harness(); const gate = deferred()
  const write = h.data.saveBrowseDetailCache
  h.data.saveBrowseDetailCache = async(key, value) => { if (value.value === 'old') await gate.promise; await write(key, value) }
  h.data.removeBrowseDetailCaches = async keys => { if (keys.length) throw new Error('disk unavailable') }
  h.api.saveDetailCache('key', { value: 'old' })
  await flush()
  h.api.saveDetailCache('key', { value: 'large'.repeat(200000) })
  gate.resolve()
  assert.equal(await h.api.getDetailCache('key'), null)
  h.api.saveDetailCache('key', { value: 'recovered' })
  assert.equal((await h.api.getDetailCache('key')).value, 'recovered')
})

test('restoring 1600 singer songs cannot combine the refreshed pages with an obsolete first page', async() => {
  const h = harness(); const gate = deferred()
  let first = true
  const write = h.data.saveBrowseDetailCache
  h.data.saveBrowseDetailCache = async(key, value) => {
    if (first) { first = false; await gate.promise }
    await write(key, value)
  }
  const state = load('src/store/singer/state.ts')
  const utils = { toNewMusicInfo: value => value, deduplicationList: values => [...new Map(values.map(value => [value.id, value])).values()] }
  const actions = load('src/store/singer/action.ts', { './state': state, '@/utils': utils }, { setTimeout: () => 1 })
  let details = 0
  const page = (prefix, number) => ({
    list: Array.from({ length: 50 }, (_, i) => ({ id: `${prefix}-${number}-${i}`, name: prefix, source: 'tx', meta: { _qualitys: {} } })),
    total: 1600,
    allPage: 32,
    limit: 50,
    source: 'tx',
  })
  const api = load('src/core/singer.ts', {
    '@/store/singer/state': state,
    '@/store/singer/action': actions,
    '@/utils': utils,
    './detailCache': h.api,
    '@/utils/musicSdk': {
      default: {
        tx: {
          singer: {
            getDetail: async mid => ({ info: state.createSingerRecord(mid).info, songs: page(++details === 1 ? 'old' : 'fresh', 1) }),
            getSongs: async(mid, number) => page('fresh', number),
          },
        },
      },
    },
  })
  actions.retainSingerRecord('s')
  await api.getSingerDetail('s')
  await flush()
  await api.getSingerDetail('s', true)
  for (let number = 2; number <= 32; number++) await api.getSingerSongs('s', number)
  assert.equal(state.default.singers.s.songs.list.length, 1600)
  gate.resolve()
  await h.api.getDetailCache('singer_s')
  actions.releaseSingerRecord('s')
  actions.retainSingerRecord('s')
  const restored = await api.getSingerDetail('s')
  assert.equal(restored.songs.list[0].name, 'fresh')
  assert.ok(restored.songs.list.every(song => song.name === 'fresh'))
  await h.api.getDetailCache('singer_s')
})

for (const replacement of ['accepted', 'discarded', 'other key']) {
  test(`an in-flight cache read handles replacement mode: ${replacement}`, async() => {
    const h = harness(); const gate = deferred(); const started = deferred()
    h.api.saveDetailCache('group::page1', { value: 'old' })
    await h.api.getDetailCache('group::page1')
    const read = h.data.getBrowseDetailCache
    let held = false
    h.data.getBrowseDetailCache = async key => {
      const value = await read(key)
      if (key === 'group::page1' && !held) {
        held = true
        started.resolve()
        await gate.promise
      }
      return value
    }
    const reading = h.api.getDetailCache('group::page1')
    await started.promise
    h.api.saveDetailCache(replacement === 'other key' ? 'group::page2' : 'group::page1', {
      value: replacement === 'discarded' ? 'large'.repeat(200000) : 'new',
    })
    await h.api.getDetailCache('absent')
    gate.resolve()
    const result = await reading
    if (replacement === 'other key') assert.equal(result.value, 'old')
    else assert.equal(result, null)
    if (replacement === 'accepted') assert.equal((await h.api.getDetailCache('group::page1')).value, 'new')
  })
}
