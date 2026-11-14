const assert = require('node:assert/strict')
const { test } = require('node:test')
const { spawnSync } = require('node:child_process')
const { harness, task, song, deferred, flush } = require('./helpers/download-runtime.cjs')

test('bulk download preparation bounds file operations and processes every path despite individual failures', async() => {
  const gate = deferred(); const url = deferred()
  let pending = 0; let peak = 0; let count = 0
  const h = harness({
    url: () => url.promise,
    unlink: async() => {
      const current = ++count
      pending++; peak = Math.max(peak, pending)
      try { await gate.promise; if (current % 7 === 0) throw new Error('missing file') } finally { pending-- }
    },
  })
  const add = h.api.addTasks(Array.from({ length: 1000 }, (_, i) => song(`song-${i}`)))
  await flush()
  const initial = pending
  gate.resolve()
  assert.equal((await add).length, 1000)
  await h.api.pauseAllTasks()
  url.resolve('https://fixture.test/unused')
  await flush()
  assert.ok(initial > 0 && initial <= 4)
  assert.equal(peak, 4)
  assert.equal(count, 1000)
  assert.equal(pending, 0)
})

test('bulk removal bounds native file deletion and still removes the entire selected history', async() => {
  const gate = deferred()
  let pending = 0; let peak = 0; let count = 0
  const history = Array.from({ length: 600 }, (_, i) => ({ id: `done-${i}`, filePath: `content://fixture/${i}`, createdAt: i }))
  const h = harness({
    history,
    unlink: async() => {
      count++; pending++; peak = Math.max(peak, pending)
      try { await gate.promise } finally { pending-- }
    },
  })
  const removal = h.api.removeTasks(history.map(item => item.id), true)
  await flush()
  gate.resolve()
  await removal
  assert.equal(peak, 4)
  assert.equal(count, history.length)
  assert.equal(await h.api.getDownloadCount(), 0)
})

test('overlapping download batches share the same four file-operation slots', async() => {
  const gate = deferred(); const url = deferred()
  let active = 0; let peak = 0; let count = 0
  const h = harness({
    url: () => url.promise,
    unlink: async() => {
      active++; count++; peak = Math.max(peak, active)
      try { await gate.promise } finally { active-- }
    },
  })
  const first = h.api.addTasks(Array.from({ length: 50 }, (_, i) => song(`first-${i}`)))
  const second = h.api.addTasks(Array.from({ length: 50 }, (_, i) => song(`second-${i}`)))
  await flush()
  gate.resolve()
  await Promise.all([first, second])
  await h.api.pauseAllTasks()
  url.resolve('https://fixture.test/unused')
  await flush()
  assert.equal(peak, 4)
  assert.equal(count, 100)
})

for (const operation of ['pause', 'remove']) {
  test(`${operation} cancels URL resolution and advances downloads without waiting for a late transport`, async() => {
    const old = deferred()
    const calls = []; let cancellations = 0
    const h = harness({
      active: [task('first'), task('second')],
      url: args => {
        calls.push(args.musicInfo.id)
        args.onCancel?.(() => { cancellations++ })
        return args.musicInfo.id === 'first' ? old.promise : Promise.resolve('https://fixture.test/second')
      },
    })
    await h.api.initDownloads()
    await flush()
    if (operation === 'pause') await h.api.pauseTask('first')
    else await h.api.removeTasks(['first'])
    await flush()
    const cancelledBeforeSettlement = cancellations
    const callsBeforeSettlement = [...calls]
    old.resolve('https://fixture.test/stale')
    await flush()
    assert.equal(cancelledBeforeSettlement, 1)
    assert.deepEqual(callsBeforeSettlement, ['first', 'second'])
    assert.deepEqual(h.enqueued.map(item => item.taskId), ['second'])
    assert.equal(h.api.getDownloadTaskItem('first')?.status ?? null, operation === 'pause' ? 'pause' : null)
  })
}

