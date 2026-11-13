const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load, deferred, flush } = require('./helpers/load.cjs')
const { manifest, packageName } = require('./helpers/release.cjs')
const shared = require('../shared/release')

const client = ({ installed = { version: '1.9.2', versionCode: 79003 }, saved, getVersionInfo = async() => ({ manifests: [], incomplete: false }), utilities = {}, savePreferences = async() => {} } = {}) => {
  const writes = [], writeAttempts = [], modals = [], messages = [], changes = []
  const globals = { Error, global: {
    i18n: { t: key => key },
    state_event: {
      versionInfoUpdated: info => changes.push(info),
      versionInfoIgnoreVersionUpdated() {}, versionDownloadProgressUpdated() {},
    },
  } }
  const state = load('src/store/version/state.ts', { '../../../package.json': { version: installed.version } }).default
  const actions = load('src/store/version/action.ts', { './state': { default: state } }, globals).default
  const core = load('src/core/version.ts', {
    '../../shared/release': shared,
    '@/utils/version': { getVersionInfo, cancelUpdateDownload() {}, cleanupUpdateDownloads: async() => {}, hasDownloadedUpdate: () => false, downloadNewVersion: async() => {}, updateApp: async() => {}, ...utilities },
    '@/utils/nativeModules/utils': { getInstalledAppInfo: async() => ({ ...installed }) },
    '@/store/version/action': { default: actions }, '@/store/version/state': { default: state },
    '@/utils/data': {
      getUpdatePreferences: async() => saved,
      saveUpdatePreferences: async value => {
        writeAttempts.push(structuredClone(value))
        await savePreferences(value, writeAttempts.length)
        saved = structuredClone(value)
        writes.push(saved)
      },
      getIgnoreVersionFailTipTime: async() => Date.now(), saveIgnoreVersionFailTipTime() {},
    },
    '@/navigation': { showVersionModal: () => modals.push(state.versionInfo.newVersion?.tag) },
    'react-native-navigation': { Navigation: { dismissOverlay: async() => {} } },
    '@/utils/tools': { toast: message => messages.push(message) },
  }, globals)
  return { core, state, writes, writeAttempts, installed, modals, messages, changes, saved: () => saved }
}

test('a preview first persists next subscription and a later stable APK preserves it', async() => {
  const preview = client({ installed: { version: '1.9.3-next.2', versionCode: 100002 } })
  await Promise.all([preview.core.initializeVersion(), preview.core.initializeVersion()])
  assert.equal(preview.writes.length, 1)
  assert.equal(preview.state.versionInfo.channel, 'next')
  assert.equal(preview.state.versionInfo.versionCode, 100002)
  const stable = client({ installed: { version: '1.9.3', versionCode: 100003 }, saved: preview.saved() })
  await stable.core.initializeVersion()
  assert.equal(stable.state.versionInfo.channel, 'next')
  const firstStable = client()
  await firstStable.core.initializeVersion()
  assert.equal(firstStable.state.versionInfo.channel, 'stable')
})

test('simultaneous checks share one request and recompute eligibility against the installed APK at completion', async() => {
  const gate = deferred()
  let requests = 0
  const app = client({ getVersionInfo: () => { requests++; return gate.promise } })
  await app.core.initializeVersion()
  app.state.versionInfo.isLatest = true
  const checks = [app.core.checkUpdate(true, false), app.core.checkUpdate(true, false)]
  await flush()
  assert.equal(requests, 1)
  assert.equal(app.state.versionInfo.isLatest, false)
  app.installed.version = '1.9.3'
  app.installed.versionCode = 100003
  gate.resolve({ manifests: [manifest()], incomplete: false })
  await Promise.all(checks)
  assert.equal(app.state.versionInfo.isLatest, true)
  assert.equal(app.state.versionInfo.newVersion, null)
  assert.equal(app.state.versionInfo.versionCode, 100003)
})

test('switching channel invalidates an earlier request and keeps the new preview result', async() => {
  const old = deferred()
  const preview = manifest('1.9.4-next.4', 100004)
  const app = client({ getVersionInfo: channel => channel === 'stable' ? old.promise : Promise.resolve({ manifests: [preview], incomplete: false }) })
  await app.core.initializeVersion()
  const first = app.core.checkUpdate(true, false)
  await flush()
  await app.core.setUpdateChannel('next')
  assert.equal(app.state.versionInfo.newVersion.tag, preview.tag)
  old.resolve({ manifests: [manifest()], incomplete: false })
  await first
  assert.equal(app.state.versionInfo.channel, 'next')
  assert.equal(app.state.versionInfo.newVersion.tag, preview.tag)
  assert.equal(app.saved().channel, 'next')
})

