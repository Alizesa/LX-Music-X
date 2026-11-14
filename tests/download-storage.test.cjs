const assert = require('node:assert/strict')
const { test } = require('node:test')
const { harness: storageHarness, indexKey, itemPrefix, legacyKey, keyFor, constants } = require('./helpers/download-storage.cjs')
const { harness, task, flush, deferred } = require('./helpers/download-runtime.cjs')

test('download startup and scheduling write a linear number of independent task records', async t => {
  const tasks = Array.from({ length: 100 }, (_, i) => task(`task-${i}`))
  const disk = storageHarness([[legacyKey, JSON.stringify(tasks)]])
  const h = harness({ data: disk.data })
  await h.api.initDownloads()
  for (let i = 0; i < 30 && h.enqueued.length < tasks.length; i++) await flush()
  await flush()
  assert.equal(h.enqueued.length, tasks.length)
  const records = disk.writes.flat().filter(([key]) => key.startsWith(itemPrefix))
  assert.ok(records.length >= tasks.length && records.length <= tasks.length * 3, `wrote ${records.length} task records`)
  t.diagnostic(`metrics: download_tasks=${tasks.length}, serialized_task_records=${records.length}`)
  assert.equal(disk.writes.flat().filter(([key]) => key === indexKey).length, 1)
  assert.equal(disk.writes.flat().filter(([key]) => key === legacyKey).length, 0)
  const restarted = await disk.createData().getDownloadActiveTasks()
  assert.equal(restarted.length, tasks.length)
  assert.ok(restarted.every(item => item.nativeId === `work-${item.id}`))
})

test('failed active-task migration preserves the legacy array and retries atomically', async() => {
  const tasks = [task('first'), task('second')]
  const disk = storageHarness([[legacyKey, JSON.stringify(tasks)]])
  const write = disk.native.multiSet
  disk.native.multiSet = async() => { throw new Error('disk unavailable') }
  await assert.rejects(disk.data.saveDownloadActiveTasks(tasks), /disk unavailable/)
  assert.equal(disk.values.has(legacyKey), true)
  assert.equal(disk.values.has(indexKey), false)
  const restart = disk.createData()
  assert.deepEqual(Array.from(await restart.getDownloadActiveTasks(), item => item.id), ['first', 'second'])
  disk.native.multiSet = write
  await restart.saveDownloadActiveTasks(tasks)
  assert.equal(disk.values.has(legacyKey), false)
  assert.equal(disk.writes.length, 1)
  assert.ok(disk.writes[0].some(([key]) => key === indexKey))
  assert.deepEqual(Array.from(await disk.createData().getDownloadActiveTasks(), item => item.id), ['first', 'second'])
})

test('a changed active task persists native identity and finalization without serializing other songs', async() => {
  const tasks = [task('changed'), task('untouched')]
  const disk = storageHarness()
  await disk.data.saveDownloadActiveTasks(tasks)
  disk.writes.length = 0
  tasks[0].nativeId = 'native-one'
  tasks[0].status = 'finalizing'
  tasks[0].filePath = 'content://fixture/finished'
  tasks[0].pendingCompletion = { downloaded: 120, total: 120 }
  Object.defineProperty(tasks[1].musicInfo, 'name', { get() { throw new Error('serialized unchanged song') } })
  await disk.data.saveDownloadActiveTasks(tasks, new Set(['changed']))
  assert.deepEqual(disk.writes.flat().map(([key]) => key), [keyFor('changed')])
  const [saved] = await disk.createData().getDownloadActiveTasks()
  assert.equal(saved.nativeId, 'native-one')
  assert.equal(saved.filePath, 'content://fixture/finished')
  assert.equal(saved.pendingCompletion.downloaded, 120)
})

