const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { test } = require('node:test')
const { deferred, flush } = require('./helpers/load.cjs')
const { manifest } = require('./helpers/release.cjs')
const { updateDownloadHarness } = require('./helpers/update-download.cjs')

const observe = promise => {
  const result = { settled: false }
  result.promise = promise.then(value => { result.settled = true; result.value = value }, error => { result.settled = true; result.error = error })
  return result
}

for (const outcome of ['resolve', 'reject']) {
  test(`cancelled updates settle before native ${outcome} and remove files only after native completion`, async() => {
    const h = updateDownloadHarness()
    const progress = []
    const pending = observe(h.updater.downloadNewVersion(manifest(), (...args) => progress.push(args)))
    await flush()
    const [jobId, job] = [...h.bridge.jobs][0]
    const file = job.options.toFile
    h.updater.cancelUpdateDownload()
    await flush()
    assert.equal(pending.settled, true, 'business cancellation must not await native I/O')
    assert.match(pending.error.message, /UPDATE_CANCELLED/)
    assert.equal(h.bridge.listeners.size, 0)
    assert.deepEqual(h.bridge.stops, [jobId])
    await h.updater.cleanupUpdateDownloads()
    assert.equal(h.files.has(file), true, 'a stopped but still open native writer must retain its path')
    assert.equal(h.removals.length, 0)
    h.bridge.emit('DownloadProgress', { jobId, bytesWritten: 100 })
    job[outcome](outcome === 'resolve' ? { statusCode: 200, bytesWritten: 12345 } : new Error('late native failure'))
    await flush()
    assert.deepEqual(h.removals, [file])
    assert.equal(h.files.size, 0)
    assert.equal(h.installs.length, 0)
    assert.equal(progress.length, 0)
  })
}

test('a replacement update can finish while a cancelled native download is still pending', async() => {
  const h = updateDownloadHarness()
  const old = observe(h.updater.downloadNewVersion(manifest()))
  await flush()
  const oldJob = [...h.bridge.jobs.values()][0]
  h.updater.cancelUpdateDownload()
  const fresh = h.updater.downloadNewVersion(manifest('1.9.4', 100004))
  await flush()
  assert.equal(old.settled, true)
  const newJob = [...h.bridge.jobs.values()][1]
  newJob.resolve({ statusCode: 200, bytesWritten: 12345 })
  await fresh
  assert.deepEqual(h.installs, [newJob.options.toFile])
  oldJob.reject(new Error('late cancellation'))
  await flush()
  assert.deepEqual(h.removals, [oldJob.options.toFile])
  assert.equal(h.files.has(newJob.options.toFile), true)
  assert.equal(h.updater.hasDownloadedUpdate('v1.9.4'), true)
})

for (const stage of ['cache cleanup', 'installed version', 'supported ABIs', 'file stat', 'checksum', 'installer version']) {
  test(`cancelling during ${stage} ends the business wait and prevents a late installer launch`, async() => {
    const gate = deferred()
    const h = updateDownloadHarness()
    const installed = { version: '1.9.2', versionCode: 79003 }
    let value
    if (stage === 'cache cleanup') { h.fileApi.readDir = () => gate.promise; value = [] }
    if (stage === 'installed version') { h.nativeApi.getInstalledAppInfo = () => gate.promise; value = installed }
    if (stage === 'supported ABIs') { h.nativeApi.getSupportedAbis = () => gate.promise; value = ['arm64-v8a'] }
    if (stage === 'file stat') { h.fileApi.stat = () => gate.promise; value = { size: 12345 } }
    if (stage === 'checksum') { h.fileApi.hash = () => gate.promise; value = 'b'.repeat(64) }
    if (stage === 'installer version') {
      let calls = 0
      h.nativeApi.getInstalledAppInfo = async() => ++calls === 1 ? installed : gate.promise
      value = installed
    }
    const pending = observe(h.updater.downloadNewVersion(manifest()))
    await flush()
    if (stage === 'file stat' || stage === 'checksum' || stage === 'installer version') {
      h.bridge.jobs.values().next().value.resolve({ statusCode: 200, bytesWritten: 12345 })
      await flush()
    }
    h.updater.cancelUpdateDownload()
    await flush()
    assert.equal(pending.settled, true)
    assert.match(pending.error.message, /UPDATE_CANCELLED/)
    let lateHashes = 0
    if (stage === 'file stat') h.fileApi.hash = async() => { lateHashes++; return 'b'.repeat(64) }
    gate.resolve(value)
    await flush()
    assert.equal(h.installs.length, 0)
    assert.equal(h.files.size, 0)
    assert.equal(lateHashes, 0)
  })
}

