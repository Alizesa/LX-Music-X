const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const ts = require('typescript')

const compiled = new Map()
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value))
const flush = async() => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)) }
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const timers = () => {
  let next = 0
  const tasks = new Map()
  return {
    setTimeout(fn, delay) { const id = ++next; tasks.set(id, { fn, delay }); return id },
    clearTimeout(id) { tasks.delete(id) },
    async run(delay) {
      for (const [id, task] of [...tasks]) if (task.delay === delay) { tasks.delete(id); task.fn() }
      await flush()
    },
    tasks,
  }
}
const load = (file, mocks = {}, globals = {}) => {
  if (!compiled.has(file)) compiled.set(file, ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText)
  const context = {
    exports: {}, AbortController, Buffer, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    require: name => { assert.ok(Object.hasOwn(mocks, name), `Unexpected import: ${file}: ${name}`); return mocks[name] },
    ...globals,
  }
  vm.runInNewContext(compiled.get(file), context, { filename: file })
  return context.exports
}
const constants = load('src/config/constant.ts')
const historyItem = id => ({ id: String(id), name: `Song ${id}`, singer: 'Artist', quality: '320k', filePath: `content://fixture/${id}`, createdAt: Number(id) || 100001 })
const historyKey = item => `${constants.storageDataPrefix.downloadHistoryItem}${item.createdAt}__${encodeURIComponent(item.id)}`

const historyHarness = ({ count = 0, legacy = [], migrated = true } = {}) => {
  const records = new Map(Array.from({ length: count }, (_, i) => { const item = historyItem(i); return [historyKey(item), item] }))
  const reads = [], writes = []
  let old = copy(legacy)
  const data = {
    getDownloadHistoryKeys: async() => [...records.keys()],
    getDownloadHistoryMigrated: async() => migrated,
    getDownloadHistory: async() => copy(old),
    saveDownloadHistoryMigrated: async() => { migrated = true },
    removeLegacyDownloadHistory: async() => { old = [] },
    getDownloadHistoryItems: async keys => { reads.push([...keys]); return keys.map(key => [key, copy(records.get(key))]) },
    saveDownloadHistoryItems: async items => { writes.push(copy(items)); for (const [key, item] of items) records.set(key, copy(item)) },
    removeDownloadHistoryItems: async keys => { for (const key of keys) records.delete(key) },
  }
  const createApi = () => load('src/core/downloadHistory.ts', { '@/config/constant': constants, '@/utils/data': data })
  return { api: createApi(), createApi, data, records, reads, writes, legacy: () => old, migrated: () => migrated }
}

test('download history migration survives partial writes and never deletes the legacy copy early', async() => {
  const h = historyHarness({ migrated: false, legacy: Array.from({ length: 150 }, (_, i) => historyItem(i)) })
  const save = h.data.saveDownloadHistoryItems
  let calls = 0
  h.data.saveDownloadHistoryItems = async items => { if (++calls === 2) throw new Error('disk unavailable'); await save(items) }
  await assert.rejects(h.api.initDownloadHistory(), /disk unavailable/)
  assert.equal(h.legacy().length, 150)
  assert.equal(h.migrated(), false)
  assert.equal(h.records.size, 100)
  h.data.saveDownloadHistoryItems = save
  const restarted = h.createApi()
  await restarted.initDownloadHistory()
  assert.equal(restarted.getDownloadHistoryCount(), 150)
  assert.equal(h.records.size, 150)
  assert.equal(h.legacy().length, 0)
  assert.equal(h.migrated(), true)
  assert.equal(h.reads.length, 0)
})

test('counting history reads no record bodies and paging only reads the selected records', async() => {
  const h = historyHarness({ count: 10000 })
  await h.api.initDownloadHistory()
  assert.equal(h.api.getDownloadHistoryCount(), 10000)
  assert.equal(h.reads.length, 0)
  const page = await h.api.getDownloadHistoryPage(100, 100)
  assert.equal(page.length, 100)
  assert.equal(h.reads.flat().length, 100)
  assert.ok(page.every((item, i) => !i || page[i - 1].createdAt >= item.createdAt))
  await h.api.getDownloadHistoryPage(100, 100)
  assert.equal(h.reads.flat().length, 100)
  h.api.releaseDownloadHistoryCache()
  await h.api.getDownloadHistoryPage(100, 100)
  assert.equal(h.reads.flat().length, 200)
})

