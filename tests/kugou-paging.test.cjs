const assert = require('node:assert/strict')
const { test } = require('node:test')
const { spawnSync } = require('node:child_process')
const { load, deferred, flush } = require('./helpers/load.cjs')

const song = id => ({ id, hash: id, source: 'kg', name: id })
const rows = (page, limit, total) => Array.from({ length: Math.max(0, Math.min(limit, total - (page - 1) * limit)) }, (_, i) => song(String((page - 1) * limit + i)))
const sdk = () => load('src/utils/musicSdk/kg/songList.js', {
  '../../request': {}, '../../index': { formatPlayCount: String }, './vendors/infSign.min': {}, './util': { signatureParams: () => 'signature' },
}).default
const core = provider => load('src/core/songlist.ts', {
  '@/store/songlist/action': {},
  '@/utils': { deduplicationList: items => items, toNewMusicInfo: item => item },
  '@/utils/musicSdk': { default: { kg: { songList: provider } } },
})

test('a large global-collection share loads one source page and reuses it across ten UI pages', async() => {
  const provider = sdk(); const pages = []; const converted = []; let infoReads = 0
  provider.createHttp = async() => { infoReads++; return { songcount: 9000, specialname: 'Songs' } }
  provider.getSongListDetailByGlobalSpecialId = async(id, page, limit) => { pages.push(page); return rows(page, limit, 9000) }
  provider.getMusicInfos = async list => { converted.push(list.length); return list }
  const api = core(provider)
  const id = 'https://m3ws.kugou.com/?global_collection_id=collection'
  const first = await api.getListDetail(id, 'kg', 1)
  assert.equal(first.list.length, 30)
  assert.equal(first.total, 9000)
  assert.deepEqual(pages, [1])
  assert.deepEqual(converted, [300])
  for (let page = 2; page <= 11; page++) {
    const result = await api.getListDetail(id, 'kg', page)
    assert.deepEqual(Array.from(result.list, item => item.id), rows(page, 30, 9000).map(item => item.id))
  }
  assert.deepEqual(pages, [1, 2])
  assert.equal(infoReads, 1)
})

test('global shares load the complete requested queue without duplicate pages and refresh their metadata', async() => {
  const provider = sdk(); const pages = []; let total = 675; let infoReads = 0
  provider.createHttp = async() => { infoReads++; return { songcount: total, specialname: 'Songs' } }
  provider.getSongListDetailByGlobalSpecialId = async(id, page, limit) => { pages.push(page); return rows(page, limit, total) }
  provider.getMusicInfos = async list => list
  const api = core(provider); const id = 'https://m3ws.kugou.com/?global_collection_id=complete'
  assert.deepEqual(Array.from(await api.getListDetailAll('kg', id), item => item.id), rows(1, 675, 675).map(item => item.id))
  assert.deepEqual(pages, [1, 2, 3])
  total = 2
  const refreshed = await api.getListDetail(id, 'kg', 1, true)
  assert.equal(refreshed.total, 2)
  assert.equal(refreshed.list.length, 2)
  assert.equal(infoReads, 2)
})

test('chain shares preserve source paging when a UI page spans two source responses', async() => {
  const provider = sdk(); const requested = []
  provider.createHttp = async url => {
    const page = Number(new URL(url).searchParams.get('page'))
    requested.push(page)
    return { info: [{ count: 125, name: 'Songs' }], list: { info: rows(page, 50, 125) } }
  }
  provider.getMusicInfos = async list => list
  const api = core(provider); const id = 'https://m3ws.kugou.com/?global_collection_id=chainid&chain=chainvalue'
  assert.equal((await api.getListDetail(id, 'kg', 1)).list.length, 30)
  assert.deepEqual(requested, [1])
  const all = await api.getListDetailAll('kg', id)
  assert.deepEqual(Array.from(all, item => item.id), rows(1, 125, 125).map(item => item.id))
  assert.deepEqual(requested, [1, 2, 3])
})

test('legacy share pages keep a fixed offset and reuse an already fetched matching response', async() => {
  const provider = sdk(); const requests = []
  provider.createHttp = async url => {
    const params = new URL(url).searchParams
    requests.push([Number(params.get('page')), Number(params.get('pagesize'))])
    return { list: { info: rows(Number(params.get('page')), Number(params.get('pagesize')), 205) } }
  }
  provider.getMusicInfos = async list => list
  const first = { info: [{ count: 205, name: 'Legacy' }], list: { info: rows(1, 90, 205) } }
  assert.equal((await provider.getUserListDetailByLink(first, 'https://fixture.test/zlist/list?page=1&pagesize=90', 1)).list.length, 90)
  assert.equal(requests.length, 0)
  const last = await provider.getUserListDetailByLink(first, 'https://fixture.test/zlist/list?page=1&pagesize=90', 3)
  assert.equal(last.total, 205)
  assert.deepEqual(Array.from(last.list, item => item.id), rows(3, 90, 205).map(item => item.id))
  assert.deepEqual(requests, [[3, 90]])
})

