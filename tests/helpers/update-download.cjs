const path = require('node:path')
const { load } = require('./load.cjs')
const { rnfsHarness } = require('./rnfs.cjs')
const { packageName } = require('./release.cjs')
const shared = require('../../shared/release')

// Actual updater and installed RNFS JS; only native/storage boundaries are controlled.
const updateDownloadHarness = ({ fileSystem = {}, native = {} } = {}) => {
  const bridge = rnfsHarness()
  const files = new Map()
  const removals = []
  const installs = []
  const fileApi = {
    temporaryDirectoryPath: '/fixture',
    readDir: async() => [...files.values()],
    unlink: async file => { removals.push(file); files.delete(file) },
    stat: async() => ({ size: 12345 }),
    hash: async() => 'b'.repeat(64),
    downloadFile: (url, file, options) => {
      files.set(file, { name: path.posix.basename(file), isFile: true, lastModified: Date.now() })
      return bridge.rnfs.downloadFile({ fromUrl: url, toFile: file, ...options })
    },
    stopDownload: id => bridge.rnfs.stopDownload(id),
    ...fileSystem,
  }
  const nativeApi = {
    getInstalledAppInfo: async() => ({ version: '1.9.2', versionCode: 79003 }),
    getSupportedAbis: async() => ['arm64-v8a'],
    installApk: async file => { installs.push(file) },
    ...native,
  }
  const updater = load('src/utils/version.js', {
    '../../package.json': { name: packageName },
    '../../shared/release': shared,
    '@/utils/request': {},
    '@/config/constant': { APP_PROVIDER_NAME: 'fixture' },
    '@/utils/nativeModules/utils': nativeApi,
    '@/utils/fs': fileApi,
  }, { Error })
  return { updater, bridge, files, removals, installs, fileApi, nativeApi }
}

module.exports = { updateDownloadHarness }
