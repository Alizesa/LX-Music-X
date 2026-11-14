const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { test } = require('node:test')
const { rnfsHarness } = require('./helpers/rnfs.cjs')
const { load, flush } = require('./helpers/load.cjs')
const { manifest, packageName } = require('./helpers/release.cjs')
const shared = require('../shared/release')
const patches = require('../patches/react-native-fs')

const callbacks = () => ({ begin() {}, progress() {}, resumable() {} })

for (const outcome of ['success', 'failure', 'cancel']) {
  test(`RNFS ${outcome} releases its own listeners and preserves concurrent downloads`, async() => {
    const h = rnfsHarness(); const events = []
    const first = h.start(callbacks())
    const other = h.start({ ...callbacks(), progress: data => events.push(data.bytesWritten) })
    assert.equal(h.listeners.size, 6)
    const result = first.promise.catch(error => error)
    if (outcome === 'cancel') {
      h.rnfs.stopDownload(first.jobId)
      h.rnfs.stopDownload(first.jobId)
      assert.equal(h.listeners.size, 3, 'cancel must release callbacks before native I/O settles')
    }
    const expected = outcome === 'success' ? { statusCode: 200, bytesWritten: 100 } : new Error(outcome)
    h.jobs.get(first.jobId)[outcome === 'success' ? 'resolve' : 'reject'](expected)
    assert.equal(await result, expected)
    assert.equal(h.listeners.size, 3)
    h.emit('DownloadProgress', { jobId: other.jobId, bytesWritten: 123 })
    assert.deepEqual(events, [123])
    h.jobs.get(other.jobId).resolve({ statusCode: 200, bytesWritten: 123 })
    await other.promise
    assert.equal(h.listeners.size, 0)
  })
}

test('RNFS clears listeners when the native call throws before returning a Promise', () => {
  const h = rnfsHarness()
  const error = new Error('native bridge unavailable')
  h.failStart(error)
  assert.throws(() => h.start(callbacks()), value => value === error)
  assert.equal(h.listeners.size, 0)
})

test('update cancellation and retry use the actual RNFS cleanup path', async() => {
  const h = rnfsHarness(); const candidate = manifest(); const installed = []
  const asset = candidate.assets.find(item => item.abi === 'arm64-v8a')
  const updater = load('src/utils/version.js', {
    '../../package.json': { name: packageName },
    '../../shared/release': shared,
    '@/utils/request': {},
    '@/config/constant': { APP_PROVIDER_NAME: 'fixture' },
    '@/utils/nativeModules/utils': {
      getInstalledAppInfo: async() => ({ version: '1.9.2', versionCode: 79 }),
      getSupportedAbis: async() => ['arm64-v8a'],
      installApk: async file => installed.push(file),
    },
    '@/utils/fs': {
      temporaryDirectoryPath: '/fixture',
      readDir: async() => [],
      unlink: async() => {},
      stat: async() => ({ size: asset.size }),
      hash: async() => asset.sha256,
      downloadFile: (url, file, options) => h.rnfs.downloadFile({ fromUrl: url, toFile: file, ...options }),
      stopDownload: id => h.rnfs.stopDownload(id),
    },
  }, { Error })
  for (let attempt = 0; attempt < 3; attempt++) {
    const pending = updater.downloadNewVersion(candidate).catch(error => error)
    await flush()
    const job = [...h.jobs.values()].at(-1)
    assert.equal(h.listeners.size, 2)
    updater.cancelUpdateDownload()
    assert.equal(h.listeners.size, 0)
    job.reject(new Error('Download has been aborted'))
    assert.match((await pending).message, /UPDATE_CANCELLED/)
  }
  const pending = updater.downloadNewVersion(candidate)
  await flush()
  const job = [...h.jobs.values()].at(-1)
  job.resolve({ statusCode: 200, bytesWritten: asset.size })
  await pending
  assert.equal(h.listeners.size, 0)
  assert.equal(installed.length, 1)
})

test('a cancelled native download Promise no longer retains its progress payload', () => {
  const result = spawnSync(process.execPath, ['--expose-gc', '-e', `
    const assert = require('node:assert/strict')
    const { rnfsHarness } = require('./tests/helpers/rnfs.cjs')
    const h = rnfsHarness(), pending = [], references = []
    for (let i = 0; i < 3; i++) {
      const payload = { songs: new Array(10000).fill('song') }
      references.push(new WeakRef(payload))
      const job = h.start({ progress: () => payload.songs.length })
      pending.push(job.promise)
      h.rnfs.stopDownload(job.jobId)
    }
    setImmediate(() => {
      global.gc()
      assert.equal(h.jobs.size, 3, 'native requests are deliberately still pending')
      assert.equal(pending.length, 3)
      assert.equal(h.listeners.size, 0)
      assert.ok(references.every(reference => reference.deref() === undefined), 'cancelled callback payload is retained')
    })
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 15000 })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})

test('RNFS postinstall replacements round-trip and remain idempotent on installed sources', () => {
  const root = path.dirname(require.resolve('react-native-fs/package.json'))
  for (const file of new Set(patches.map(([file]) => file))) {
    const installed = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n')
    const changes = patches.filter(([name]) => name === file)
    let original = installed
    for (const [, before, after] of [...changes].reverse()) {
      assert.equal(original.split(after).length, 2, `missing or duplicated installed patch in ${file}`)
      original = original.replace(after, before)
    }
    const apply = source => changes.reduce((source, [, before, after]) => {
      if (source.includes(after)) return source
      assert.equal(source.split(before).length, 2, `ambiguous upstream patch target in ${file}`)
      return source.replace(before, after)
    }, source)
    assert.equal(apply(original), installed)
    assert.equal(apply(installed), installed)
    if (file.endsWith('.java')) {
      const method = installed.slice(installed.indexOf('  public void downloadFile('), installed.indexOf('  public void stopDownload('))
      assert.equal((method.match(/new Downloader\(\)/g) ?? []).length, 1)
      assert.ok(method.indexOf('downloaders.put(jobId, downloader)') < method.indexOf('downloader.execute(params)'))
      assert.equal((method.match(/downloaders.remove\(jobId, downloader\)/g) ?? []).length, 2,
        'normal completion and executor rejection both release the exact native task')
    }
  }
})
