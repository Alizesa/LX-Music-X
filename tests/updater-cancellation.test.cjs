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

for (const phase of ['native failure', 'integrity failure', 'installation retry']) {
  for (const outcome of ['resolve', 'reject']) {
    test(`cancelling already-started ${phase} cleanup settles before deletion can ${outcome}`, async() => {
      const h = updateDownloadHarness()
      const deletion = deferred()
      let deleting = false
      const remove = h.fileApi.unlink
      h.fileApi.unlink = async file => { deleting = true; await deletion.promise; await remove(file) }
      let pending
      if (phase === 'installation retry') {
        const download = h.updater.downloadNewVersion(manifest())
        await flush()
        h.bridge.jobs.values().next().value.resolve({ statusCode: 200, bytesWritten: 12345 })
        await download
        h.fileApi.hash = async() => 'c'.repeat(64)
        pending = observe(h.updater.updateApp())
      } else {
        if (phase === 'integrity failure') h.fileApi.hash = async() => 'c'.repeat(64)
        pending = observe(h.updater.downloadNewVersion(manifest()))
        await flush()
        const job = h.bridge.jobs.values().next().value
        if (phase === 'native failure') job.reject(new Error('native failure'))
        else job.resolve({ statusCode: 200, bytesWritten: 12345 })
      }
      await flush()
      assert.equal(deleting, true)
      assert.equal(pending.settled, false)
      h.updater.cancelUpdateDownload()
      await flush()
      assert.equal(pending.settled, true)
      assert.match(pending.error.message, /UPDATE_CANCELLED/)
      deletion[outcome](outcome === 'reject' ? new Error('late unlink failure') : undefined)
      await flush()
      assert.equal(h.installs.length, phase === 'installation retry' ? 1 : 0)
    })
  }
}

for (const outcome of ['resolve', 'reject']) {
  test(`a replacement download does not repeat or await failed cleanup that will ${outcome} later`, async() => {
    const h = updateDownloadHarness()
    const deletion = deferred()
    const remove = h.fileApi.unlink
    let deletions = 0
    h.fileApi.unlink = async file => { deletions++; await deletion.promise; await remove(file) }
    const old = observe(h.updater.downloadNewVersion(manifest()))
    await flush()
    const oldJob = h.bridge.jobs.values().next().value
    oldJob.reject(new Error('native failure'))
    await flush()
    assert.equal(deletions, 1)
    h.updater.cancelUpdateDownload()
    await flush()
    const next = h.updater.downloadNewVersion(manifest('1.9.4', 100004))
    await flush()
    assert.equal(h.bridge.jobs.size, 2, 'an already deleting old path must not block or duplicate cleanup for the replacement')
    assert.equal(deletions, 1)
    const newJob = [...h.bridge.jobs.values()][1]
    newJob.resolve({ statusCode: 200, bytesWritten: 12345 })
    await next
    assert.equal(old.settled, true)
    deletion[outcome](outcome === 'reject' ? new Error('late unlink failure') : undefined)
    await flush()
    h.fileApi.unlink = remove
    await h.updater.cleanupUpdateDownloads()
    assert.equal(h.updater.hasDownloadedUpdate('v1.9.4'), true)
    assert.equal(h.files.size, 1)
    assert.equal(h.files.has(newJob.options.toFile), true)
    assert.deepEqual(h.removals, [oldJob.options.toFile])
  })
}