test('an in-flight page keeps cached rows if the memory cache is released during its read', async() => {
  const h = historyHarness({ count: 3 })
  await h.api.getDownloadHistoryByIds(['1'])
  const gate = deferred()
  const read = h.data.getDownloadHistoryItems
  h.data.getDownloadHistoryItems = async keys => { await gate.promise; return read(keys) }
  const pending = h.api.getDownloadHistoryByIds(['1', '2'])
  await flush()
  h.api.releaseDownloadHistoryCache()
  gate.resolve()
  assert.deepEqual(Array.from(await pending, item => item.id), ['1', '2'])
})

test('a failed history write does not poison later writes and duplicate completions remain unique', async() => {
  const h = historyHarness()
  const save = h.data.saveDownloadHistoryItems
  h.data.saveDownloadHistoryItems = async() => { throw new Error('disk unavailable') }
  await assert.rejects(h.api.addDownloadHistory([historyItem(1)]), /disk unavailable/)
  h.data.saveDownloadHistoryItems = save
  await h.api.addDownloadHistory([historyItem(2), historyItem(2)])
  assert.equal(h.records.size, 1)
  assert.equal(h.api.getDownloadHistoryCount(), 1)
  assert.equal(h.api.hasDownloadHistory('1'), false)
})

const activeTask = id => ({
  id, nativeId: `work-${id}`, status: 'pause', quality: '320k', fileName: `${id}.mp3`, directoryUri: 'content://fixture/dir', createdAt: 200000,
  progress: { progress: 0, downloaded: 0, total: 0, speed: '' },
  musicInfo: { id, name: id, singer: 'Artist', source: 'tx', interval: '03:00', meta: { albumName: 'Album', _qualitys: {} } },
})
const downloadHarness = ({ count = 0, active = [], nativeState = async() => null, tags = async() => {}, url = async() => 'https://fixture.test/audio', enqueue = async() => 'work-new' } = {}) => {
  const h = historyHarness({ count })
  const clock = timers()
  let nativeUpdate
  let savedActive = copy(active)
  const events = [], localWrites = [], deleted = [], nativeQueries = [], tagWrites = [], urlRequests = []
  const data = {
    getDownloadTasksMigrated: async() => true, removeDownloadTasks: async() => {},
    getDownloadActiveTasks: async() => copy(savedActive),
    saveDownloadActiveTasks: async value => { savedActive = copy(value) },
    getDownloadPath: async() => ({ uri: 'content://fixture/dir' }),
  }
  const api = load('src/core/download.ts', {
    '@/core/list': { addListMusics: async(id, items) => { localWrites.push(copy(items)) }, removeListMusics: async() => {} },
    '@/core/music': { getPicPath: async() => null, getLyricInfo: async() => null, getMusicUrl: async info => { urlRequests.push(info); return url(info) } },
    '@/core/music/utils': {}, '@/config/constant': constants,
    '@/store/setting/state': { default: { setting: {} } }, '@/utils': {}, '@/utils/lrcTools': {},
    '@/utils/data': data, './downloadHistory': h.api,
    '@/utils/fs': { privateStorageDirectoryPath: '/private', temporaryDirectoryPath: '/temp', unlink: async file => { deleted.push(file) } },
    '@/utils/localMediaMetadata': { writeDownloadMetadata: async(...args) => { tagWrites.push(args); await tags(...args) } },
    '@/utils/nativeModules/download': {
      onDownloadUpdate: callback => { nativeUpdate = callback },
      getDownloadState: async id => { nativeQueries.push(id); return nativeState(id) },
      enqueueDownload: enqueue,
      removeDownload: async() => {}, pauseDownload: async() => {},
    },
    '@/utils/tools': {}, '@/utils/common': {},
  }, {
    ...clock,
    global: { i18n: { t: key => key }, app_event: {
      downloadListUpdate: () => events.push(['list']),
      downloadCountUpdate: count => events.push(['count', count]),
      downloadTaskUpdate: item => events.push(['item', copy(item)]),
    } },
  })
  return { ...h, api, historyApi: h.api, clock, events, localWrites, deleted, nativeQueries, tagWrites, urlRequests, activeData: data,
    update: state => nativeUpdate(state), savedActive: () => savedActive }
}
const completed = id => ({ taskId: id, nativeId: `work-${id}`, status: 'completed', downloaded: 100, total: 100, filePath: `content://fixture/${id}` })

