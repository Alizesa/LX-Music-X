const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load, deferred, flush } = require('./helpers/load.cjs')
const { harness: dataHarness, constants } = require('./helpers/download-storage.cjs')

const storageHarness = () => {
  const values = new Map()
  const writes = []
  const native = {
    multiGet: async keys => keys.map(key => [key, values.get(key) ?? null]),
    getItem: async key => values.get(key) ?? null,
    setItem: async(key, value) => { writes.push([[key, value]]); values.set(key, value) },
    multiSet: async entries => { writes.push(entries); entries.forEach(([key, value]) => values.set(key, value)) },
    multiRemove: async keys => { keys.forEach(key => values.delete(key)) },
  }
  const api = load('src/plugins/storage.ts', {
    '@react-native-async-storage/async-storage': { default: native },
    '@/utils/log': { log: { error() {} } },
  })
  return { api, native, writes, values }
}

for (const method of ['saveData', 'saveDataDirect', 'saveDataMultiple', 'saveDataMultipleDirect']) {
  test(`${method} serializes only when a same-key write can execute`, async() => {
    const h = storageHarness(); const gate = deferred()
    const commit = h.native.multiSet
    h.native.multiSet = async entries => { await gate.promise; await commit(entries) }
    const blocker = h.api.saveData('songs', ['initial'])
    await flush()
    let serialized = 0
    const save = value => method.includes('Multiple') ? h.api[method]([['songs', value]]) : h.api[method]('songs', value)
    const pending = Array.from({ length: 12 }, (_, index) => save({
      toJSON() { serialized++; return { index, value: 'payload' } },
    }))
    await flush()
    assert.equal(serialized, 0)
    gate.resolve()
    await Promise.all([blocker, ...pending])
    assert.equal(serialized, 12, 'generic storage preserves every explicitly requested transaction')
    assert.equal((await h.api.getData('songs')).index, 11)
  })
}

const row = id => ({ queueId: String(id), musicInfo: { id: String(id), name: `Song ${id}` }, sourceListId: 'library' })

test('moving a 10000-song queue coalesces pending snapshots and keeps the final order', async t => {
  const h = dataHarness(); const gate = deferred()
  const commit = h.native.multiSet
  let calls = 0; let serializedCharacters = 0
  h.native.multiSet = async entries => {
    calls++
    serializedCharacters += entries.reduce((sum, [, value]) => sum + value.length, 0)
    if (calls === 1) await gate.promise
    await commit(entries)
  }
  const queue = Array.from({ length: 10000 }, (_, index) => row(index))
  queue[0].sessionId = 'original-session'
  const first = h.data.savePlayQueue(queue)
  await flush()
  const pending = []
  for (let index = 0; index < 12; index++) {
    delete queue[0].sessionId
    queue.push(queue.shift())
    queue[0].sessionId = 'original-session'
    pending.push(h.data.savePlayQueue(queue))
  }
  await flush()
  assert.equal(calls, 1)
  const finalIds = queue.map(item => item.musicInfo.id)
  let readFinished = false
  const reading = h.data.getPlayQueue().then(value => { readFinished = true; return value })
  await flush()
  assert.equal(readFinished, false)
  gate.resolve()
  await Promise.all([first, ...pending])
  const saved = await reading
  assert.equal(calls, 2)
  assert.deepEqual(Array.from(saved, item => item.musicInfo.id), finalIds)
  assert.equal(saved[0].sessionId, 'original-session')
  assert.equal(saved.slice(1).some(item => item.sessionId), false)
  assert.equal((await h.storage.getData(constants.storageDataPrefix.playQueue))[0].musicInfo.id, '12')
  t.diagnostic(`queue=10000, moves=12, committed_snapshots=${calls}, serialized_characters=${serializedCharacters}`)
})

test('a failed active queue write rejects its caller while the newest pending snapshot still commits', async() => {
  const h = dataHarness(); const gate = deferred()
  const commit = h.native.multiSet
  let calls = 0
  h.native.multiSet = async entries => {
    if (++calls === 1) { await gate.promise; throw new Error('first write failed') }
    await commit(entries)
  }
  const first = h.data.savePlayQueue([row('old')])
  const rejected = assert.rejects(first, /first write failed/)
  await flush()
  const pending = h.data.savePlayQueue([row('new')])
  const empty = h.data.savePlayQueue([])
  gate.resolve()
  await Promise.all([rejected, pending, empty])
  assert.equal(calls, 2)
  assert.equal((await h.data.getPlayQueue()).length, 0)
  await h.data.savePlayQueue([row('recovered')])
  assert.equal((await h.data.getPlayQueue())[0].musicInfo.id, 'recovered')
})

