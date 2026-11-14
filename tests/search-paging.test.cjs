const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load } = require('./helpers/load.cjs')

const harness = () => {
  const calls = []
  const pages = { kw: 1, tx: 3, wy: 4 }
  const failures = new Set()
  const empty = () => ({ page: 0, limit: 30, total: 0, list: [], key: null, maxPage: 0 })
  const state = {
    source: 'all',
    sources: ['all', ...Object.keys(pages)],
    searchText: '',
    maxPages: {},
    listInfos: Object.fromEntries(['all', ...Object.keys(pages)].map(source => [source, empty()])),
  }
  const actions = load('src/store/search/music/action.ts', {
    './state': { default: state },
    '@/utils/common': { sortInsert: (items, item) => items.push(item), similar: () => 1, arrPush: (items, next) => items.push(...next) },
    '@/utils': { toNewMusicInfo: value => value, deduplicationList: items => [...new Map(items.map(item => [item.id, item])).values()] },
  })
  const sdk = Object.fromEntries(Object.keys(pages).map(source => [source, {
    musicSearch: {
      search: async(text, page) => {
        calls.push(`${source}:${text}:${page}`)
        if (failures.has(source)) throw new Error(`${source} unavailable`)
        return { source, total: pages[source] * 30, limit: 30, allPage: pages[source], list: page > pages[source] ? [] : [{ id: `${source}-${text}-${page}`, name: text, singer: 'Artist' }] }
      },
    },
  }]))
  const api = load('src/core/search/music.ts', {
    '@/store/search/music/state': { default: state },
    '@/store/search/music/action': actions,
    '@/utils/musicSdk': { default: sdk },
    './cache': { restoreSearchResult: async() => false, invalidateSearchResult() {} },
    './request': load('src/core/search/request.ts'),
  })
  return { api, state, calls, failures, search: (page, text = 'song', refresh = false) => api.search(text, page, 'all', refresh) }
}

test('aggregate paging skips exhausted sources and keeps the remaining page limit', async() => {
  const h = harness()
  await h.search(1)
  await h.search(2)
  assert.deepEqual(h.calls.slice(3), ['tx:song:2', 'wy:song:2'])
  assert.equal(h.state.listInfos.all.maxPage, 4)
  await h.search(3)
  await h.search(4)
  assert.equal(h.calls.at(-1), 'wy:song:4')
  const count = h.calls.length
  const songs = await h.search(5)
  assert.equal(h.calls.length, count)
  assert.equal(songs.length, 8)
})

test('refresh and a new keyword ask every source again', async() => {
  const h = harness()
  await h.search(1)
  await h.search(2)
  await h.search(1, 'song', true)
  assert.deepEqual(h.calls.slice(-3), ['kw:song:1', 'tx:song:1', 'wy:song:1'])
  await h.search(1, 'new')
  assert.deepEqual(h.calls.slice(-3), ['kw:new:1', 'tx:new:1', 'wy:new:1'])
})

test('failure is not remembered as an exhausted source', async() => {
  const h = harness()
  h.failures.add('kw')
  await h.search(1)
  assert.equal(h.state.maxPages.kw, undefined)
  h.failures.delete('kw')
  await h.search(2)
  assert.ok(h.calls.includes('kw:song:2'))
})

test('a partially failing page keeps the failed source available on later pages', async() => {
  const h = harness()
  await h.search(1)
  h.failures.add('wy')
  await h.search(2)
  assert.equal(h.state.maxPages.wy, 4)
  assert.equal(h.state.listInfos.all.maxPage, 4)
  h.failures.delete('wy')
  await h.search(3)
  assert.ok(h.calls.includes('wy:song:3'))
})

test('failure of every remaining source preserves the current page for retry', async() => {
  const h = harness()
  await h.search(1)
  h.failures.add('tx')
  h.failures.add('wy')
  await assert.rejects(h.search(2), /unavailable/)
  assert.equal(h.state.listInfos.all.page, 1)
  h.failures.clear()
  await h.search(2)
  assert.equal(h.state.listInfos.all.page, 2)
})

test('reopening the same aggregate page reuses its in-memory result', async() => {
  const h = harness()
  const first = await h.search(1)
  const second = await h.search(1)
  assert.equal(first, second)
  assert.equal(h.calls.length, 3)
})