test('four progress events create no history snapshots, list refreshes or count updates', async() => {
  const h = downloadHarness({ count: 10000,
    active: [activeTask('a'), activeTask('b')].map(item => ({ ...item, status: 'waiting' })),
    nativeState: async nativeId => ({ nativeId, status: 'waiting', downloaded: 0, total: 100 }),
  })
  await h.api.initDownloads()
  await flush()
  assert.equal(await h.api.getDownloadCount(), 10002)
  assert.equal((await h.api.getDownloadIds()).length, 10002)
  assert.equal(h.reads.length, 0)
  h.api.retainDownloadList()
  const [first, second] = await Promise.all([h.api.getDownloadList(), h.api.getDownloadList()])
  assert.equal(first, second)
  assert.equal(h.reads.flat().length, 98)
  h.events.length = 0
  for (let i = 0; i < 4; i++) h.update({ taskId: i % 2 ? 'b' : 'a', status: 'run', downloaded: 10 + i, total: 100 })
  await flush()
  assert.equal(await h.api.getDownloadList(), first)
  assert.equal(h.events.filter(event => event[0] === 'item').length, 4)
  assert.equal(h.events.filter(event => event[0] !== 'item').length, 0)
  assert.equal(h.reads.flat().length, 98)
  const next = await h.api.getDownloadList(100, 100)
  assert.equal(next.length, 100)
  assert.equal(h.reads.flat().length, 198)
  assert.ok(!next.some(item => first.some(previous => previous.id === item.id)))
  h.api.releaseDownloadList()
})

test('download initialization and list access do not wait for native recovery', async() => {
  const gate = deferred()
  const h = downloadHarness({ active: [{ ...activeTask('a'), status: 'run' }], nativeState: () => gate.promise })
  let ready = false
  void h.api.initDownloads().then(() => { ready = true })
  await flush()
  assert.equal(ready, true)
  assert.equal((await h.api.getDownloadList()).length, 1)
  gate.resolve(completed('a'))
  await flush()
  await h.clock.run(250)
  assert.equal(h.localWrites.length, 1)
  assert.equal(h.savedActive().length, 0)
})

test('simultaneous completions batch the local write and ignore duplicate native events', async() => {
  const h = downloadHarness({ active: [activeTask('a'), activeTask('b')] })
  await h.api.initDownloads()
  await flush()
  h.update(completed('a'))
  h.update(completed('a'))
  h.update(completed('b'))
  await flush()
  await h.clock.run(250)
  assert.equal(h.tagWrites.length, 2)
  assert.equal(h.localWrites.length, 1)
  assert.equal(h.localWrites[0].length, 2)
  assert.equal(h.records.size, 2)
  assert.equal(h.savedActive().length, 0)
  assert.equal(await h.api.getDownloadCount(), 2)
})

test('deleting a task during metadata work cannot restore it to local music or history', async() => {
  const gate = deferred()
  const h = downloadHarness({ active: [activeTask('a')], tags: () => gate.promise })
  await h.api.initDownloads()
  await flush()
  h.update(completed('a'))
  await flush()
  assert.equal(h.tagWrites.length, 1)
  await h.api.removeTasks(['a'], true)
  gate.resolve()
  await flush()
  await h.clock.run(250)
  assert.equal(h.localWrites.length, 0)
  assert.equal(h.records.size, 0)
  assert.equal(h.savedActive().length, 0)
  assert.deepEqual(h.deleted, ['content://fixture/a'])
})

test('a durable history record wins over a stale active snapshot after restart', async() => {
  const h = downloadHarness({ count: 1, active: [{ ...activeTask('0'), status: 'run' }] })
  await h.api.initDownloads()
  await flush()
  assert.equal(await h.api.getDownloadCount(), 1)
  assert.equal(h.nativeQueries.length, 0)
  assert.equal(h.tagWrites.length, 0)
  assert.equal(h.savedActive().length, 0)
})