test('ignoring a tag under next does not suppress the same stable release under stable', async() => {
  const candidate = manifest()
  const app = client({ saved: { channel: 'next', ignored: {} }, getVersionInfo: async() => ({ manifests: [candidate], incomplete: false }) })
  await app.core.checkUpdate(true, false)
  await app.core.setIgnoreVersion(candidate.tag)
  await app.core.checkUpdate(true, true)
  assert.equal(app.modals.length, 0)
  await app.core.setUpdateChannel('stable')
  assert.equal(app.state.ignoreVersion, null)
  await app.core.checkUpdate(true, true)
  assert.equal(app.modals.length, 1)
  assert.equal(app.saved().ignored.next, candidate.tag)
  assert.equal(app.saved().ignored.stable, undefined)
})

test('partial channel failure is an error without an eligible candidate, but can still offer a verified update', async() => {
  let candidates = []
  const app = client({ getVersionInfo: async() => ({ manifests: candidates, incomplete: true }) })
  await app.core.checkUpdate(true, false)
  assert.equal(app.state.versionInfo.isLatest, false)
  assert.equal(app.state.versionInfo.isUnknown, true)
  candidates = [manifest()]
  await app.core.checkUpdate(true, false)
  assert.equal(app.state.versionInfo.status, 'idle')
  assert.equal(app.state.versionInfo.isUnknown, false)
  assert.equal(app.state.versionInfo.newVersion.tag, 'v1.9.3')
})

const updater = ({ size = 12345, checksum = 'b'.repeat(64), statusCode = 200, supportedAbis = ['arm64-v8a'], downloadGate, request, fileSystem = {}, install = async() => {}, installed = { version: '1.9.2', versionCode: 79003 } } = {}) => {
  const downloads = [], removals = [], installs = [], stops = [], reads = [], requests = []
  let currentChecksum = checksum
  const utilities = load('src/utils/version.js', {
    '../../package.json': { name: packageName }, '../../shared/release': shared,
    '@/utils/request': { httpGet: (url, options, callback) => {
      requests.push({ url, options })
      if (request) request(url, options, callback)
      else callback(null, { statusCode: 200 }, manifest())
    } },
    '@/utils/fs': {
      temporaryDirectoryPath: '/cache', stopDownload: id => stops.push(id), unlink: async path => removals.push(path),
      readDir: async() => [],
      stat: async path => { reads.push(['stat', path]); return { size } },
      hash: async(path, algorithm) => { reads.push([algorithm, path]); return currentChecksum },
      downloadFile: (url, path, options) => {
        downloads.push({ url, path, options })
        return { jobId: downloads.length, promise: downloadGate?.promise ?? Promise.resolve({ statusCode, bytesWritten: size }) }
      },
      ...fileSystem,
    },
    '@/utils/nativeModules/utils': {
      getInstalledAppInfo: async() => ({ ...installed }), getSupportedAbis: async() => supportedAbis,
      installApk: async(path, provider) => { installs.push({ path, provider }); await install(path, provider) },
    },
    '@/config/constant': { APP_PROVIDER_NAME: 'io.github.alizesa.lxmusicx.provider' },
  }, { Error })
  return { utilities, installed, downloads, removals, installs, stops, reads, requests, checksum: value => { currentChecksum = value } }
}

test('only the compatible manifest asset is downloaded and a verified file opens the installer', async() => {
  const app = updater({ supportedAbis: ['x86_64', 'x86'] })
  const candidate = manifest()
  await app.utilities.downloadNewVersion(candidate)
  assert.equal(app.downloads[0].url, candidate.assets.find(asset => asset.abi === 'x86_64').url)
  assert.equal(app.installs.length, 1)
  assert.ok(app.reads.some(([algorithm]) => algorithm === 'sha256'))
  app.checksum('c'.repeat(64))
  await assert.rejects(app.utilities.updateApp(), /UPDATE_INTEGRITY_FAILED/)
  assert.equal(app.installs.length, 1)
})

test('wrong HTTP status, incomplete data and checksum mismatch never reach the installer', async() => {
  for (const options of [{ statusCode: 500 }, { size: 12344 }, { checksum: 'c'.repeat(64) }]) {
    const app = updater(options)
    await assert.rejects(app.utilities.downloadNewVersion(manifest()), /UPDATE_INTEGRITY_FAILED/)
    assert.equal(app.installs.length, 0)
    assert.equal(app.removals.length, 1)
  }
})