test('active-task membership and records commit together; orphan cleanup never resurrects a deleted task', async() => {
  const disk = storageHarness()
  await disk.data.saveDownloadActiveTasks([task('old'), task('kept')])
  const remove = disk.native.multiRemove
  disk.native.multiRemove = async keys => {
    if (keys.includes(keyFor('old'))) throw new Error('cleanup unavailable')
    await remove(keys)
  }
  await disk.data.saveDownloadActiveTasks([task('new'), task('kept')], new Set(['new']))
  assert.equal(disk.values.has(keyFor('old')), true)
  disk.native.multiRemove = remove
  assert.deepEqual(Array.from(await disk.createData().getDownloadActiveTasks(), item => item.id), ['new', 'kept'])
  assert.equal(disk.values.has(keyFor('old')), false)
})

test('a missing indexed active task is a read error instead of an empty replacement', async() => {
  const disk = storageHarness()
  await disk.data.saveDownloadActiveTasks([task('missing')])
  disk.values.delete(keyFor('missing'))
  const before = disk.writes.length
  await assert.rejects(disk.createData().getDownloadActiveTasks(), /missing|invalid/i)
  assert.equal(disk.writes.length, before)
})

test('fragmented task records round-trip, shrink and remove all of their fragments', async() => {
  const value = task('large/id')
  value.musicInfo.meta.extra = 'x'.repeat(510000)
  const disk = storageHarness()
  await disk.data.saveDownloadActiveTasks([value])
  assert.equal((await disk.createData().getDownloadActiveTasks())[0].musicInfo.meta.extra.length, 510000)
  await disk.data.saveDownloadActiveTasks([])
  assert.deepEqual([...disk.values.keys()], [indexKey])
})

test('older combined download snapshots still migrate into independent active records', async() => {
  const disk = storageHarness([[constants.storageDataPrefix.downloadTasks, JSON.stringify([{ ...task('paused'), status: 'pause' }])]])
  const h = harness({ data: disk.data })
  await h.api.initDownloads()
  await flush()
  assert.equal((await disk.createData().getDownloadActiveTasks())[0].status, 'pause')
  assert.equal(disk.values.has(constants.storageDataPrefix.downloadTasks), false)
  assert.equal(disk.values.has(keyFor('paused')), true)
})

test('failed incremental membership writes preserve both the old index and task states', async() => {
  const disk = storageHarness()
  await disk.data.saveDownloadActiveTasks([task('old'), task('kept')])
  const before = [...disk.values]
  const write = disk.native.multiSet
  disk.native.multiSet = async() => { throw new Error('transaction failed') }
  await assert.rejects(disk.data.saveDownloadActiveTasks([task('new'), task('kept')], new Set(['new'])), /transaction failed/)
  assert.deepEqual([...disk.values], before)
  disk.native.multiSet = write
  await disk.data.saveDownloadActiveTasks([task('new'), task('kept')], new Set(['new']))
  assert.deepEqual(Array.from(await disk.createData().getDownloadActiveTasks(), item => item.id), ['new', 'kept'])
})

test('a newer pause is still persisted when an older resolving write fails', async() => {
  const disk = storageHarness([[legacyKey, JSON.stringify([{ ...task('one'), status: 'pause' }])]])
  await disk.data.saveDownloadPath({ uri: 'content://fixture/dir' })
  const h = harness({ data: disk.data })
  await h.api.initDownloads()
  await flush()
  const gate = deferred(); const write = disk.native.multiSet
  let blocked = false
  disk.native.multiSet = async items => {
    if (!blocked && items.some(([key, value]) => key === keyFor('one') && JSON.parse(value).status === 'resolving')) {
      blocked = true
      await gate.promise
    }
    await write(items)
  }
  await h.api.retryTask('one')
  await flush()
  assert.equal(blocked, true)
  const pause = h.api.pauseTask('one')
  await flush()
  gate.reject(new Error('old write failed'))
  await pause
  await flush()
  assert.equal((await disk.createData().getDownloadActiveTasks())[0].status, 'pause')
  assert.equal(h.enqueued.length, 0)
})