test('a failed archive can retry the downloaded file without resolving or downloading it again', async() => {
  const h = downloadHarness({ active: [activeTask('a')] })
  await h.api.initDownloads()
  await flush()
  const save = h.data.saveDownloadHistoryItems
  h.data.saveDownloadHistoryItems = async() => { throw new Error('disk temporarily unavailable') }
  h.update(completed('a'))
  await flush()
  await h.clock.run(250)
  assert.equal(h.api.getDownloadTaskItem('a').status, 'error')
  assert.equal(h.api.getDownloadTaskItem('a').filePath, 'content://fixture/a')
  h.data.saveDownloadHistoryItems = save
  await h.api.retryTask('a')
  await flush()
  await h.clock.run(250)
  assert.equal(h.records.size, 1)
  assert.equal(h.savedActive().length, 0)
  assert.equal(h.urlRequests.length, 0)
  assert.equal(h.nativeQueries.length, 0)
})

test('a durable archive updates the visible list even when saving the active snapshot fails', async() => {
  const h = downloadHarness({ active: [activeTask('a')] })
  await h.api.initDownloads()
  await flush()
  const save = h.activeData.saveDownloadActiveTasks
  h.activeData.saveDownloadActiveTasks = async value => {
    if (!value.length) throw new Error('active snapshot write failed')
    return save(value)
  }
  h.events.length = 0
  h.update(completed('a'))
  await flush()
  await h.clock.run(250)
  assert.equal((await h.api.getDownloadList())[0].status, 'completed')
  assert.equal(await h.api.getDownloadCount(), 1)
  assert.ok(h.events.some(event => event[0] === 'list'))
})

test('pending finalization survives restart without relying on a retained WorkManager record', async() => {
  const h = downloadHarness({ active: [{ ...activeTask('a'), status: 'error',
    filePath: 'content://fixture/a', pendingCompletion: { downloaded: 100, total: 100 } }] })
  await h.api.initDownloads()
  await flush()
  await h.clock.run(250)
  assert.equal(h.records.size, 1)
  assert.equal(h.nativeQueries.length, 0)
  assert.equal(h.urlRequests.length, 0)
})

test('late native progress cannot undo a pause or replace the current worker', async() => {
  const h = downloadHarness({ active: [activeTask('a')] })
  await h.api.initDownloads()
  await flush()
  h.update({ ...completed('a'), status: 'run' })
  assert.equal(h.api.getDownloadTaskItem('a').status, 'pause')
  h.update({ ...completed('a'), nativeId: 'work-obsolete', filePath: 'content://obsolete' })
  await flush()
  assert.equal(h.tagWrites.length, 0)
  assert.equal(h.api.getDownloadTaskItem('a').status, 'pause')
})

test('an early completion is matched to the new work ID and an old worker is ignored', async() => {
  const gate = deferred()
  const h = downloadHarness({ active: [{ ...activeTask('a'), status: 'waiting', nativeId: undefined }], enqueue: () => gate.promise })
  await h.api.initDownloads()
  await flush()
  h.update({ ...completed('a'), nativeId: 'work-obsolete', filePath: 'content://obsolete' })
  h.update({ ...completed('a'), nativeId: 'work-new' })
  gate.resolve('work-new')
  await flush()
  await h.clock.run(250)
  assert.equal(h.records.size, 1)
  assert.equal((await h.api.getDownloadList())[0].filePath, 'content://fixture/a')
  assert.equal(h.tagWrites.length, 1)
})

test('a late URL failure cannot turn a paused task into an error', async() => {
  const gate = deferred()
  const h = downloadHarness({ active: [{ ...activeTask('a'), status: 'waiting', nativeId: undefined }], url: () => gate.promise })
  await h.api.initDownloads()
  await flush()
  assert.equal(h.api.getDownloadTaskItem('a').status, 'resolving')
  await h.api.pauseTask('a')
  gate.reject(new Error('old URL request failed'))
  await flush()
  assert.equal(h.api.getDownloadTaskItem('a').status, 'pause')
})

test('a pause during native recovery survives a late query failure', async() => {
  const gate = deferred()
  const h = downloadHarness({ active: [{ ...activeTask('a'), status: 'run' }], nativeState: () => gate.promise })
  await h.api.initDownloads()
  await h.api.pauseTask('a')
  gate.reject(new Error('native database busy'))
  await flush()
  assert.equal(h.api.getDownloadTaskItem('a').status, 'pause')
  assert.equal(h.api.getDownloadTaskItem('a').id, 'a')
})