test('cancelling an in-flight download discards its eventual completion without installing', async() => {
  const gate = deferred()
  const app = updater({ downloadGate: gate })
  const pending = app.utilities.downloadNewVersion(manifest())
  await flush()
  app.utilities.cancelUpdateDownload()
  gate.resolve({ statusCode: 200, bytesWritten: 12345 })
  await assert.rejects(pending, /UPDATE_CANCELLED/)
  assert.equal(app.stops.length, 1)
  assert.equal(app.installs.length, 0)
  assert.equal(app.removals.length, 1)
})

test('checks cache by channel and tag, and a forced check refreshes only this repository', async() => {
  const app = updater()
  await app.utilities.getVersionInfo('stable')
  await app.utilities.getVersionInfo('stable')
  assert.equal(app.requests.length, 1)
  await app.utilities.getVersionInfo('stable', true)
  assert.equal(app.requests.length, 2)
  assert.ok(app.requests.every(({ url }) => url.includes('Alizesa/LX-Music-X/release-meta/channels/stable.json')))
})

for (const failure of ['network', 'HTTP 503', 'invalid manifest']) {
  test(`a mirror 404 cannot conceal a canonical ${failure} or report the installed APK as latest`, async() => {
    const transport = updater({ request: (url, options, callback) => {
      if (url.startsWith('https://cdn.jsdelivr.net/')) callback(null, { statusCode: 404 })
      else if (failure === 'network') callback(new Error('Canonical request failed'))
      else if (failure === 'HTTP 503') callback(null, { statusCode: 503 })
      else callback(null, { statusCode: 200 }, { schemaVersion: 99 })
    } })
    const result = await transport.utilities.getVersionInfo('stable', true)
    assert.equal(result.manifests.length, 0)
    assert.equal(result.incomplete, true)
    assert.equal(transport.requests.length, 2)
    const app = client({ utilities: transport.utilities })
    await app.core.checkUpdate(true, false)
    assert.equal(app.state.versionInfo.status, 'error')
    assert.equal(app.state.versionInfo.isUnknown, true)
    assert.equal(app.state.versionInfo.isLatest, false)
    assert.equal(app.state.versionInfo.newVersion, null)
  })
}

test('a canonical 404 confirms a channel has no publication without consulting its mirror', async() => {
  const transport = updater({ request: (url, options, callback) => callback(null, { statusCode: 404 }) })
  const result = await transport.utilities.getVersionInfo('stable', true)
  assert.equal(result.manifests.length, 0)
  assert.equal(result.incomplete, false)
  assert.equal(transport.requests.length, 1)
  assert.ok(transport.requests[0].url.startsWith('https://raw.githubusercontent.com/'))
  const app = client({ utilities: transport.utilities })
  await app.core.checkUpdate(true, false)
  assert.equal(app.state.versionInfo.status, 'idle')
  assert.equal(app.state.versionInfo.isLatest, true)
  assert.equal(app.state.versionInfo.isUnknown, false)
})

test('a validated mirror manifest still recovers a canonical failure', async() => {
  const candidate = manifest()
  const transport = updater({ request: (url, options, callback) => {
    if (url.startsWith('https://raw.githubusercontent.com/')) callback(null, { statusCode: 503 })
    else callback(null, { statusCode: 200 }, candidate)
  } })
  const result = await transport.utilities.getVersionInfo('stable', true)
  assert.equal(result.manifests[0].tag, candidate.tag)
  assert.equal(result.incomplete, false)
  assert.equal(transport.requests.length, 2)
})

for (const order of ['check first', 'download first']) {
  test(`simultaneous check and download (${order}) retain the version of the verified APK`, async() => {
    const gate = deferred()
    const original = manifest('1.9.3', 100003)
    let response = original
    const transport = updater({ downloadGate: gate, request: (url, options, callback) => callback(null, { statusCode: 200 }, response) })
    const app = client({ utilities: transport.utilities })
    await app.core.checkUpdate(true, false)
    assert.equal(app.state.versionInfo.newVersion.tag, original.tag)
    response = manifest('1.9.4', 100004)
    const operations = order === 'check first'
      ? [app.core.checkUpdate(true, false), app.core.downloadUpdate()]
      : [app.core.downloadUpdate(), app.core.checkUpdate(true, false)]
    await flush()
    assert.equal(app.state.versionInfo.status, 'downloading')
    assert.equal(app.state.versionInfo.newVersion.tag, original.tag)
    assert.equal(transport.requests.length, 1)
    assert.equal(transport.downloads.length, 1)
    gate.resolve({ statusCode: 200, bytesWritten: 12345 })
    await Promise.all(operations)
    assert.equal(app.state.versionInfo.status, 'downloaded')
    assert.equal(app.state.versionInfo.newVersion.tag, original.tag)
    assert.equal(transport.installs.length, 1)
    assert.ok(transport.installs[0].path.includes(original.tag))
    assert.ok(transport.downloads[0].url.includes(original.tag))
    await app.core.checkUpdate(true, false)
    assert.equal(transport.requests.length, 1)
    assert.equal(app.state.versionInfo.newVersion.tag, original.tag)
  })
}

