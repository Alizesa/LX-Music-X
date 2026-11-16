const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createHarness, task, completed, deferred, flush } = require('./helpers/download-cleanup-runtime.cjs')
const { song } = require('./helpers/download-runtime.cjs')

const bad = () => {
  const value = { ...task('bad'), status: 'pause', nativeId: 'old-work' }
  value.musicInfo.meta._qualitys['128k'] = { size: '10M' }
  return value
}

test('a rejected-file cleanup releases the headless waiter but persists error and ownership through restart', async() => {
  const gate = deferred()
  const h = await createHarness({ active: [bad()], catalog: { beforeUnlink: async path => { if (path === 'content://bad') await gate.promise } } })
  await h.api.initDownloads(); await flush()
  h.files.add('content://bad')
  h.files.add('/private/downloads/bad.part')
  const state = completed('bad', 'old-work', 'content://bad', 1)
  h.receipts.set('old-work', state)
  h.emit(state)
  await flush()
  assert.equal(h.api.getDownloadTaskItem('bad').status, 'error')
  assert.equal(h.journalKeys().length, 1)
  const controller = new AbortController()
  const preparation = h.api.preparePendingDownloads(controller.signal, () => true)
  const cancelled = assert.rejects(preparation, /取消http请求/)
  await flush()
  controller.abort()
  await cancelled
  assert.equal(h.api.getDownloadTaskItem('bad').status, 'error')
  assert.equal(h.receipts.size, 1)
  assert.equal(h.files.has('content://bad'), true)
  assert.equal((await h.data.getDownloadActiveTasks())[0].status, 'error')
  gate.resolve()
  await flush()
  assert.equal(h.files.size, 0)
  assert.equal(h.receipts.size, 0)
  assert.equal(h.journalKeys().length, 0)
  const restarted = h.restart()
  await restarted.api.initDownloads(); await flush()
  assert.equal(restarted.api.getDownloadTaskItem('bad').status, 'error')
  assert.equal(h.urlCalls(), 0)
  assert.equal(h.enqueued.length, 0)
})

test('cold recovery classifies a files tombstone as error before consuming a pruned completion', async() => {
  const value = { ...bad(), status: 'finalizing', filePath: 'content://bad' }
  const h = await createHarness({ active: [value] })
  h.files.add('content://bad')
  h.files.add('/private/downloads/bad.part')
  await h.data.saveDownloadCleanupRecord(h.data.getDownloadCleanupKey('crashed'), {
    kind: 'files',
    deleteFile: true,
    targets: [{ id: 'bad', nativeId: 'old-work', filePath: 'content://bad' }, { id: 'bad', filePath: '/private/downloads/bad.part' }],
  })
  await h.api.initDownloads(); await flush()
  assert.equal(h.api.getDownloadTaskItem('bad').status, 'error')
  assert.equal(h.files.size, 0)
  assert.equal(h.urlCalls(), 0)
  assert.equal(h.enqueued.length, 0)
  assert.equal(h.journalKeys().length, 0)
})

test('a rejected-file journal write failure keeps its receipt and can retry cleanup without new HTTP', async() => {
  const h = await createHarness({ active: [bad()] })
  await h.api.initDownloads(); await flush()
  const write = h.disk.native.multiSet
  let fail = true
  h.disk.native.multiSet = async rows => {
    if (fail && rows.some(([key]) => key.startsWith('@download_cleanup__'))) throw new Error('journal failed')
    return write(rows)
  }
  h.files.add('content://bad')
  h.receipts.set('old-work', completed('bad', 'old-work', 'content://bad', 1))
  h.emit(h.receipts.get('old-work'))
  await flush()
  assert.equal(h.api.getDownloadTaskItem('bad').status, 'error')
  assert.equal(h.files.size, 1)
  assert.equal(h.receipts.size, 1)
  fail = false
  await h.api.retryTask('bad'); await flush()
  assert.equal(h.files.size, 0)
  assert.equal(h.receipts.size, 0)
  assert.equal(h.urlCalls(), 0)
})

test('rejected cleanup uses the native work owner and cannot unlink a newer work partial', async() => {
  const h = await createHarness({ active: [bad()] })
  await h.api.initDownloads(); await flush()
  h.files.add('content://bad')
  h.files.add('/private/downloads/bad.part')
  h.partialOwners.set('bad', 'new-work')
  h.receipts.set('old-work', completed('bad', 'old-work', 'content://bad', 1))
  h.emit(h.receipts.get('old-work'))
  await flush()
  assert.equal(h.files.has('/private/downloads/bad.part'), true)
  assert.equal(h.partialOwners.get('bad'), 'new-work')
  assert.ok(h.removedNative.some(item => item.nativeId === 'old-work' && item.deletePartial))
  assert.equal(h.removed.includes('/private/downloads/bad.part'), false)
})

