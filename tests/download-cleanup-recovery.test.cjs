const assert = require('node:assert/strict')
const fs = require('node:fs')
const { test } = require('node:test')
const { createHarness, item, completed, task, flush } = require('./helpers/download-cleanup-runtime.cjs')

test('a second history page failure leaves a durable cleanup record and restart finishes every file and LOCAL row', async() => {
  const history = Array.from({ length: 150 }, (_, i) => item(i))
  const h = await createHarness({ history })
  await h.api.initDownloads()
  await flush()
  const remove = h.disk.native.multiRemove
  let pages = 0
  h.disk.native.multiRemove = async keys => {
    if (keys.some(key => key.startsWith('@download_history_item')) && ++pages === 2) throw new Error('second page failed')
    await remove(keys)
  }
  await assert.rejects(h.api.removeTasks(history.map(item => item.id), true), /second page failed/)
  assert.equal(h.journalKeys().length, 1)
  assert.equal(await h.api.getDownloadCount(), 50)
  assert.equal(h.files.size, 0)
  h.disk.native.multiRemove = remove
  const restarted = h.restart()
  await restarted.api.initDownloads()
  await flush()
  assert.equal(h.journalKeys().length, 0)
  assert.equal(h.files.size, 0)
  assert.equal(h.local.size, 0)
  assert.equal(await restarted.api.getDownloadCount(), 0)
})

for (const failure of ['file', 'LOCAL', 'active snapshot']) {
  test(`${failure} failure retains cleanup ownership through restart`, async() => {
    const active = failure === 'active snapshot' ? [{ ...task('active'), status: 'pause', filePath: 'content://active' }] : []
    const h = await createHarness({ active, history: failure === 'active snapshot' ? [] : [item(1), item(2), item(3)] })
    if (active.length) { h.files.add('content://active'); h.local.add('content://active') }
    await h.api.initDownloads()
    await flush()
    if (failure === 'file') h.settings.failUnlink = 'content://fixture/2'
    if (failure === 'LOCAL') h.settings.failLocal = true
    const set = h.disk.native.multiSet
    if (failure === 'active snapshot') {
      h.disk.native.multiSet = async entries => {
        if (entries.some(([key]) => key === '@download_active_index')) throw new Error('active snapshot failed')
        await set(entries)
      }
    }
    await assert.rejects(h.api.removeTasks(active.length ? ['active'] : ['1', '2', '3'], true), /failed/)
    assert.equal(h.journalKeys().length, 1)
    h.settings.failUnlink = null; h.settings.failLocal = false; h.disk.native.multiSet = set
    const restarted = h.restart()
    await restarted.api.initDownloads()
    await flush()
    assert.equal(h.journalKeys().length, 0)
    assert.equal(h.files.size, 0)
    assert.equal(h.local.size, 0)
    assert.equal(await restarted.api.getDownloadCount(), 0)
    assert.equal(h.urlCalls(), 0)
  })
}

test('a cleanup-record save failure removes neither the audio file nor its archive', async() => {
  const h = await createHarness({ history: [item(1)] })
  await h.api.initDownloads()
  await flush()
  h.disk.native.multiSet = async entries => {
    if (entries.some(([key]) => key.startsWith('@download_cleanup__'))) throw new Error('journal failed')
  }
  await assert.rejects(h.api.removeTasks(['1'], true), /journal failed/)
  assert.equal(h.files.size, 1)
  assert.equal(h.local.size, 1)
  assert.equal(await h.api.getDownloadCount(), 1)
})

test('both rejected-size destination files are deleted before retrying and completion receipts are acknowledged', async() => {
  const value = { ...task('bad'), status: 'pause', nativeId: 'old-work' }
  value.musicInfo.meta._qualitys['128k'] = { size: '10M' }
  const h = await createHarness({ active: [value] })
  await h.api.initDownloads()
  await flush()
  for (const [nativeId, path] of [['old-work', 'content://bad-first'], ['work-1', 'content://bad-second']]) {
    h.files.add(path)
    h.files.add('/private/downloads/bad.part')
    const state = completed('bad', nativeId, path, 1)
    h.receipts.set(nativeId, state)
    h.emit(state)
    await flush()
    assert.equal(h.files.has(path), false)
    assert.equal(h.files.has('/private/downloads/bad.part'), false)
    assert.equal(h.api.getDownloadTaskItem('bad').status, 'error')
    assert.equal(h.receipts.has(nativeId), false)
    assert.equal(h.journalKeys().length, 0)
    if (nativeId === 'old-work') { await h.api.retryTask('bad'); await flush() }
  }
  assert.equal(h.files.size, 0)
  assert.equal(h.enqueued.length, 1)
})