test('an installer failure retains the verified APK and retries installation without another download', async() => {
  let blocked = true
  const transport = updater({ install: async() => { if (blocked) throw new Error('E_APK_INSTALL') } })
  const app = client({ utilities: transport.utilities })
  await app.core.checkUpdate(true, false)
  await app.core.downloadUpdate()
  assert.equal(app.state.versionInfo.status, 'downloaded')
  assert.equal(app.state.versionInfo.installError, true)
  assert.equal(transport.utilities.hasDownloadedUpdate('v1.9.3'), true)
  assert.equal(transport.downloads.length, 1)
  assert.equal(transport.removals.length, 0)
  assert.equal(transport.reads.filter(([operation]) => operation === 'sha256').length, 1)
  blocked = false
  await app.core.installDownloadedUpdate()
  assert.equal(app.state.versionInfo.installError, false)
  assert.equal(transport.installs.length, 2)
  assert.equal(transport.downloads.length, 1)
  assert.equal(transport.reads.filter(([operation]) => operation === 'sha256').length, 2)
})

test('a retained APK corrupted before an installation retry is discarded and can be downloaded again', async() => {
  const transport = updater({ install: async() => { throw new Error('E_APK_INSTALL') } })
  const app = client({ utilities: transport.utilities })
  await app.core.checkUpdate(true, false)
  await app.core.downloadUpdate()
  transport.checksum('c'.repeat(64))
  await app.core.installDownloadedUpdate()
  assert.equal(app.state.versionInfo.status, 'error')
  assert.equal(app.state.versionInfo.integrityError, true)
  assert.equal(app.state.versionInfo.installError, false)
  assert.equal(transport.utilities.hasDownloadedUpdate('v1.9.3'), false)
  assert.equal(transport.installs.length, 1)
  transport.checksum('b'.repeat(64))
  await app.core.downloadUpdate()
  assert.equal(transport.downloads.length, 2)
})

test('concurrent installation retries share verification and one installer launch', async() => {
  const gate = deferred()
  let retry = false
  const transport = updater({ install: async() => { if (retry) await gate.promise } })
  await transport.utilities.downloadNewVersion(manifest())
  retry = true
  const operations = [transport.utilities.updateApp(), transport.utilities.updateApp()]
  await flush()
  assert.equal(transport.installs.length, 2)
  assert.equal(transport.reads.filter(([operation]) => operation === 'sha256').length, 2)
  gate.resolve()
  await Promise.all(operations)
})

const cacheEntry = (version, generation = 1, extra = {}) => ({
  name: `${packageName}-v${version}-arm64-v8a.apk.${generation}.apk`, isFile: true, lastModified: Date.now(), ...extra,
})

test('startup removes installed and abandoned update APKs without touching future installers or other cache files', async() => {
  const entries = [cacheEntry('1.9.3'), cacheEntry('1.9.4'), cacheEntry('1.9.5'),
    cacheEntry('2.0.0', 3, { lastModified: Date.now() - 2 * 86400000 }),
    { name: `${packageName}.apk`, isFile: true }, { name: 'manually-imported.apk', isFile: true },
    { name: 'cover.jpg', isFile: true }, cacheEntry('1.9.3', 4, { isFile: false }),
    cacheEntry('1.9.3/../outside', 5)]
  const app = updater({ fileSystem: { readDir: async() => entries } })
  await app.utilities.cleanupUpdateDownloads('1.9.4')
  assert.deepEqual(app.removals, [entries[0], entries[1], entries[3], entries[4]].map(entry => '/cache/' + entry.name))
})