test('cancellation releases manifests and callbacks retained by already-started failure cleanup', () => {
  const result = spawnSync(process.execPath, ['--expose-gc', '-e', `
    const assert = require('node:assert/strict')
    const { updateDownloadHarness } = require('./tests/helpers/update-download.cjs')
    const { manifest } = require('./tests/helpers/release.cjs')
    const { deferred, flush } = require('./tests/helpers/load.cjs')
    async function check(phase) {
      const h = updateDownloadHarness(), deletion = deferred(), references = []
      let deleting = false, settled = false
      h.fileApi.unlink = () => { deleting = true; return deletion.promise }
      const start = () => {
        const candidate = manifest(), payload = { rows: new Array(10000).fill('progress') }
        references.push(new WeakRef(candidate), new WeakRef(payload))
        return h.updater.downloadNewVersion(candidate, () => payload.rows.length)
      }
      let operation
      if (phase === 'installation') {
        const initial = start()
        await flush()
        h.bridge.jobs.values().next().value.resolve({ statusCode: 200, bytesWritten: 12345 })
        await initial
        h.fileApi.hash = async() => 'c'.repeat(64)
        operation = h.updater.updateApp()
      } else {
        if (phase === 'integrity') h.fileApi.hash = async() => 'c'.repeat(64)
        operation = start()
      }
      const result = operation.catch(error => { settled = true; return error.message })
      await flush()
      if (phase !== 'installation') {
        const job = h.bridge.jobs.values().next().value
        if (phase === 'native') job.reject(new Error('native failure'))
        else job.resolve({ statusCode: 200, bytesWritten: 12345 })
        await flush()
      }
      assert.equal(deleting, true)
      h.updater.cancelUpdateDownload()
      await flush()
      global.gc()
      assert.equal(settled, true)
      assert.ok(references.every(reference => reference.deref() === undefined), phase + ' cleanup retained a manifest or callback')
      assert.equal(await result, 'UPDATE_CANCELLED')
      deletion.reject(new Error('late unlink failure'))
      await flush()
    }
    ;(async() => { for (const phase of ['native', 'integrity', 'installation']) await check(phase) })()
      .catch(error => { console.error(error); process.exitCode = 1 })
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 15000 })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})

test('cancelled native verification and installer queries retain only scalar inputs', () => {
  const result = spawnSync(process.execPath, ['--expose-gc', '-e', `
    const assert = require('node:assert/strict')
    const { updateDownloadHarness } = require('./tests/helpers/update-download.cjs')
    const { manifest } = require('./tests/helpers/release.cjs')
    const { deferred, flush } = require('./tests/helpers/load.cjs')
    async function check(stage, retry) {
      const h = updateDownloadHarness(), waiting = deferred(), references = []
      let entered = false, settled = false
      const start = () => {
        const candidate = manifest(), payload = { rows: new Array(10000).fill('progress') }
        references.push(new WeakRef(candidate), new WeakRef(payload))
        return h.updater.downloadNewVersion(candidate, () => payload.rows.length)
      }
      if (retry) {
        const download = start()
        await flush()
        h.bridge.jobs.values().next().value.resolve({ statusCode: 200, bytesWritten: 12345 })
        await download
      }
      const wait = () => { entered = true; return waiting.promise }
      let value
      if (stage === 'stat') { h.fileApi.stat = wait; value = { size: 12345 } }
      if (stage === 'hash') { h.fileApi.hash = wait; value = 'b'.repeat(64) }
      if (stage === 'installer') {
        let calls = 0
        value = { version: '1.9.2', versionCode: 79003 }
        h.nativeApi.getInstalledAppInfo = async() => !retry && ++calls === 1 ? value : wait()
      }
      const operation = (retry ? h.updater.updateApp() : start()).catch(error => { settled = true; return error.message })
      await flush()
      if (!retry) {
        h.bridge.jobs.values().next().value.resolve({ statusCode: 200, bytesWritten: 12345 })
        await flush()
      }
      assert.equal(entered, true)
      h.updater.cancelUpdateDownload()
      await flush()
      global.gc()
      assert.equal(settled, true)
      assert.ok(references.every(reference => reference.deref() === undefined), stage + ' retained a cancelled manifest or progress callback')
      assert.equal(await operation, 'UPDATE_CANCELLED')
      waiting.resolve(value)
      await flush()
      assert.equal(h.installs.length, retry ? 1 : 0)
    }
    ;(async() => { for (const stage of ['stat', 'hash', 'installer']) for (const retry of [false, true]) await check(stage, retry) })()
      .catch(error => { console.error(error); process.exitCode = 1 })
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 15000 })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
