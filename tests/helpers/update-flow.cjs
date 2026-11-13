const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { load, flush } = require('./load.cjs')
const { repository, packageName } = require('./release.cjs')
const shared = require('../../shared/release')

const createUpdateApp = ({ server, installed = { version: '1.9.2', versionCode: 79003 }, settings = { 'common.isAgreePact': true }, preferences, disk, supportedAbis = ['arm64-v8a'] } = {}) => {
  const values = disk ?? new Map()
  if (!disk) {
    if (settings !== null) values.set('setting', structuredClone(settings))
    if (preferences) values.set('updatePreferences', structuredClone(preferences))
  }
  const getData = async key => structuredClone(values.get(key) ?? null)
  const saveData = async(key, value) => { values.set(key, structuredClone(value)) }
  const defaults = load('src/config/defaultSetting.ts').default
  const settingState = { setting: { ...defaults } }
  const setting = load('src/config/setting.ts', {
    '@/config/constant': { storageDataPrefix: { setting: 'setting' }, storageDataPrefixOld: { setting: 'oldSetting' } },
    '@/config/defaultSetting': { default: defaults }, '@/plugins/storage': { getData, saveData, removeData: async key => values.delete(key) },
    './migrateSetting': { default: () => assert.fail('This fixture starts with modern settings or no saved settings') },
    '@/store/setting/state': { default: settingState }, './migrate': {}, '@/utils/tools': {},
  })
  const requests = [], downloads = [], installations = [], hashes = [], notices = [], modals = [], pacts = []
  const files = new Map()
  const native = {
    getInstalledAppInfo: async() => ({ ...installed }), getSupportedAbis: async() => supportedAbis,
    installApk: async(path, provider) => {
      assert.equal(provider, 'io.github.alizesa.lxmusicx.provider')
      assert.ok(files.has(path), 'The installer receives an existing file')
      installations.push({ path, provider, bytes: Buffer.from(files.get(path)) })
    },
  }
  const utilities = load('src/utils/version.js', {
    '../../package.json': { name: packageName }, '../../shared/release': shared,
    '@/utils/request': { httpGet: (url, options, callback) => {
      requests.push(url)
      assert.ok(url.startsWith(`https://raw.githubusercontent.com/${repository}/release-meta/channels/`))
      const channel = /\/(stable|next)\.json$/.exec(url)?.[1]
      assert.ok(channel)
      const exists = Object.hasOwn(server.state?.channels ?? {}, channel)
      callback(null, { statusCode: exists ? 200 : 404 }, exists ? server.channel(channel) : null)
      return () => {}
    } },
    '@/utils/fs': {
      temporaryDirectoryPath: '/cache', stopDownload() {}, unlink: async path => files.delete(path),
      readDir: async() => [...files].map(([path, bytes]) => ({ path, name: path.split('/').pop(), isFile: true, size: bytes.length, lastModified: Date.now() })),
      stat: async path => ({ size: files.get(path).length }),
      hash: async(path, algorithm) => { hashes.push({ path, algorithm }); return createHash(algorithm).update(files.get(path)).digest('hex') },
      downloadFile: (url, path, options) => {
        assert.ok(url.startsWith(`https://github.com/${repository}/releases/download/`))
        const parts = new URL(url).pathname.split('/')
        const bytes = server.assetBytes(decodeURIComponent(parts.at(-2)), decodeURIComponent(parts.at(-1)))
        files.set(path, bytes)
        downloads.push({ url, path })
        options.begin?.({ contentLength: bytes.length, statusCode: 200 })
        options.progress?.({ bytesWritten: bytes.length })
        return { jobId: downloads.length, promise: Promise.resolve({ statusCode: 200, bytesWritten: bytes.length }) }
      },
    },
    '@/utils/nativeModules/utils': native,
    '@/config/constant': { APP_PROVIDER_NAME: 'io.github.alizesa.lxmusicx.provider' },
  }, { Error })
  const globals = { Error, global: {
    lx: { fontSize: 1 }, i18n: { t: key => key },
    state_event: { versionInfoUpdated() {}, versionInfoIgnoreVersionUpdated() {}, versionDownloadProgressUpdated() {} },
  } }
  const versionState = load('src/store/version/state.ts', { '../../../package.json': { version: installed.version } }).default
  const actions = load('src/store/version/action.ts', { './state': { default: versionState } }, globals).default
  const core = load('src/core/version.ts', {
    '@/utils/version': utilities, '../../shared/release': shared, '@/utils/nativeModules/utils': native,
    '@/store/version/action': { default: actions }, '@/store/version/state': { default: versionState },
    '@/utils/data': {
      getUpdatePreferences: async() => getData('updatePreferences'), saveUpdatePreferences: async value => saveData('updatePreferences', value),
      getIgnoreVersionFailTipTime: async() => Date.now(), saveIgnoreVersionFailTipTime() {},
    },
    '@/navigation': { showVersionModal: () => modals.push(versionState.versionInfo.newVersion?.tag) },
    'react-native-navigation': { Navigation: { dismissOverlay: async() => {} } }, '@/utils/tools': { toast: value => notices.push(value) },
  }, globals)
  const changeSetting = patch => {
    settingState.setting = setting.updateSetting(patch).setting
    void saveData('setting', settingState.setting)
  }
  const init = load('src/core/init/index.ts', {
    '@/core/common': {
      initSetting: async() => { settingState.setting = (await setting.initSetting()).setting; return settingState.setting },
      showPactModal: () => pacts.push(true),
    },
    '@/plugins/player/service': { default() {} }, './theme': { default: async() => {} }, './i18n': { default: async() => {} },
    './userApi': { default: async() => {} }, './player': { default: async() => {} }, './dataInit': { default: async() => {} },
    './common': { default: async() => {} }, './deeplink': { initDeeplink: async() => {} }, '@/core/apiSource': { setApiSource() {} },
    '@/store/common/action': { default: { setFontSize() {} } }, '@/store/setting/state': { default: settingState }, '@/core/version': core,
    '@/utils/bootLog': { bootLog() {} }, '@/utils/tools': { cheatTip: async() => {} }, './playbackLog': { default() {} },
    '@/core/download': { initDownloads: async() => {} },
  }, globals).default
  const boot = async() => { const home = await init(); await home(); await flush(); return home }
  return { boot, core, utilities, setting, defaults, settingState, versionState, installed, disk: values, changeSetting, files, requests, downloads, installations, hashes, notices, modals, pacts }
}

module.exports = { createUpdateApp }
