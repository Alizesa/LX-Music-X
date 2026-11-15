const assert = require('node:assert/strict')
const { test } = require('node:test')
const { spawnSync } = require('node:child_process')
const { harness, task, load, deferred, flush } = require('./helpers/download-runtime.cjs')
const runTest = process.env.LX_DOWNLOAD_GC_CHILD ? () => {} : test

runTest('1000 downloads resolve and enqueue only four tasks until a native terminal event frees a slot', async() => {
  let urlCalls = 0
  const h = harness({ active: Array.from({ length: 1000 }, (_, i) => task(String(i))), url: async() => { urlCalls++; return 'https://fixture/audio' } })
  await h.api.initDownloads()
  await flush()
  assert.equal(h.enqueued.length, 4)
  assert.equal(urlCalls, 4)
  assert.equal(h.saved().filter(item => !item.nativeId && item.status === 'waiting').length, 996)
  h.emitNative({ taskId: '0', nativeId: 'work-0', status: 'error', downloaded: 0, total: 0, error: 'failed' })
  await flush()
  assert.equal(h.enqueued.length, 5)
  assert.equal(urlCalls, 5)
  assert.equal(h.enqueued[4].taskId, '4')
  await h.api.pauseAllTasks()
})

runTest('pause and deletion refill the bounded window and leave other pending songs on disk', async() => {
  const h = harness({ active: Array.from({ length: 20 }, (_, i) => task(String(i))) })
  await h.api.initDownloads()
  await flush()
  await h.api.pauseTask('0')
  await flush()
  assert.equal(h.enqueued.length, 5)
  await h.api.removeTasks(['1'])
  await flush()
  assert.equal(h.enqueued.length, 6)
  assert.equal(h.api.getDownloadTaskItem('0').status, 'pause')
  assert.equal(h.api.getDownloadTaskItem('1'), null)
  assert.equal(h.saved().length, 19)
  assert.equal(h.saved().filter(item => item.status === 'waiting' && item.nativeId).length, 4)
  await h.api.pauseAllTasks()
})

runTest('deleting a pending native enqueue releases its task and advances the queue before the bridge finishes', async() => {
  const old = deferred()
  const h = harness({ active: [task('old'), task('next')], enqueue: options => options.taskId === 'old' ? old.promise : Promise.resolve('work-next') })
  await h.api.initDownloads()
  await flush()
  await h.api.removeTasks(['old'])
  await flush()
  assert.deepEqual(h.enqueued.map(item => item.taskId), ['old', 'next'])
  old.resolve('late-work-old')
  await flush()
  assert.ok(h.removed.some(([nativeId, taskId]) => nativeId === 'late-work-old' && taskId === 'old'))
  assert.equal(h.api.getDownloadTaskItem('old'), null)
})