test('queued finalization retains the file URI so deletion also removes an unprocessed file', async() => {
  const gate = deferred()
  const h = downloadHarness({ active: [activeTask('a'), activeTask('b'), activeTask('c')], tags: () => gate.promise })
  await h.api.initDownloads()
  await flush()
  for (const id of ['a', 'b', 'c']) h.update(completed(id))
  await flush()
  assert.equal(h.tagWrites.length, 2)
  await h.api.removeTasks(['c'], true)
  assert.deepEqual(h.deleted, ['content://fixture/c'])
  gate.resolve()
  await flush()
  await h.clock.run(250)
  assert.equal(h.tagWrites.length, 2)
  assert.equal(h.records.size, 2)
})

test('removing all unloaded history records does not read their bodies or touch audio files', async() => {
  const h = downloadHarness({ count: 350 })
  await h.api.initDownloads()
  await flush()
  await h.api.removeTasks(await h.api.getDownloadIds(), false)
  assert.equal(h.reads.length, 0)
  assert.equal(h.records.size, 0)
  assert.equal(await h.api.getDownloadCount(), 0)
  assert.equal(h.deleted.length, 0)
})

const abort = load('src/utils/abort.ts', { './message': { requestMsg: { cancelRequest: 'cancelled' } } })
const qqSearchHarness = respond => {
  const clock = timers()
  const requests = []
  const api = load('src/utils/musicSdk/tx/musicSearch.js', {
    '../../index': {}, '../utils': {}, '@/utils/abort': abort,
    './utils': { comm: {}, signRequest: async(...args) => { requests.push(args); return respond(args) } },
  }, clock).default
  return { api, clock, requests }
}

test('QQ empty results use one request in songs, singers and albums', async() => {
  for (const method of ['search', 'searchSinger', 'searchAlbum']) {
    const h = qqSearchHarness(() => ({ body: { code: 0, req: { code: 2001 } } }))
    const result = await h.api[method]('empty', 1, 20)
    assert.equal(result.list.length, 0)
    assert.equal(h.requests.length, 1)
    assert.equal(h.clock.tasks.size, 0)
  }
})

test('QQ transient errors back off, while cancellation prevents the next retry', async() => {
  const h = qqSearchHarness(() => ({ body: { code: 0, req: { code: 500 } } }))
  const controller = new AbortController()
  const result = h.api.search('query', 1, 20, controller.signal)
  const rejected = assert.rejects(result, /cancelled/)
  await flush()
  assert.deepEqual([...h.clock.tasks.values()].map(task => task.delay), [500])
  await h.clock.run(500)
  assert.equal(h.requests.length, 2)
  assert.deepEqual([...h.clock.tasks.values()].map(task => task.delay), [1000])
  controller.abort()
  await rejected
  await h.clock.run(1000)
  assert.equal(h.requests.length, 2)
})

test('QQ permanent session errors are not retried', async() => {
  const h = qqSearchHarness(() => ({ body: { code: 1000 } }))
  await assert.rejects(h.api.search('query', 1, 20))
  assert.equal(h.requests.length, 1)
  assert.equal(h.clock.tasks.size, 0)
})

test('cancelling during QQ signing never starts an HTTP request', async() => {
  const gate = deferred()
  let httpCalls = 0
  const api = load('src/utils/musicSdk/tx/utils/index.js', {
    '@/utils/request': { httpFetch: () => { httpCalls++; throw new Error('unexpected request') } },
    './crypto': { zzcSign: () => gate.promise }, '@/utils/abort': abort,
  })
  const controller = new AbortController()
  const result = api.signRequest({}, 'musics.fcg', controller.signal)
  controller.abort()
  gate.resolve('signature')
  await assert.rejects(result, /cancelled/)
  assert.equal(httpCalls, 0)
})