test('song-detail conversion bounds concurrency and preserves source order', async() => {
  const provider = sdk(); const gate = deferred()
  let active = 0; let peak = 0; let count = 0
  provider.createHttp = async(url, options) => {
    count++; active++; peak = Math.max(peak, active)
    try { await gate.promise; return options.body.data.map(item => [item]) } finally { active-- }
  }
  provider.filterData2 = items => items
  const request = provider.getMusicInfos(Array.from({ length: 1000 }, (_, i) => ({ hash: String(i) })))
  await flush()
  const started = count
  gate.resolve()
  const result = await request
  assert.equal(started, 4)
  assert.equal(peak, 4)
  assert.equal(count, 10)
  assert.deepEqual(Array.from(result, item => item.hash), Array.from({ length: 1000 }, (_, i) => String(i)))
})

test('a failed detail batch stops starting additional queued requests', async() => {
  const provider = sdk(); const failed = deferred(); const others = deferred(); let started = 0
  provider.createHttp = async(url, options) => {
    const first = started++ === 0
    await (first ? failed.promise : others.promise)
    return options.body.data.map(item => [item])
  }
  provider.filterData2 = items => items
  const request = provider.getMusicInfos(Array.from({ length: 1000 }, (_, i) => ({ hash: String(i) })))
  await flush()
  failed.reject(new Error('request failed'))
  await assert.rejects(request, /request failed/)
  others.resolve()
  await flush()
  assert.equal(started, 4)
})

test('numeric shares reuse their resolved collection identity while loading subsequent pages', async() => {
  const provider = sdk(); let codes = 0
  provider.createHttp = async url => {
    if (url.includes('/command/')) { codes++; return { info: { type: 2, global_collection_id: 'resolved' } } }
    return { songcount: 675 }
  }
  provider.getSongListDetailByGlobalSpecialId = async(id, page, limit) => rows(page, limit, 675)
  provider.getMusicInfos = async items => items
  const list = await core(provider).getListDetailAll('kg', '123456')
  assert.equal(list.length, 675)
  assert.equal(codes, 1)
})

test('a chain fallback preserves the source-page size and remembers the working endpoint', async() => {
  const provider = sdk(); const primary = []; const fallback = []; let transfers = 0
  provider.createHttp = async url => {
    if (url.includes('/schain/')) { transfers++; return { global_collection_id: 'resolved' } }
    if (url.includes('/v2/zlist/list')) {
      const page = Number(new URL(url).searchParams.get('page'))
      primary.push(page)
      if (page === 2) throw new Error('primary endpoint unavailable')
      return { info: [{ count: 125 }], list: { info: rows(page, 50, 125) } }
    }
    return { songcount: 125 }
  }
  provider.getSongListDetailByGlobalSpecialId = async(id, page, limit) => { fallback.push([page, limit]); return rows(page, limit, 125) }
  provider.getMusicInfos = async items => items
  const list = await core(provider).getListDetailAll('kg', 'https://m.kugou.com/share?chain=fixture')
  assert.deepEqual(Array.from(list, item => item.id), rows(1, 125, 125).map(item => item.id))
  assert.equal(transfers, 1)
  assert.deepEqual(primary, [1, 2])
  assert.deepEqual(fallback, [[2, 50], [3, 50]])
})

test('sparse source pages fill a visible page without losing rows or rereading successful source pages', async() => {
  const provider = sdk(); const requests = []
  provider.createHttp = async() => ({ songcount: 900 })
  provider.getSongListDetailByGlobalSpecialId = async(id, page, limit) => { requests.push(page); return rows(page, limit, 900) }
  provider.getMusicInfos = async items => items.slice(0, [10, 15, 35][Math.floor(Number(items[0]?.id ?? 0) / 300)] ?? 0)
  const api = core(provider); const id = 'https://m3ws.kugou.com/?global_collection_id=sparse'
  const first = await api.getListDetail(id, 'kg', 1)
  assert.equal(first.list.length, 30)
  const all = await api.getListDetailAll('kg', id)
  assert.deepEqual(Array.from(all, item => item.id), [...rows(1, 300, 900).slice(0, 10), ...rows(2, 300, 900).slice(0, 15), ...rows(3, 300, 900).slice(0, 35)].map(item => item.id))
  assert.deepEqual(requests, [1, 2, 3])
})

test('a completely empty source page can be followed by usable songs without failing the first UI page', async() => {
  const provider = sdk(); const requests = []
  provider.createHttp = async() => ({ songcount: 600 })
  provider.getSongListDetailByGlobalSpecialId = async(id, page, limit) => { requests.push(page); return page === 1 ? [] : rows(page, limit, 600).slice(0, 20) }
  provider.getMusicInfos = async items => items
  const api = core(provider); const id = 'https://m3ws.kugou.com/?global_collection_id=emptyfirst'
  const result = await api.getListDetail(id, 'kg', 1)
  assert.equal(result.list.length, 20)
  assert.equal(result.total, 20)
  assert.deepEqual(requests, [1, 2])
})