test('cancelling an installation retry releases concurrent callers before checksum completion', async() => {
  const h = updateDownloadHarness()
  const download = h.updater.downloadNewVersion(manifest())
  await flush()
  h.bridge.jobs.values().next().value.resolve({ statusCode: 200, bytesWritten: 12345 })
  await download
  const checksum = deferred()
  h.fileApi.hash = () => checksum.promise
  const first = observe(h.updater.updateApp())
  const second = observe(h.updater.updateApp())
  await flush()
  h.updater.cancelUpdateDownload()
  await flush()
  assert.equal(first.settled, true)
  assert.equal(second.settled, true)
  assert.match(first.error.message, /UPDATE_CANCELLED/)
  checksum.resolve('b'.repeat(64))
  await flush()
  assert.equal(h.installs.length, 1)
})

test('an explicit installation call shares the immediate installer launch and its cancellation', async() => {
  const installed = deferred()
  const h = updateDownloadHarness()
  let reads = 0
  h.nativeApi.getInstalledAppInfo = async() => ++reads === 1 ? { version: '1.9.2', versionCode: 79003 } : installed.promise
  const download = observe(h.updater.downloadNewVersion(manifest()))
  await flush()
  h.bridge.jobs.values().next().value.resolve({ statusCode: 200, bytesWritten: 12345 })
  await flush()
  const retry = observe(h.updater.updateApp())
  await flush()
  assert.equal(reads, 2)
  h.updater.cancelUpdateDownload()
  await flush()
  assert.equal(download.settled, true)
  assert.equal(retry.settled, true)
  installed.resolve({ version: '1.9.2', versionCode: 79003 })
  await flush()
  assert.equal(h.installs.length, 0)
})

test('business cancellation does not wait for an obsolete verified file to be deleted', async() => {
  const h = updateDownloadHarness()
  const checksum = deferred()
  const removed = deferred()
  h.fileApi.hash = () => checksum.promise
  h.fileApi.unlink = () => removed.promise
  const pending = observe(h.updater.downloadNewVersion(manifest()))
  await flush()
  h.bridge.jobs.values().next().value.resolve({ statusCode: 200, bytesWritten: 12345 })
  await flush()
  h.updater.cancelUpdateDownload()
  await flush()
  assert.equal(pending.settled, true)
  assert.match(pending.error.message, /UPDATE_CANCELLED/)
  checksum.resolve('b'.repeat(64))
  removed.resolve()
  await flush()
  assert.equal(h.installs.length, 0)
})

test('a native stop error cannot retain business waiters or progress listeners', async() => {
  const h = updateDownloadHarness()
  h.fileApi.stopDownload = id => { h.bridge.rnfs.stopDownload(id); throw new Error('bridge stop failed') }
  const pending = observe(h.updater.downloadNewVersion(manifest()))
  await flush()
  assert.doesNotThrow(() => h.updater.cancelUpdateDownload())
  await flush()
  assert.equal(pending.settled, true)
  assert.equal(h.bridge.listeners.size, 0)
  h.bridge.jobs.values().next().value.reject(new Error('native stopped later'))
  await flush()
  assert.equal(h.files.size, 0)
})

test('cancelled updater promises release callback payloads and manifests while native reads remain pending', () => {
  const result = spawnSync(process.execPath, ['--expose-gc', '-e', `
    const assert = require('node:assert/strict')
    const { updateDownloadHarness } = require('./tests/helpers/update-download.cjs')
    const { manifest } = require('./tests/helpers/release.cjs')
    const { flush } = require('./tests/helpers/load.cjs')
    const h = updateDownloadHarness(), references = [], results = []
    const start = () => {
      const payload = { rows: new Array(10000).fill('retained') }
      const candidate = manifest()
      references.push(new WeakRef(payload), new WeakRef(candidate))
      results.push(h.updater.downloadNewVersion(candidate, () => payload.rows.length).catch(error => error.message))
    }
    ;(async() => {
      for (let attempt = 0; attempt < 3; attempt++) {
        start()
        await flush()
        h.updater.cancelUpdateDownload()
      }
      await flush()
      global.gc()
      assert.equal(h.bridge.jobs.size, 3)
      assert.equal(h.bridge.listeners.size, 0)
      assert.ok(references.every(reference => reference.deref() === undefined), 'cancelled updater still retains a callback or manifest')
      assert.deepEqual(await Promise.all(results), new Array(3).fill('UPDATE_CANCELLED'))
      assert.equal(h.files.size, 3, 'pending writers remain protected')
      for (const job of h.bridge.jobs.values()) job.reject(new Error('late native cancellation'))
      await flush()
      assert.equal(h.files.size, 0)
    })().catch(error => { console.error(error); process.exitCode = 1 })
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 15000 })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
