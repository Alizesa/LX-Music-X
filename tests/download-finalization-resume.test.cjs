const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createHarness, task, deferred, flush } = require('./helpers/download-cleanup-runtime.cjs')

const pendingTask = (id = 'held') => ({ ...task(id), status: 'finalizing', filePath: 'content://fixture/audio', pendingCompletion: { downloaded: 1024, total: 1024 } })
const suspend = async h => {
  const controller = new AbortController()
  const work = h.api.preparePendingDownloads(controller.signal, () => true)
  const cancelled = assert.rejects(work, /取消http请求/)
  await flush()
  controller.abort()
  await cancelled
  await flush()
}

for (const state of ['pending', 'finished', 'failed']) {
  test(`resuming a suspended finalization reuses its ${state} native tag write`, async() => {
    const writing = deferred(); const calls = []; const covers = []
    const h = await createHarness({
      active: [pendingTask()],
      cover: {
        download: async(url, path) => { covers.push(path) },
        metadata: (...args) => { calls.push(args); return writing.promise },
      },
    })
    await h.api.initDownloads(); await flush()
    assert.equal(calls.length, 1)
    await suspend(h)
    if (state === 'finished') { writing.resolve(); await flush() }
    if (state === 'failed') { writing.reject(new Error('native tags failed')); await flush() }
    for (let attempt = 0; attempt < 3; attempt++) {
      await h.api.initDownloads(); await flush()
      assert.equal(calls.length, 1)
      assert.equal(covers.length, 1)
      if (state === 'pending') await suspend(h)
    }
    await h.api.initDownloads(); await flush()
    writing.resolve(); await flush(); await h.run(250)
    assert.equal(h.api.isDownloadCompleted('held'), true)
    assert.deepEqual([...h.local], ['content://fixture/audio'])
    assert.equal(calls.length, 1)
    assert.equal(h.protectedPaths.size, 0)
  })
}

test('an abandoned cover download cannot remove the next attempt cover', async() => {
  const firstDownload = deferred(); const writing = deferred(); const covers = []; const calls = []
  const h = await createHarness({
    active: [pendingTask()],
    cover: {
      download: (url, path) => { covers.push(path); return covers.length === 1 ? firstDownload.promise : Promise.resolve() },
      metadata: (...args) => { calls.push(args); return writing.promise },
    },
  })
  await h.api.initDownloads(); await flush(); await suspend(h)
  await h.api.initDownloads(); await flush()
  assert.equal(covers.length, 2)
  assert.notEqual(covers[0], covers[1])
  assert.equal(calls.length, 1)
  assert.equal(calls[0][2], covers[1])
  firstDownload.resolve(); await flush()
  assert.equal(h.files.has(covers[0]), false)
  assert.equal(h.files.has(covers[1]), true)
  assert.equal(h.protectedPaths.has(covers[1]), true)
  writing.resolve(); await flush(); await h.run(250)
  assert.equal(h.protectedPaths.size, 0)
  assert.equal(h.api.isDownloadCompleted('held'), true)
})

test('a different task targeting the same audio waits for the earlier native writer', async() => {
  const first = deferred(); const second = deferred(); const calls = []
  const h = await createHarness({
    active: [pendingTask('first'), pendingTask('second')],
    cover: { download: async() => {}, metadata: (...args) => { calls.push(args); return calls.length === 1 ? first.promise : second.promise } },
  })
  await h.api.initDownloads(); await flush()
  assert.equal(calls.length, 1)
  first.resolve(); await flush()
  assert.equal(calls.length, 2)
  assert.notEqual(calls[0][2], calls[1][2])
  assert.equal(h.files.has(calls[1][2]), true)
  second.resolve(); await flush(); await h.run(250)
  assert.equal(h.api.isDownloadCompleted('first'), true)
  assert.equal(h.api.isDownloadCompleted('second'), true)
})