test('resuming a cancelled resolution starts a new request and late cancel handles cannot affect it', async() => {
  const first = deferred(); const second = deferred()
  const requests = []; const cancelled = []
  const h = harness({
    active: [task('same')],
    url: args => {
      const index = requests.length
      requests.push(args)
      args.onCancel?.(() => { cancelled.push(index) })
      return index === 0 ? first.promise : second.promise
    },
  })
  await h.api.initDownloads()
  await flush()
  await h.api.pauseTask('same')
  await h.api.retryTask('same')
  await flush()
  const startedBeforeOldSettled = requests.length
  requests[0].onCancel?.(() => { cancelled.push('late-old') })
  first.resolve('https://fixture.test/old')
  await flush()
  second.resolve('https://fixture.test/current')
  await flush()
  assert.equal(startedBeforeOldSettled, 2)
  assert.deepEqual(cancelled, [0, 'late-old'])
  assert.deepEqual(h.enqueued.map(item => item.url), ['https://fixture.test/current'])
})

test('a permanently pending cancelled URL transport does not retain its deleted download task', () => {
  const result = spawnSync(process.execPath, ['--expose-gc', '-e', `
    const assert = require('node:assert/strict')
    const { harness, task, deferred, flush } = require('./tests/helpers/download-runtime.cjs')
    ;(async () => {
      const transport = deferred()
      let reference
      const h = harness({ url: () => transport.promise, data: {
        getDownloadActiveTasks: async () => {
          const value = task('deleted')
          reference = new WeakRef(value)
          return [value]
        },
      } })
      await h.api.initDownloads()
      await flush()
      await h.api.removeTasks(['deleted'])
      for (let index = 0; index < 10; index++) { await flush(); global.gc() }
      assert.equal(reference.deref(), undefined)
      assert.equal(await h.api.getDownloadCount(), 0)
      transport.resolve('https://fixture.test/late')
      await flush()
      assert.equal(h.enqueued.length, 0)
    })().catch(error => { console.error(error); process.exitCode = 1 })
  `], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('throwing cancellation hooks cannot block later downloads or turn a pause into an error', async() => {
  const old = deferred()
  const h = harness({
    active: [task('old'), task('next')],
    url: args => {
      args.onCancel?.(() => { throw new Error('native abort failed') })
      return args.musicInfo.id === 'old' ? old.promise : Promise.resolve('https://fixture.test/next')
    },
  })
  await h.api.initDownloads()
  await flush()
  await h.api.pauseTask('old')
  await flush()
  assert.equal(h.api.getDownloadTaskItem('old').status, 'pause')
  assert.deepEqual(h.enqueued.map(item => item.taskId), ['next'])
  old.reject(new Error('late transport failure'))
  await flush()
})

test('duplicate additions during file preparation neither replace the accepted task nor clean its partial twice', async() => {
  const gate = deferred()
  let cleanups = 0
  const h = harness({ unlink: async() => { cleanups++; await gate.promise } })
  const first = h.api.addTasks([song('duplicate')])
  const second = h.api.addTasks([song('duplicate')])
  await flush()
  gate.resolve()
  const accepted = await Promise.all([first, second])
  await flush()
  assert.equal(accepted.flat().length, 1)
  assert.equal(cleanups, 1)
  assert.equal(h.enqueued.length, 1)
  assert.equal(await h.api.getDownloadCount(), 1)
})

test('readding a removed download waits until its old native work has stopped before cleaning the same partial', async() => {
  const gate = deferred()
  let stopping = false; let cleanupsDuringStop = 0
  const h = harness({
    unlink: async() => { if (stopping) cleanupsDuringStop++ },
    remove: async() => { stopping = true; await gate.promise; stopping = false },
  })
  const [id] = await h.api.addTasks([song('again')])
  await flush()
  const removing = h.api.removeTasks([id])
  await flush()
  assert.equal(stopping, true)
  const adding = h.api.addTasks([song('again')])
  await flush()
  gate.resolve()
  await Promise.all([removing, adding])
  await flush()
  assert.equal(cleanupsDuringStop, 0)
  assert.equal(h.enqueued.length, 2)
})