const searchCacheHarness = () => {
  const clock = timers()
  const empty = () => ({ key: null, list: [], page: 0, limit: 30, maxPage: 0, total: 0 })
  const music = { listInfos: { tx: empty(), kw: empty(), all: empty() }, maxPages: {}, source: 'tx', searchText: '' }
  const songlist = { listInfos: { tx: empty() }, maxPages: {}, source: 'tx', searchText: '' }
  const singer = { listInfo: empty(), searchText: '' }, album = { listInfo: empty(), searchText: '' }
  const disk = new Map()
  const data = {
    getSearchResultCache: async key => copy(disk.get(key)),
    saveSearchResultCache: async(key, value) => { disk.set(key, copy(value)) },
  }
  const request = load('src/core/search/request.ts')
  const api = load('src/core/search/cache.ts', {
    '@/store/search/music/state': { default: music }, '@/store/search/songlist/state': { default: songlist },
    '@/store/search/singer/state': { default: singer }, '@/store/search/album/state': { default: album },
    '@/utils/data': data, './request': request,
  }, clock)
  return { api, music, songlist, singer, album, disk, data, request, clock }
}

test('idle search eviction preserves visible results and restores pagination without a network request', async() => {
  const h = searchCacheHarness()
  const original = [{ id: 'one' }, { id: 'two' }]
  Object.assign(h.music.listInfos.tx, { list: original, key: '2__query', page: 2, maxPage: 4, total: 4 })
  const release = h.api.retainSearchResults()
  await h.api.releaseIdleSearchCaches()
  assert.equal(h.music.listInfos.tx.list, original)
  assert.equal(h.disk.size, 0)
  release()
  await h.api.releaseIdleSearchCaches()
  assert.equal(h.music.listInfos.tx.list.length, 0)
  assert.equal(original.length, 2)
  assert.equal(await h.api.restoreSearchResult('music', 'tx', 'query'), true)
  assert.equal(h.music.listInfos.tx.page, 2)
  assert.equal(h.music.listInfos.tx.maxPage, 4)
  assert.deepEqual(copy(h.music.listInfos.tx.list), original)
})

test('in-flight searches are not persisted as results for a different keyword', async() => {
  const h = searchCacheHarness()
  Object.assign(h.music.listInfos.tx, { list: [{ id: 'old' }], key: '1__new', page: 1 })
  const signal = h.request.beginSearchRequest('music')
  await h.api.releaseIdleSearchCaches()
  assert.equal(h.disk.size, 0)
  assert.equal(h.music.listInfos.tx.list.length, 1)
  h.request.finishSearchRequest('music', signal)
  await h.clock.run(60000)
  assert.equal(h.music.listInfos.tx.list.length, 0)
})

test('reopening search while a cache write is pending preserves the current in-memory list', async() => {
  const h = searchCacheHarness()
  Object.assign(h.music.listInfos.tx, { list: [{ id: 'current' }], key: '1__query', page: 1 })
  const gate = deferred()
  h.data.saveSearchResultCache = async() => gate.promise
  const evicting = h.api.releaseIdleSearchCaches()
  await flush()
  const release = h.api.retainSearchResults()
  gate.resolve()
  await evicting
  assert.equal(h.music.listInfos.tx.list.length, 1)
  release()
})

test('superseded QQ results cannot overwrite the newest search and other providers keep their argument contract', async() => {
  const h = searchCacheHarness()
  Object.assign(h.music.listInfos.tx, { list: [{ id: 'previous' }], key: '1__previous', page: 1 })
  const pending = []
  const sdk = { tx: { musicSearch: { search: (...args) => { const gate = deferred(); pending.push({ ...gate, args }); return gate.promise } } },
    kw: { musicSearch: { search: async(...args) => { assert.equal(args.length, 3); return { list: [], source: 'kw' } } } } }
  const api = load('src/core/search/music.ts', {
    '@/store/search/music/state': { default: h.music }, '@/utils/musicSdk': { default: sdk },
    './cache': h.api, './request': h.request,
    '@/store/search/music/action': { default: {
      setSearchText: text => { h.music.searchText = text },
      setListInfo: (result, page) => { Object.assign(h.music.listInfos[result.source], { list: result.list, page }); return result.list },
    } },
  })
  const first = api.search('old', 1, 'tx')
  await flush()
  assert.equal(h.music.listInfos.tx.key, '1__previous', 'a pending request must not relabel the previous cached rows')
  const second = api.search('new', 1, 'tx')
  await flush()
  assert.equal(pending[0].args[3].aborted, true)
  pending[1].resolve({ list: [{ id: 'new' }], source: 'tx' })
  await second
  pending[0].resolve({ list: [{ id: 'old' }], source: 'tx' })
  assert.equal(await first, null)
  assert.equal(h.music.listInfos.tx.list[0].id, 'new')
  await api.search('query', 1, 'kw')
})