const searchHarness = () => {
  const empty = () => ({ list: [], key: null, page: 0, total: 0, maxPage: 0, limit: 30 })
  const music = { listInfos: { tx: empty() }, maxPages: {} }
  const songlist = { listInfos: { tx: empty() }, maxPages: {} }
  const singer = { listInfo: empty() }; const album = { listInfo: empty() }
  const disk = new Map(); const saves = []; const tasks = new Map()
  const data = {
    getSearchResultCache: async key => disk.get(key) ?? null,
    saveSearchResultCache: async(key, value) => { saves.push(value); disk.set(key, structuredClone(value)) },
    removeSearchResultCache: async key => { disk.delete(key) },
  }
  const request = load('src/core/search/request.ts')
  const api = load('src/core/search/cache.ts', {
    '@/store/search/music/state': { default: music },
    '@/store/search/songlist/state': { default: songlist },
    '@/store/search/singer/state': { default: singer },
    '@/store/search/album/state': { default: album },
    '@/utils/data': data,
    './request': request,
  }, {
    setTimeout: (fn, delay) => { const id = tasks.size + 1; tasks.set(id, { fn, delay }); return id },
    clearTimeout: id => tasks.delete(id),
  })
  const seed = (info, count = 5000) => Object.assign(info, {
    list: Array.from({ length: count }, (_, index) => ({ id: String(index) })),
    key: '1__query',
    page: 1,
    total: count,
    maxPage: 1,
  })
  return { api, music, songlist, singer, album, disk, saves, tasks, data, request, seed }
}

test('pressure releases 5000 search rows before asynchronous disk cleanup without copying or serializing', async() => {
  const h = searchHarness(); const gate = deferred()
  h.seed(h.music.listInfos.tx)
  const original = h.music.listInfos.tx.list
  h.disk.set('music_tx', { savedAt: Date.now(), info: structuredClone(h.music.listInfos.tx) })
  let copied = 0
  original[Symbol.iterator] = () => { copied++; throw new Error('pressure must not copy rows') }
  h.data.removeSearchResultCache = async() => gate.promise
  const releasing = h.api.releaseIdleSearchCaches(true)
  assert.equal(h.music.listInfos.tx.list.length, 0)
  assert.equal(h.music.listInfos.tx.key, null)
  assert.equal(original.length, 5000)
  await releasing
  assert.equal(copied, 0)
  assert.equal(h.saves.length, 0)
  gate.resolve()
  await flush()
  assert.equal(await h.api.restoreSearchResult('music', 'tx', 'query'), false)
})

test('normal idle search release keeps disk restoration while pressure respects holders and pending searches', async() => {
  const h = searchHarness()
  h.seed(h.music.listInfos.tx, 2)
  await h.api.releaseIdleSearchCaches()
  assert.equal(h.saves.length, 1)
  assert.equal(await h.api.restoreSearchResult('music', 'tx', 'query'), true)
  const release = h.api.retainSearchResults()
  await h.api.releaseIdleSearchCaches(true)
  assert.equal(h.music.listInfos.tx.list.length, 2)
  release()
  const signal = h.request.beginSearchRequest('music')
  await h.api.releaseIdleSearchCaches(true)
  assert.equal(h.music.listInfos.tx.list.length, 2)
  h.request.finishSearchRequest('music', signal)
  await h.api.releaseIdleSearchCaches(true)
  assert.equal(h.music.listInfos.tx.list.length, 0)
})

test('exceeding the idle search row budget schedules immediate pressure release without a snapshot', async() => {
  const h = searchHarness()
  const release = h.api.retainSearchResults()
  h.seed(h.music.listInfos.tx)
  release()
  const task = [...h.tasks.values()][0]
  assert.equal(task.delay, 0)
  task.fn()
  await flush()
  assert.equal(h.music.listInfos.tx.list.length, 0)
  assert.equal(h.saves.length, 0)
})

test('memory pressure uses immediate search release while entering the background keeps ordinary persistence', () => {
  let background; let pressure
  const calls = []
  const api = load('src/core/cacheLifecycle.ts', {
    'react-native': { AppState: { addEventListener: (name, handler) => { background = handler } } },
    '@/utils/nativeModules/utils': { onMemoryPressure: handler => { pressure = handler } },
    '@/utils/listManage': { releaseIdleListCaches() {} },
    '@/core/songlist': { releaseIdleSonglistCaches() {} },
    '@/store/singer/action': { releaseIdleSingerCaches() {} },
    '@/core/music/utils': { clearOtherSourceCache() {} },
    '@/core/download': { releaseIdleDownloadCaches() {} },
    '@/core/search/cache': { releaseIdleSearchCaches: immediate => { calls.push(immediate) } },
    '@/utils/musicSdk/kg/songList': { clearSongListCache() {} },
    '@/utils/musicSdk/mg/songList': { clearMiguSongListCache() {} },
    '@/utils/musicSdk/wy/comment': { clearCommentCursorCache() {} },
  }, { global: { app_event: { on() {} } } })
  api.initCacheLifecycle()
  background('background')
  pressure(15)
  pressure(5)
  assert.deepEqual(calls, [false, true])
})
