const assert = require('node:assert/strict')
const { test } = require('node:test')
const { harness, task, deferred, flush } = require('./helpers/download-runtime.cjs')

for (const resume of ['retryTask', 'resumeAllTasks']) {
  for (const pause of ['pauseTask', 'pauseAllTasks']) {
    for (const stage of ['directory', 'native cancellation', 'storage']) {
      test(`${pause} supersedes ${resume} while ${stage} is pending`, async() => {
        const gate = deferred()
        let saving = false
        const active = { ...task('paused'), nativeId: 'old-native', status: 'pause' }
        const h = harness({
          active: [active],
          remove: async() => { if (stage === 'native cancellation') await gate.promise },
          save: async() => { if (saving && stage === 'storage') await gate.promise },
        })
        await h.api.initDownloads()
        await flush()
        saving = true
        if (stage === 'directory') h.data.getDownloadPath = async() => gate.promise
        const resuming = h.api[resume]('paused')
        await flush()
        assert.equal(h.removed.length, stage === 'directory' ? 0 : 1)
        const pausing = h.api[pause]('paused')
        await flush()
        gate.resolve({ uri: 'content://changed-directory' })
        await Promise.all([resuming, pausing])
        await flush()
        assert.equal(h.api.getDownloadTaskItem('paused').status, 'pause')
        assert.equal(h.enqueued.length, 0)
        assert.equal(h.saved()[0].directoryUri, active.directoryUri)
      })
    }
  }
}

test('a newer resume after pause can finish before the old cancellation without being overwritten', async() => {
  const gates = [deferred(), deferred()]
  let cancellations = 0
  const h = harness({
    active: [{ ...task('paused'), nativeId: 'old-native', status: 'pause' }],
    remove: async() => gates[cancellations++].promise,
  })
  await h.api.initDownloads()
  await flush()
  const first = h.api.retryTask('paused')
  await flush()
  await h.api.pauseAllTasks()
  const second = h.api.retryTask('paused')
  await flush()
  assert.equal(cancellations, 2)
  gates[1].resolve()
  await second
  await flush()
  assert.equal(h.enqueued.length, 1)
  gates[0].resolve()
  await first
  await flush()
  assert.equal(h.enqueued.length, 1)
  assert.equal(h.saved()[0].nativeId, 'work-paused')
  assert.equal(h.api.getDownloadTaskItem('paused').status, 'waiting')
})

test('concurrent resume clicks create only the latest native download', async() => {
  const gates = [deferred(), deferred()]
  let cancellations = 0
  const h = harness({
    active: [{ ...task('paused'), nativeId: 'old-native', status: 'pause' }],
    remove: async() => gates[cancellations++].promise,
  })
  await h.api.initDownloads()
  await flush()
  const first = h.api.retryTask('paused')
  await flush()
  const second = h.api.retryTask('paused')
  await flush()
  assert.equal(cancellations, 2)
  gates[0].resolve()
  await first
  await flush()
  assert.equal(h.enqueued.length, 0)
  gates[1].resolve()
  await second
  await flush()
  assert.equal(h.enqueued.length, 1)
})

test('a completion received during cancellation retains its file and finalization instead of restarting', async() => {
  const gate = deferred()
  const h = harness({
    active: [{ ...task('paused'), nativeId: 'old-native', status: 'pause' }],
    remove: async() => gate.promise,
  })
  await h.api.initDownloads()
  await flush()
  const resuming = h.api.retryTask('paused')
  await flush()
  h.emitNative({ taskId: 'paused', nativeId: 'old-native', status: 'completed', downloaded: 1024, total: 1024, filePath: 'content://completed' })
  await flush()
  assert.equal(h.api.getDownloadTaskItem('paused').status, 'finalizing')
  gate.resolve()
  await resuming
  await flush()
  assert.equal(h.api.getDownloadTaskItem('paused').status, 'finalizing')
  assert.equal(h.api.getDownloadTaskItem('paused').filePath, 'content://completed')
  assert.equal(h.enqueued.length, 0)
})

test('a cancelled directory read discards its error while a current failure remains visible', async() => {
  for (const cancel of [false, true]) {
    const gate = deferred()
    const h = harness({ active: [{ ...task('paused'), status: 'pause' }] })
    await h.api.initDownloads()
    await flush()
    h.data.getDownloadPath = async() => gate.promise
    const pending = h.api.retryTask('paused')
    const result = pending.then(() => null, error => error)
    await flush()
    if (cancel) await h.api.pauseAllTasks()
    gate.reject(new Error('directory unavailable'))
    if (cancel) assert.equal(await result, null)
    else assert.match((await result).message, /directory unavailable/)
    assert.equal(h.enqueued.length, 0)
    assert.equal(h.api.getDownloadTaskItem('paused').status, 'pause')
  }
})
