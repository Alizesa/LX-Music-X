const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load, deferred, flush } = require('./helpers/load.cjs')
const { manifest, packageName } = require('./helpers/release.cjs')
const shared = require('../shared/release')

test('a slower forced channel response cannot replace a newer response or regress the next cached check', async() => {
  const requests = []
  const updater = load('src/utils/version.js', {
    '../../package.json': { name: packageName },
    '../../shared/release': shared,
    '@/utils/request': { httpGet: (url, options, callback) => { requests.push({ url, callback }) } },
    '@/utils/fs': {},
    '@/utils/nativeModules/utils': {},
    '@/config/constant': {},
  })
  const oldCheck = updater.getVersionInfo('stable', true)
  const newCheck = updater.getVersionInfo('stable', true)
  assert.equal(requests.length, 2)
  assert.ok(requests.every(request => request.url.endsWith('/stable.json')))
  const newer = manifest('1.9.4', 100004)
  requests[1].callback(null, { statusCode: 200 }, newer)
  assert.equal((await newCheck).manifests[0].tag, newer.tag)
  requests[0].callback(null, { statusCode: 200 }, manifest('1.9.3', 100003))
  assert.equal((await oldCheck).manifests[0].tag, newer.tag)
  const cached = await updater.getVersionInfo('stable')
  assert.equal(cached.manifests[0].tag, newer.tag)
  assert.equal(cached.manifests[0].versionCode, 100004)
  assert.equal(cached.incomplete, false)
  assert.equal(requests.length, 2)
})

test('a failed write from an earlier channel selection cannot overwrite the latest selection or its successful check', async() => {
  const blockedWrite = deferred()
  const changes = []; const writes = []; const checkedChannels = []; const messages = []; const cancellations = []
  let saved
  const globals = {
    global: {
      i18n: { t: key => key },
      state_event: {
        versionInfoUpdated: info => changes.push(info),
        versionInfoIgnoreVersionUpdated() {},
        versionDownloadProgressUpdated() {},
      },
    },
  }
  const state = load('src/store/version/state.ts', { '../../../package.json': { version: '1.9.2' } }).default
  const actions = load('src/store/version/action.ts', { './state': { default: state } }, globals).default
  const core = load('src/core/version.ts', {
    '../../shared/release': shared,
    '@/utils/version': {
      getVersionInfo: async channel => { checkedChannels.push(channel); return { manifests: [manifest()], incomplete: false } },
      cancelUpdateDownload: () => cancellations.push(state.versionInfo.channel),
      cleanupUpdateDownloads: async() => {},
      hasDownloadedUpdate: () => false,
      downloadNewVersion: async() => {},
      updateApp: async() => {},
    },
    '@/utils/nativeModules/utils': { getInstalledAppInfo: async() => ({ version: '1.9.2', versionCode: 79003 }) },
    '@/store/version/action': { default: actions },
    '@/store/version/state': { default: state },
    '@/utils/data': {
      getUpdatePreferences: async() => saved,
      saveUpdatePreferences: async value => {
        writes.push(structuredClone(value))
        if (writes.length === 2) await blockedWrite.promise
        saved = structuredClone(value)
      },
      getIgnoreVersionFailTipTime: async() => Date.now(),
      saveIgnoreVersionFailTipTime() {},
    },
    '@/navigation': { showVersionModal() {} },
    'react-native-navigation': { Navigation: { dismissOverlay: async() => {} } },
    '@/utils/tools': { toast: message => messages.push(message) },
  }, globals)
  await core.initializeVersion()
  const firstSelection = core.setUpdateChannel('next')
  await flush()
  assert.equal(writes.length, 2)
  assert.equal(state.versionInfo.channel, 'next')
  const latestSelection = core.setUpdateChannel('stable')
  await flush()
  assert.equal(state.versionInfo.channel, 'stable')
  const latestChangeOffset = changes.length
  blockedWrite.reject(new Error('Earlier channel preference write failed'))
  await Promise.all([firstSelection, latestSelection])
  assert.equal(state.versionInfo.channel, 'stable')
  assert.equal(saved.channel, 'stable')
  assert.equal(state.versionInfo.status, 'idle')
  assert.equal(state.versionInfo.newVersion.tag, 'v1.9.3')
  assert.equal(state.versionInfo.isUnknown, false)
  assert.equal(cancellations.length, 2)
  assert.deepEqual(checkedChannels, ['stable'])
  assert.equal(messages.length, 0)
  assert.ok(changes.slice(latestChangeOffset).every(info => info.channel === 'stable' && info.status !== 'error' && !info.isUnknown))
})

const previewTransport = () => {
  const requests = []
  const updater = load('src/utils/version.js', {
    '../../package.json': { name: packageName },
    '../../shared/release': shared,
    '@/utils/request': {
      httpGet: (url, options, callback) => {
        if (url.endsWith('/stable.json')) callback(null, { statusCode: 404 })
        else requests.push(callback)
      },
    },
    '@/utils/fs': {},
    '@/utils/nativeModules/utils': {},
    '@/config/constant': {},
  })
  return { requests, updater }
}

test('withdrawing a preview clears the cache and an earlier response cannot restore it', async() => {
  const app = previewTransport()
  const initial = app.updater.getVersionInfo('next', true)
  app.requests[0](null, { statusCode: 200 }, manifest('1.9.4-next.4', 100004))
  await initial
  const oldCheck = app.updater.getVersionInfo('next', true)
  const withdrawal = app.updater.getVersionInfo('next', true)
  app.requests[2](null, { statusCode: 200 }, null)
  assert.equal((await withdrawal).manifests.length, 0)
  app.requests[1](null, { statusCode: 200 }, manifest('1.9.4-next.4', 100004))
  assert.equal((await oldCheck).manifests.length, 0)
  const subsequent = app.updater.getVersionInfo('next')
  assert.equal(app.requests.length, 4)
  app.requests[3](null, { statusCode: 200 }, null)
  assert.equal((await subsequent).manifests.length, 0)
})

test('an old empty response cannot erase a newer validated preview', async() => {
  const app = previewTransport()
  const empty = app.updater.getVersionInfo('next', true)
  const newer = app.updater.getVersionInfo('next', true)
  const candidate = manifest('1.9.4-next.4', 100004)
  app.requests[1](null, { statusCode: 200 }, candidate)
  await newer
  app.requests[0](null, { statusCode: 404 })
  assert.equal((await empty).manifests[0].tag, candidate.tag)
  assert.equal((await app.updater.getVersionInfo('next')).manifests[0].tag, candidate.tag)
  assert.equal(app.requests.length, 2)
})