test('a failed rejected-file cleanup survives restart and completes before a new URL is resolved', async() => {
  const value = { ...task('bad'), status: 'pause', nativeId: 'old-work' }
  value.musicInfo.meta._qualitys['128k'] = { size: '10M' }
  const h = await createHarness({ active: [value] })
  await h.api.initDownloads()
  await flush()
  const path = 'content://bad-file'
  h.files.add(path); h.settings.failUnlink = path
  const state = completed('bad', 'old-work', path, 1)
  h.receipts.set('old-work', state)
  h.emit(state)
  await flush()
  assert.equal(h.files.has(path), true)
  assert.equal(h.journalKeys().length, 1)
  assert.equal(h.receipts.size, 1)
  h.settings.failUnlink = null
  const restarted = h.restart()
  await restarted.api.initDownloads()
  await flush()
  assert.equal(h.files.has(path), false)
  assert.equal(h.journalKeys().length, 0)
  assert.equal(h.receipts.size, 0)
  await restarted.api.retryTask('bad')
  await flush()
  assert.equal(h.enqueued.length, 1)
})

test('a completed native receipt restores a file even when the enqueue identity was not saved', async() => {
  const state = completed('ready', 'receipt-work', 'content://ready')
  const h = await createHarness({ active: [{ ...task('ready'), status: 'resolving' }], receipts: new Map([['receipt-work', state]]) })
  await h.api.initDownloads()
  await flush()
  await h.run(250)
  assert.equal(h.urlCalls(), 0)
  assert.equal(h.enqueued.length, 0)
  assert.equal(h.api.isDownloadCompleted('ready'), true)
  assert.equal(h.local.has('content://ready'), true)
  assert.equal(h.receipts.size, 0)
})

test('archive write failure retains the native completion through restart without a second download', async() => {
  const state = completed('ready', 'receipt-work', 'content://ready')
  const h = await createHarness({ active: [{ ...task('ready'), nativeId: 'receipt-work', status: 'run' }], receipts: new Map([['receipt-work', state]]) })
  const set = h.disk.native.multiSet
  h.disk.native.multiSet = async values => {
    if (values.some(([key]) => key.startsWith('@download_history_item'))) throw new Error('archive failed')
    await set(values)
  }
  await h.api.initDownloads()
  await flush()
  await h.run(250)
  assert.equal(h.api.isDownloadCompleted('ready'), false)
  assert.equal(h.receipts.size, 1)
  h.disk.native.multiSet = set
  const restarted = h.restart()
  await restarted.api.initDownloads()
  await flush()
  await restarted.run(250)
  assert.equal(restarted.api.isDownloadCompleted('ready'), true)
  assert.equal(h.receipts.size, 0)
  assert.equal(h.urlCalls(), 0)
})

test('a failed acknowledgment is retried after durable history wins on restart', async() => {
  const state = completed('ready', 'receipt-work', 'content://ready')
  const h = await createHarness({ active: [{ ...task('ready'), nativeId: 'receipt-work', status: 'run' }], receipts: new Map([['receipt-work', state]]) })
  h.settings.failAck = true
  await h.api.initDownloads()
  await flush()
  await h.run(250)
  assert.equal(h.api.isDownloadCompleted('ready'), true)
  assert.equal(h.receipts.size, 1)
  h.settings.failAck = false
  const restarted = h.restart()
  await restarted.api.initDownloads()
  await flush()
  assert.equal(h.receipts.size, 0)
  assert.equal(h.urlCalls(), 0)
})

test('native completion persistence precedes the event and lives outside the evictable cache', () => {
  const directory = 'android/app/src/main/java/cn/toside/music/mobile/download/'
  const worker = fs.readFileSync(directory + 'MusicDownloadWorker.java', 'utf8')
  const store = fs.readFileSync(directory + 'DownloadCompletionStore.java', 'utf8')
  const module = fs.readFileSync(directory + 'DownloadModule.java', 'utf8')
  assert.ok(worker.indexOf('DownloadCompletionStore.save(') < worker.indexOf('sendUpdate(taskId, "completed"'))
  assert.match(store, /context\.getFilesDir\(\)/)
  assert.match(store, /output\.getFD\(\)\.sync\(\)/)
  assert.match(store, /file\.finishWrite\(output\)/)
  assert.match(store, /file\.failWrite\(output\)/)
  assert.ok(module.indexOf('DownloadCompletionStore.read(reactContext, workId)') < module.indexOf('getWorkInfoById(UUID.fromString(workId))'))
})