const finalizationHarness = (stage = 'pic', count = 12, pending = 0) => {
  const gate = deferred()
  const references = []
  let calls = 0; let tags = 0; let lyrics = 0; let listener
  const enqueued = []
  const history = new Map()
  const clock = new Map(); let nextTimer = 0
  const api = load('src/core/download.ts', {
    '@/core/list': { addListMusics: async() => {}, removeListMusics: async() => {} },
    '@/core/music': {
      getMusicUrl: async() => 'https://fixture/audio',
      getPicPath: () => { calls++; return stage === 'pic' ? gate.promise : Promise.resolve('') },
      getLyricInfo: () => { lyrics++; return stage === 'lyric' ? gate.promise : Promise.resolve({ lyric: '' }) },
    },
    '@/config/constant': load('src/config/constant.ts'),
    '@/store/setting/state': { default: { setting: {} } },
    '@/utils': { filterFileName: value => value },
    '@/utils/lrcTools': { buildLyrics: () => '' },
    '@/utils/data': {
      getDownloadTasksMigrated: async() => true,
      removeDownloadTasks: async() => {},
      getDownloadActiveTasks: async() => Array.from({ length: count + pending }, (_, i) => {
        const value = i < count ? { ...task(String(i)), status: 'finalizing', filePath: `content://fixture/${i}`, pendingCompletion: { downloaded: 1024, total: 1024 } } : task(String(i))
        references.push(new WeakRef(value))
        return value
      }),
      getDownloadPath: async() => ({ uri: 'content://fixture/dir' }),
      saveDownloadActiveTasks: async() => {},
    },
    './downloadHistory': {
      initDownloadHistory: async() => {},
      getDownloadHistoryCount: () => history.size,
      getDownloadHistoryIds: () => history.keys(),
      hasDownloadHistory: id => history.has(id),
      addDownloadHistory: async items => { items.forEach(item => history.set(item.id, item)) },
      removeDownloadHistory: async() => [],
    },
    '@/utils/fs': { privateStorageDirectoryPath: '/private', temporaryDirectoryPath: '/temp', unlink: async() => {} },
    '@/utils/localMediaMetadata': { writeDownloadMetadata: () => { tags++; return stage === 'tags' ? gate.promise : Promise.resolve() } },
    '@/utils/nativeModules/download': {
      onDownloadUpdate: callback => { listener = callback },
      getDownloadState: async() => null,
      enqueueDownload: async options => { enqueued.push(options); return `work-${options.taskId}` },
      removeDownload: async() => {},
      pauseDownload: async() => {},
    },
    '@/utils/tools': {},
    '@/utils/common': { sizeFormate: String },
  }, {
    setTimeout: (fn, delay) => { const id = ++nextTimer; clock.set(id, { fn, delay }); return id },
    clearTimeout: id => clock.delete(id),
    global: { app_event: { downloadCountUpdate() {}, downloadListUpdate() {}, downloadTaskUpdate() {} }, i18n: { t: key => key } },
  })
  return { api, gate, references, clock, enqueued, metrics: () => ({ calls, tags, lyrics }), emit: event => listener(event) }
}

runTest('completed songs refill the scheduling window after bounded metadata work is archived', async() => {
  const h = finalizationHarness('none', 4, 3)
  await h.api.initDownloads()
  await flush()
  assert.equal(h.enqueued.length, 0)
  assert.equal(h.metrics().tags, 2)
  for (const [id, timer] of [...h.clock]) if (timer.delay === 250) { h.clock.delete(id); timer.fn() }
  await flush()
  assert.equal(h.enqueued.length, 2)
  for (const [id, timer] of [...h.clock]) if (timer.delay === 250) { h.clock.delete(id); timer.fn() }
  await flush()
  assert.equal(h.enqueued.length, 3)
  assert.equal(h.metrics().tags, 4)
  assert.equal(await h.api.getDownloadCount(), 7)
})

runTest('deleting queued finalizations starts no more metadata requests and removes their completion waits', async() => {
  const h = finalizationHarness()
  await h.api.initDownloads()
  await flush()
  assert.equal(h.metrics().calls, 2)
  await h.api.removeTasks(Array.from({ length: 12 }, (_, i) => String(i)))
  await flush()
  assert.equal(await h.api.getDownloadCount(), 0)
  assert.deepEqual(h.metrics(), { calls: 2, tags: 0, lyrics: 0 })
  h.gate.resolve('')
  await flush()
  assert.deepEqual(h.metrics(), { calls: 2, tags: 0, lyrics: 0 })
})

for (const stage of ['pic', 'lyric', 'tags']) {
  runTest(`deleted tasks are collectable while their ${stage} transport remains pending in V8`, () => {
    const script = `
      const assert = require('node:assert/strict')
      const { finalizationHarness } = require('./tests/download-backpressure.test.cjs')
      const { flush } = require('./tests/helpers/load.cjs')
      ;(async () => {
        const h = finalizationHarness(${JSON.stringify(stage)})
        await h.api.initDownloads()
        await flush()
        await h.api.removeTasks(Array.from({ length: 12 }, (_, i) => String(i)))
        for (let i = 0; i < 12; i++) { await flush(); global.gc() }
        assert.ok(h.references.every(reference => reference.deref() === undefined))
        assert.equal(await h.api.getDownloadCount(), 0)
      })().catch(error => { console.error(error); process.exitCode = 1 })
    `
    const result = spawnSync(process.execPath, ['--expose-gc', '-e', script], { encoding: 'utf8', env: { ...process.env, LX_DOWNLOAD_GC_CHILD: '1' } })
    assert.equal(result.status, 0, result.stderr)
  })
}

module.exports = { finalizationHarness }