test('duplicate songs across source pages neither duplicate visible rows nor inflate the final count', async() => {
  const provider = sdk(); const requests = []
  provider.getListDetail = async(id, page) => {
    requests.push(page)
    return { list: Array.from({ length: 40 }, (_, i) => song(String(i + (page - 1) * 20))), page, total: 100, limit: 50, info: {} }
  }
  const api = core(provider)
  const first = await api.getListDetail('duplicate-pages', 'kg', 1)
  const all = await api.getListDetailAll('kg', 'duplicate-pages')
  const second = await api.getListDetail('duplicate-pages', 'kg', 2)
  assert.deepEqual(Array.from(all, item => item.id), Array.from({ length: 60 }, (_, i) => String(i)))
  assert.deepEqual(Array.from(second.list, item => item.id), Array.from({ length: 30 }, (_, i) => String(i + 30)))
  assert.equal(first.total, 60)
  assert.equal(second.total, 60)
  assert.deepEqual(requests, [1, 2])
})

test('retrying a sparse page keeps already loaded rows and resumes at the failed source page', async() => {
  const provider = sdk(); const requests = []; let failed = false
  provider.getListDetail = async(id, page) => {
    requests.push(page)
    if (page === 2 && !failed) { failed = true; throw new Error('temporary source failure') }
    return { list: rows(page, 50, 100).slice(0, page === 1 ? 10 : 20), page, total: 100, limit: 50, info: {} }
  }
  const api = core(provider)
  await assert.rejects(api.getListDetail('sparse-retry', 'kg', 1), /temporary source failure/)
  const result = await api.getListDetail('sparse-retry', 'kg', 1)
  assert.deepEqual(Array.from(result.list, item => item.id), [...rows(1, 50, 100).slice(0, 10), ...rows(2, 50, 100).slice(0, 20)].map(item => item.id))
  assert.equal(result.total, 30)
  assert.deepEqual(requests, [1, 2, 2])
})

test('refresh replaces a pending playlist cursor without old cleanup releasing the new request', async() => {
  const provider = sdk(); const old = deferred(); const fresh = deferred(); let requests = 0
  provider.getListDetail = () => ++requests === 1 ? old.promise : fresh.promise
  const api = core(provider)
  const previous = api.getListDetail('refreshing', 'kg', 1).then(() => false, error => error.message.includes('superseded'))
  await flush()
  const current = api.getListDetail('refreshing', 'kg', 1, true)
  await flush()
  old.resolve({ list: [song('old')], total: 1, limit: 50, info: {} })
  assert.equal(await previous, true)
  api.releaseIdleSonglistCaches()
  fresh.resolve({ list: [song('fresh')], total: 1, limit: 50, info: {} })
  assert.equal((await current).list[0].id, 'fresh')
  assert.equal((await api.getListDetail('refreshing', 'kg', 1)).list[0].id, 'fresh')
  assert.equal(requests, 2)
})

test('an empty final source page updates the visible store with the actual loaded total', async() => {
  const provider = sdk()
  provider.getListDetail = async(id, page) => ({ list: page === 1 ? rows(1, 60, 120) : [], total: 120, limit: 60, page, info: {} })
  const api = core(provider)
  const state = load('src/store/songlist/state.ts').default
  const actions = load('src/store/songlist/action.ts', { './state': { default: state } }).default
  for (let page = 1; page <= 3; page++) actions.setListDetail(await api.getListDetail('empty-last', 'kg', page), 'empty-last', page)
  assert.equal(state.listDetailInfo.list.length, 60)
  assert.equal(state.listDetailInfo.total, 60)
  assert.equal(state.listDetailInfo.maxPage, 2)
})

test('idle playlist cleanup releases the paging cursor and all normalized song objects', () => {
  const result = spawnSync(process.execPath, ['--expose-gc', '-e', `
    const assert = require('node:assert/strict')
    const { load, flush } = require('./tests/helpers/load.cjs')
    ;(async () => {
      const api = load('src/core/songlist.ts', {
        '@/store/songlist/action': {},
        '@/utils': { deduplicationList: value => value, toNewMusicInfo: value => value },
        '@/utils/musicSdk': { default: { tx: { songList: { getListDetail: async (id, page) => ({
          list: Array.from({ length: page === 1 ? 50 : 25 }, (_, i) => ({ id: String((page - 1) * 50 + i) })),
          total: 75, limit: 50, page, info: {},
        }) } } } },
      })
      let songs = await api.getListDetailAll('tx', 'gc')
      const reference = new WeakRef(songs[0])
      songs = null
      api.releaseIdleSonglistCaches()
      for (let i = 0; i < 10; i++) { await flush(); global.gc() }
      assert.equal(reference.deref() === undefined, true)
    })().catch(error => { console.error(error); process.exitCode = 1 })
  `], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})
