const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load, deferred, flush } = require('./helpers/load.cjs')

const key = 'sdetail__kw__large'
const harness = (count, labelSize = 0) => {
  const rows = new Map(); let index = {}; let requests = 0; let online = true
  const writes = []
  const data = {
    getBrowseDetailCache: async key => structuredClone(rows.get(key) ?? null),
    saveBrowseDetailCache: async(key, value) => { writes.push(key); rows.set(key, structuredClone(value)) },
    getBrowseDetailCacheIndex: async() => ({ ...index }),
    saveBrowseDetailCacheIndex: async value => { index = { ...value } },
    removeBrowseDetailCaches: async(keys, { includePages = true } = {}) => {
      for (const stored of rows.keys()) {
        if (keys.some(key => stored === key || (includePages && stored.startsWith(key + '::')))) rows.delete(stored)
      }
    },
  }
  const cache = load('src/core/detailCache.ts', { '@/utils/data': data })
  const api = load('src/core/songlist.ts', {
    '@/store/songlist/action': { default: {} },
    '@/utils': { toNewMusicInfo: value => value, deduplicationList: value => value },
    '@/utils/musicSdk': {
      default: {
        kw: {
          songList: {
            getListDetail: async(id, page) => {
              if (!online) throw new Error('offline')
              requests++
              return { id, source: 'kw', list: Array.from({ length: count }, (_, i) => ({ id: 'song-' + i, name: 'request-' + requests + '-' + 'x'.repeat(labelSize) })), total: count, limit: count, info: {} }
            },
          },
        },
      },
    },
    './detailCache': cache,
  })
  return { api, cache, data, rows, writes, requests: () => requests, offline: () => { online = false } }
}

for (const [count, labelSize] of [[960, 0], [3000, 0], [3000, 800]]) {
  test('a released ' + count + '-song list restores every page offline (label size ' + labelSize + ')', async() => {
    const h = harness(count, labelSize)
    h.api.retainSonglistDetail('kw', 'large')
    await h.api.getListDetail('large', 'kw', 1)
    await h.cache.getDetailCache(key)
    const metadata = h.rows.get(key)
    assert.equal(metadata.pages.length, Math.ceil(count / 30))
    for (const page of metadata.pages) assert.ok(h.rows.has(key + '::page:' + page), 'missing page ' + page)
    h.api.releaseSonglistDetail('kw', 'large'); h.offline()
    h.api.retainSonglistDetail('kw', 'large')
    const songs = await h.api.getListDetailAll('kw', 'large')
    assert.equal(songs.length, count)
    assert.equal(songs[0].id, 'song-0')
    assert.equal(songs.at(-1).id, 'song-' + (count - 1))
    assert.equal(h.requests(), 1)
    h.api.releaseSonglistDetail('kw', 'large')
  })
}

test('the cursor is published only after the final page has reached storage', async() => {
  const h = harness(3000); const gate = deferred(); const started = deferred()
  const write = h.data.saveBrowseDetailCache
  h.data.saveBrowseDetailCache = async(key, value) => {
    if (key.endsWith('::page:100')) { started.resolve(); await gate.promise }
    await write(key, value)
  }
  h.api.retainSonglistDetail('kw', 'large')
  const loading = h.api.getListDetail('large', 'kw', 1)
  await started.promise
  assert.equal(h.rows.get(key) ?? null, null)
  assert.ok(h.rows.has(key + '::page:1'))
  gate.resolve(); await loading; await h.cache.getDetailCache(key)
  assert.equal(h.rows.get(key).pages.length, 100)
  h.api.releaseSonglistDetail('kw', 'large')
})

test('a failed page write cannot publish a cursor that names missing pages', async() => {
  const h = harness(3000)
  const write = h.data.saveBrowseDetailCache
  h.data.saveBrowseDetailCache = async(key, value) => {
    if (key.endsWith('::page:50')) throw new Error('disk unavailable')
    await write(key, value)
  }
  h.api.retainSonglistDetail('kw', 'large')
  const result = await h.api.getListDetail('large', 'kw', 1)
  await h.cache.getDetailCache(key)
  assert.equal(result.list.length, 30, 'a cache failure must not fail the provider response')
  assert.equal(h.rows.get(key) ?? null, null)
  h.api.releaseSonglistDetail('kw', 'large')
})

test('a refresh that overtakes a slow page write owns the final persisted cursor', async() => {
  const h = harness(960); const gate = deferred(); const started = deferred()
  const write = h.data.saveBrowseDetailCache
  let held = false
  h.data.saveBrowseDetailCache = async(key, value) => {
    if (key.endsWith('::page:1') && !held) { held = true; started.resolve(); await gate.promise }
    await write(key, value)
  }
  h.api.retainSonglistDetail('kw', 'large')
  const stale = h.api.getListDetail('large', 'kw', 1).catch(error => error)
  await started.promise
  const fresh = h.api.getListDetail('large', 'kw', 1, true)
  await flush(); gate.resolve(); await Promise.all([stale, fresh]); await h.cache.getDetailCache(key)
  assert.equal(h.requests(), 2)
  const cursor = h.rows.get(key)
  assert.equal(cursor.pages.length, 32)
  for (const page of cursor.pages) assert.ok(h.rows.has(key + '::page:' + page))
  h.api.releaseSonglistDetail('kw', 'large'); h.offline(); h.api.retainSonglistDetail('kw', 'large')
  const restored = await h.api.getListDetailAll('kw', 'large')
  assert.equal(restored.length, 960)
  assert.ok(restored.every(song => song.name.startsWith('request-2-')))
  h.api.releaseSonglistDetail('kw', 'large')
})


test('an oversized single page skips persistence without hanging the list response', async() => {
  const h = harness(30, 25000)
  h.api.retainSonglistDetail('kw', 'large')
  assert.equal((await h.api.getListDetail('large', 'kw', 1)).list.length, 30)
  await h.cache.getDetailCache(key)
  assert.equal(h.rows.has(key), false)
  h.api.releaseSonglistDetail('kw', 'large')
})