// Small hook host: native events and React effects are controlled, while the production hook runs unchanged.
const hookHost = () => {
  let current
  const react = {
    useState(initial) {
      const frame = current, index = frame.cursor++
      if (!frame.slots[index]) {
        const slot = { value: typeof initial === 'function' ? initial() : initial }
        slot.set = next => { slot.value = typeof next === 'function' ? next(slot.value) : next }
        frame.slots[index] = slot
      }
      const slot = frame.slots[index]
      return [slot.value, slot.set]
    },
    useEffect(effect, deps) {
      const frame = current, index = frame.cursor++
      const previous = frame.slots[index]
      if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return
      const slot = { deps }
      frame.slots[index] = slot
      frame.effects.push(() => { previous?.cleanup?.(); slot.cleanup = effect() })
    },
    useRef(initial) {
      const frame = current, index = frame.cursor++
      return frame.slots[index] ??= { current: initial }
    },
  }
  return {
    react,
    visible: () => current.visible,
    frame: () => ({ visible: true, slots: [] }),
    render(frame, hook) {
      current = frame
      frame.cursor = 0
      frame.effects = []
      const result = hook()
      current = null
      frame.effects.forEach(effect => effect())
      return result
    },
  }
}

const bufferHarness = (getBuffered = async() => 50, getState = async() => 'playing') => {
  const host = hookHost()
  const intervals = new Map(), listeners = new Set()
  let next = 0
  const api = load('src/plugins/player/hook.ts', {
    react: host.react,
    '@/utils/hooks/useScreenVisible': { useScreenVisible: host.visible },
    'react-native-track-player': {
      State: { None: 'none', Paused: 'paused', Stopped: 'stopped', Buffering: 'buffering', Playing: 'playing' },
      Event: { PlaybackState: 'state' },
      default: {
        getBufferedPosition: getBuffered,
        getDuration: async() => 100,
        getState,
        addEventListener(name, callback) { listeners.add(callback); return { remove: () => listeners.delete(callback) } },
      },
    },
  }, {
    setInterval(fn) { const id = ++next; intervals.set(id, fn); return id },
    clearInterval(id) { intervals.delete(id) },
  })
  return { host, intervals, listeners, render: frame => host.render(frame, api.useBufferProgress) }
}

test('visible player bars share one buffer poll and all hidden bars stop it', async() => {
  const h = bufferHarness()
  const a = h.host.frame(), b = h.host.frame()
  h.render(a)
  h.render(b)
  await flush()
  assert.equal(h.intervals.size, 1)
  assert.equal(h.listeners.size, 1)
  assert.equal(h.render(a), 0.5)
  a.visible = false
  h.render(a)
  assert.equal(h.intervals.size, 1)
  b.visible = false
  h.render(b)
  assert.equal(h.intervals.size, 0)
  assert.equal(h.listeners.size, 0)
  a.visible = true
  h.render(a)
  await flush()
  assert.equal(h.intervals.size, 1)
  assert.equal(h.render(a), 0.5)
  a.visible = false
  h.render(a)
})

test('a buffer response from a hidden screen cannot replace the refreshed visible state', async() => {
  const gate = deferred()
  let requests = 0
  const h = bufferHarness(async() => ++requests === 1 ? gate.promise : 20)
  const frame = h.host.frame()
  h.render(frame)
  await flush()
  frame.visible = false
  h.render(frame)
  frame.visible = true
  h.render(frame)
  await flush()
  assert.equal(h.render(frame), 0.2)
  gate.resolve(90)
  await flush()
  assert.equal(h.render(frame), 0.2)
  frame.visible = false
  h.render(frame)
})

test('a late playing snapshot cannot restart buffer polling after a pause event', async() => {
  const gate = deferred()
  const h = bufferHarness(async() => 20, () => gate.promise)
  const frame = h.host.frame()
  h.render(frame)
  for (const listener of h.listeners) listener({ state: 'paused' })
  gate.resolve('playing')
  await flush()
  assert.equal(h.intervals.size, 0)
  frame.visible = false
  h.render(frame)
})