test('an error-classification save failure retains the journal and receipt for cold recovery', async() => {
  const h = await createHarness({ active: [bad()] })
  await h.api.initDownloads(); await flush()
  const write = h.disk.native.multiSet
  let fail = true
  h.disk.native.multiSet = async rows => {
    if (fail && rows.some(([key, value]) => key.startsWith('@download_active_item__') && JSON.parse(value).status === 'error')) throw new Error('classification write failed')
    return write(rows)
  }
  h.files.add('content://bad')
  h.receipts.set('old-work', completed('bad', 'old-work', 'content://bad', 1))
  h.emit(h.receipts.get('old-work'))
  await flush()
  assert.equal(h.files.has('content://bad'), true)
  assert.equal(h.receipts.size, 1)
  assert.equal(h.journalKeys().length, 1)
  fail = false
  const restarted = h.restart()
  await restarted.api.initDownloads(); await flush()
  assert.equal(restarted.api.getDownloadTaskItem('bad').status, 'error')
  assert.equal(h.files.has('content://bad'), false)
  assert.equal(h.receipts.size, 0)
  assert.equal(h.journalKeys().length, 0)
  assert.equal(h.urlCalls(), 0)
})

test('deleting a cancelled rejection and adding a new object with the same ID cannot receive its old completion', async() => {
  const id = 'tx_bad_128k_content://fixture/dir'
  const value = { ...bad(), id, musicInfo: song('bad') }
  value.musicInfo.meta._qualitys['128k'] = { size: '10M' }
  const gate = deferred(); let unlinks = 0
  const h = await createHarness({ active: [value], catalog: { beforeUnlink: async path => { if (path === 'content://bad') { unlinks++; await gate.promise } } } })
  await h.api.initDownloads(); await flush()
  h.files.add('content://bad')
  const state = completed(id, 'old-work', 'content://bad', 1)
  h.receipts.set('old-work', state); h.emit(state)
  await flush()
  const controller = new AbortController()
  const preparation = h.api.preparePendingDownloads(controller.signal, () => true)
  const cancelled = assert.rejects(preparation, /取消http请求/)
  await flush(); controller.abort(); await cancelled
  const removal = h.api.removeTasks([id], false)
  await flush()
  assert.equal(unlinks, 1, 'removal shares the already running rejection cleanup')
  gate.resolve(); await removal
  await h.api.addTasks([song('bad')]); await flush()
  assert.equal(h.enqueued.length, 1)
  assert.equal(h.api.getDownloadTaskItem(id).status, 'waiting')
  h.files.add(`/private/downloads/${id}.part`)
  h.partialOwners.set(id, 'work-1')
  h.emit(state); await flush()
  assert.equal(h.api.getDownloadTaskItem(id).status, 'waiting')
  assert.equal(h.files.has(`/private/downloads/${id}.part`), true)
  assert.equal(h.removed.includes(`/private/downloads/${id}.part`), false)
})

test('cold rejection recovery does not classify a later native owner with the same task ID', async() => {
  const value = { ...bad(), status: 'pause', nativeId: 'new-work', filePath: 'content://new-file' }
  const h = await createHarness({ active: [value] })
  h.files.add('content://bad'); h.files.add('content://new-file')
  h.files.add('/private/downloads/bad.part'); h.partialOwners.set('bad', 'new-work')
  await h.data.saveDownloadCleanupRecord(h.data.getDownloadCleanupKey('old-rejection'), {
    kind: 'files', deleteFile: true, targets: [{ id: 'bad', nativeId: 'old-work', filePath: 'content://bad' }],
  })
  await h.api.initDownloads(); await flush()
  assert.equal(h.api.getDownloadTaskItem('bad').status, 'pause')
  assert.equal(h.api.getDownloadTaskItem('bad').filePath, 'content://new-file')
  assert.equal(h.files.has('content://new-file'), true)
  assert.equal(h.files.has('/private/downloads/bad.part'), true)
  assert.equal(h.files.has('content://bad'), false)
  assert.equal(h.urlCalls(), 0)
})

test('an old rejection cannot delete a URI now owned by a later task or its durable history', async() => {
  for (const archived of [false, true]) {
    const value = { ...bad(), status: 'pause', nativeId: 'new-work', filePath: 'content://reused' }
    const h = await createHarness({
      active: archived ? [] : [value],
      history: archived ? [{ id: 'bad', name: 'new', singer: '', quality: '128k', filePath: 'content://reused', createdAt: 2 }] : [],
    })
    h.files.add('content://reused')
    await h.data.saveDownloadCleanupRecord(h.data.getDownloadCleanupKey('old-rejection'), {
      kind: 'files', deleteFile: true, targets: [{ id: 'bad', nativeId: 'old-work', filePath: 'content://reused' }],
    })
    await h.api.initDownloads(); await flush()
    assert.equal(h.files.has('content://reused'), true)
    assert.equal(h.removed.includes('content://reused'), false)
    assert.equal(h.journalKeys().length, 0)
    if (archived) assert.equal(h.api.isDownloadCompleted('bad'), true)
    else assert.equal(h.api.getDownloadTaskItem('bad').status, 'pause')
  }
})