test('old successful APKs are cleaned after process replacement on consecutive upgrades', async() => {
  const entries = new Map()
  const fileSystem = { readDir: async() => [...entries.values()], unlink: async path => entries.delete(path) }
  const installed = { version: '1.9.2', versionCode: 79003 }
  for (const [version, code] of [['1.9.3', 100003], ['1.9.4', 100004]]) {
    const app = updater({ fileSystem, installed })
    await app.utilities.downloadNewVersion(manifest(version, code))
    entries.set(app.downloads[0].path, cacheEntry(version))
    Object.assign(installed, { version, versionCode: code })
    const restarted = updater({ fileSystem, installed })
    await restarted.utilities.cleanupUpdateDownloads(installed.version)
    assert.equal(entries.size, 0)
  }
})

test('cleanup protects the in-flight download and verified APK until cancellation', async() => {
  const gate = deferred()
  const entry = cacheEntry('1.9.3')
  const app = updater({ downloadGate: gate, fileSystem: { readDir: async() => [entry] } })
  const operation = app.utilities.downloadNewVersion(manifest())
  await flush()
  app.removals.length = 0 // The pre-download cleanup legitimately removes an old process's file.
  await app.utilities.cleanupUpdateDownloads()
  assert.equal(app.removals.length, 0)
  gate.resolve({ statusCode: 200, bytesWritten: 12345 })
  await operation
  await app.utilities.cleanupUpdateDownloads()
  assert.equal(app.removals.length, 0)
  app.utilities.cancelUpdateDownload()
  await flush()
  assert.deepEqual(app.removals, ['/cache/' + entry.name])
})

test('a failed channel write rolls back the selection and permits retrying the same requested channel', async() => {
  const app = client({ savePreferences: async(value, attempt) => { if (attempt === 2) throw new Error('storage busy') } })
  await app.core.initializeVersion()
  await app.core.setUpdateChannel('next')
  assert.equal(app.state.versionInfo.channel, 'stable')
  assert.equal(app.saved().channel, 'stable')
  await app.core.setUpdateChannel('next')
  assert.equal(app.state.versionInfo.channel, 'next')
  assert.equal(app.saved().channel, 'next')
  assert.equal(app.writeAttempts.length, 3)
})

test('the last failed selection rolls back to the last successful queued write', async() => {
  const nextWrite = deferred()
  const app = client({ savePreferences: async(value, attempt) => {
    if (attempt === 2) await nextWrite.promise
    if (attempt === 3) throw new Error('latest write failed')
  } })
  await app.core.initializeVersion()
  const next = app.core.setUpdateChannel('next')
  await flush()
  const stable = app.core.setUpdateChannel('stable')
  await flush()
  nextWrite.resolve()
  await Promise.all([next, stable])
  assert.equal(app.state.versionInfo.channel, 'next')
  assert.equal(app.saved().channel, 'next')
  assert.equal(app.messages.length, 1)
})

test('a newer preference write can recover an earlier channel write without rolling the UI back', async() => {
  const failedWrite = deferred()
  const app = client({ getVersionInfo: async() => ({ manifests: [manifest()], incomplete: false }), savePreferences: async(value, attempt) => {
    if (attempt === 2) await failedWrite.promise
  } })
  await app.core.initializeVersion()
  const selection = app.core.setUpdateChannel('next')
  await flush()
  await app.core.checkUpdate(true, false)
  const ignored = app.core.setIgnoreVersion('v1.9.3')
  await flush()
  failedWrite.reject(new Error('older write failed'))
  await Promise.all([selection, ignored])
  assert.equal(app.saved().channel, 'next')
  assert.equal(app.state.versionInfo.channel, 'next')
  assert.equal(app.saved().ignored.next, 'v1.9.3')
  assert.equal(app.messages.length, 0)
})

test('rollback invalidates a download started while the selected channel was still being saved', async() => {
  const saveGate = deferred()
  const downloadGate = deferred()
  const transport = updater({ downloadGate })
  const app = client({ utilities: transport.utilities, savePreferences: async(value, attempt) => { if (attempt === 2) await saveGate.promise } })
  await app.core.initializeVersion()
  const selection = app.core.setUpdateChannel('next')
  await flush()
  await app.core.checkUpdate(true, false)
  const downloading = app.core.downloadUpdate()
  await flush()
  saveGate.reject(new Error('preference write failed'))
  await selection
  downloadGate.resolve({ statusCode: 200, bytesWritten: 12345 })
  await downloading
  assert.equal(app.state.versionInfo.channel, 'stable')
  assert.equal(app.state.versionInfo.newVersion, null)
  assert.equal(transport.installs.length, 0)
  assert.equal(transport.stops.length, 1)
})
