const assert = require('node:assert/strict')
const { test } = require('node:test')
const { harness, song, task, deferred, flush } = require('./helpers/download-runtime.cjs')

for (const failCleanup of [false, true]) {
  test(`late bad-file cleanup cannot fail a replacement download when cleanup ${failCleanup ? 'fails' : 'succeeds'}`, async() => {
    const cleanup = deferred()
    const nextUrl = deferred()
    let cleaning = false
    let held = false
    let urls = 0
    let nativeId = 0
    const music = song('same-song')
    music.meta._qualitys['128k'] = { size: '10M' }
    const h = harness({
      url: async() => ++urls === 1 ? 'https://fixture.test/old' : nextUrl.promise,
      enqueue: async() => 'native-' + ++nativeId,
      unlink: async() => {
        if (cleaning && !held) { held = true; await cleanup.promise }
      },
    })
    const [id] = await h.api.addTasks([music])
    await flush()
    cleaning = true
    h.emitNative({ status: 'completed', nativeId: 'native-1', taskId: id, downloaded: 1, total: 1, filePath: 'content://old-file' })
    await flush()
    assert.equal(held, true)
    let removed = false
    const removing = h.api.removeTasks([id]).then(() => { removed = true; return null }, error => error)
    await flush()
    assert.equal(removed, false, 'a persisted rejected-file cleanup must finish before reusing its task ID')
    if (failCleanup) cleanup.reject(new Error('unlink failed'))
    else cleanup.resolve()
    const failure = await removing
    if (failCleanup) {
      assert.match(failure.message, /unlink failed/)
      await h.api.removeTasks([id])
    } else assert.equal(failure, null)
    assert.deepEqual(Array.from(await h.api.addTasks([music])), [id])
    await flush()
    assert.equal(h.api.getDownloadTaskItem(id).status, 'resolving')
    h.emitNative({ status: 'completed', nativeId: 'native-1', taskId: id, downloaded: 1, total: 1, filePath: 'content://old-file' })
    await flush()
    assert.equal(h.api.getDownloadTaskItem(id).status, 'resolving')
    nextUrl.resolve('https://fixture.test/new')
    await flush()
    assert.equal(h.api.getDownloadTaskItem(id).status, 'waiting')
    assert.equal(h.enqueued.length, 2)
    assert.equal(h.saved().find(item => item.id === id).nativeId, 'native-2')
  })
}

test('bad-file validation still persists an error for its current task', async() => {
  const music = song('bad-file')
  music.meta._qualitys['128k'] = { size: '10M' }
  const h = harness()
  const [id] = await h.api.addTasks([music])
  await flush()
  h.emitNative({ status: 'completed', nativeId: `work-${id}`, taskId: id, downloaded: 1, total: 1, filePath: 'content://bad-file' })
  await flush()
  assert.equal(h.api.getDownloadTaskItem(id).status, 'error')
  assert.equal(h.saved().find(item => item.id === id).error, 'download_bad_size')
})

test('a task removed during an immediate save cannot publish an obsolete task update', async() => {
  const save = deferred()
  let hold = false
  let held = false
  const active = { ...task('old'), nativeId: 'old-native', status: 'pause' }
  const updates = []
  const h = harness({
    active: [active],
    save: async() => { if (hold && !held) { held = true; await save.promise } },
  })
  await h.api.initDownloads()
  await flush()
  await h.api.retryTask('old')
  await flush()
  h.app.on('downloadTaskUpdate', item => updates.push(item))
  hold = true
  h.emitNative({ status: 'error', nativeId: 'work-old', taskId: 'old', downloaded: 0, total: 0, error: 'old error' })
  await flush()
  assert.equal(held, true)
  const removing = h.api.removeTasks(['old'])
  await flush()
  save.resolve()
  await removing
  assert.equal(h.api.getDownloadTaskItem('old'), null)
  assert.equal(updates.filter(item => item.status === 'error').length, 0)
})
