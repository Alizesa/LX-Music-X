const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { load, deferred, flush } = require('./helpers/load.cjs')
const { manifest, packageName } = require('./helpers/release.cjs')
const shared = require('../shared/release')

const body = (source, signature) => {
  const start = source.indexOf(signature)
  assert.notEqual(start, -1)
  const open = source.indexOf('{', start)
  let depth = 1
  let end = open + 1
  for (; depth && end < source.length; end++) {
    if (source[end] === '{') depth++
    if (source[end] === '}') depth--
  }
  return source.slice(open + 1, end - 1)
}
const sourcePath = '../android/app/src/main/java/cn/toside/music/mobile/cache/ActiveCachePaths.java'
const registry = () => {
  const source = fs.readFileSync(path.join(__dirname, sourcePath), 'utf8')
  const references = new Map()
  const host = { references, separator: '/', internalRoot: { getPath: () => '/cache' }, externalRoot: { getPath: () => '/external/cache' }, canonicalPath: path.posix.normalize }
  const erase = code => code
    .replace(/new File\(path\)\.getCanonicalPath\(\)/g, 'canonicalPath(path)')
    .replace(/\b(?:String|Integer) (canonical|count)\b/g, 'const $1')
    .replace(/for \(String active : references\.keySet\(\)\)/g, 'for (const active of references.keys())')
    .replace(/references\.put\(/g, 'references.set(')
    .replace(/references\.remove\(/g, 'references.delete(')
    .replace(/canonical\.equals\(active\)/g, '(canonical === active)')
    .replace(/File\.separator/g, 'separator')
    .replace(/catch \(IOException ignored\)/g, 'catch (ignored)')
  const compile = (signature, parameters) => vm.runInThisContext('(function(' + parameters + ') { with (this) {' + erase(body(source, signature)) + '}})')
  host.isCachePath = compile('private static boolean isCachePath(', 'path')
  host.protectCachePath = compile('static synchronized boolean retain(', 'path')
  host.unprotectCachePath = compile('static synchronized boolean release(', 'path')
  host.delete = compile('static synchronized boolean delete(', 'file, cutoff')
  host.createFile = name => ({ getCanonicalPath: () => path.posix.normalize(name), lastModified: () => 1, delete: () => true })
  host.guard = load('src/utils/temporaryPaths.ts', { 'react-native': { NativeModules: { CacheModule: host } } })
  return host
}

test('native cache ownership preserves active files, ancestors and descendants while clearing unrelated files', () => {
  const h = registry()
  const one = h.guard.retainTemporaryPath('/cache/jobs/../update.apk')
  const two = h.guard.retainTemporaryPath('/cache/update.apk')
  assert.equal(h.references.get('/cache/update.apk'), 2)
  assert.equal(h.delete(h.createFile('/cache/update.apk'), 100), false)
  assert.equal(h.delete(h.createFile('/cache/unused.apk'), 100), true)
  one(); one()
  assert.equal(h.delete(h.createFile('/cache/update.apk'), 100), false)
  two()
  assert.equal(h.delete(h.createFile('/cache/update.apk'), 100), true)
  const folder = h.guard.retainTemporaryPath('/cache/work')
  assert.equal(h.delete(h.createFile('/cache/work/cover.jpg'), 100), false)
  assert.equal(h.delete(h.createFile('/cache/work'), 100), false)
  folder()
  const nested = h.guard.retainTemporaryPath('/cache/work/cover.jpg')
  assert.equal(h.delete(h.createFile('/cache/work'), 100), false)
  nested()
  assert.equal(h.references.size, 0)
  assert.equal(h.protectCachePath('/cache/../private/song.mp3'), false)
  assert.equal(h.protectCachePath('/cache'), false)
  assert.equal(h.delete(h.createFile('/private/song.mp3'), 100), false)
})

test('temporary I/O protection remains until the native promise settles and releases after failure', async() => {
  const h = registry()
  const gate = deferred()
  const pending = h.guard.withTemporaryPaths(['/cache/backup.json'], async() => gate.promise)
  const rejected = assert.rejects(pending, /native failed/)
  assert.equal(h.delete(h.createFile('/cache/backup.json'), 100), false)
  await flush()
  assert.equal(h.references.get('/cache/backup.json'), 1)
  gate.reject(new Error('native failed'))
  await rejected
  assert.equal(h.references.size, 0)
})

const metadata = ({ unlink, readPic, readMetadata = async() => null }, h = registry()) => ({
  h,
  api: load('src/utils/localMediaMetadata.ts', {
    '@/utils/fs': { temporaryDirectoryPath: '/cache', unlink, extname: () => 'mp3' },
    './temporaryPaths': h.guard,
    'react-native': { NativeModules: {} },
    'react-native-local-media-metadata': { readPic, readMetadata },
  }),
})

test('concurrent local cover reads share cold cleanup and preserve every freshly generated cover', async() => {
  const gate = deferred()
  const files = new Set()
  let unlinks = 0
  const { h, api } = metadata({
    unlink: async() => { unlinks++; await gate.promise; files.clear() },
    readPic: async id => { const result = '/cache/local-media-metadata/' + id; files.add(result); return result },
  })
  const one = api.readPic('one')
  const two = api.readPic('two')
  assert.equal(unlinks, 1)
  assert.equal(h.delete(h.createFile('/cache/local-media-metadata'), 100), false)
  gate.resolve()
  await Promise.all([one, two])
  assert.equal(files.size, 2)
  await api.readPic('three')
  assert.equal(unlinks, 1)
  assert.equal(files.size, 3)
  assert.equal(h.references.get('/cache/local-media-metadata'), 1)
  assert.equal(h.references.has('/cache/local-media-metadata-temp-file'), false)
})

test('failed local cover initialization releases its protection and can retry', async() => {
  let unlinks = 0
  const { h, api } = metadata({
    unlink: async() => { if (++unlinks === 1) throw new Error('cleanup failed') },
    readPic: async() => '/cover.jpg',
  })
  await assert.rejects(api.readPic('one'), /cleanup failed/)
  assert.equal(h.references.size, 0)
  assert.equal(await api.readPic('two'), '/cover.jpg')
  assert.equal(unlinks, 2)
  assert.equal(h.references.get('/cache/local-media-metadata'), 1)
})

test('native metadata fallback files are protected only while their operation is pending', async() => {
  const gate = deferred()
  const { h, api } = metadata({ unlink: async() => {}, readPic: async() => '', readMetadata: async() => gate.promise })
  const pending = api.readMetadata('content://one.mp3')
  assert.equal(h.delete(h.createFile('/cache/local-media-metadata-temp-file/work.mp3'), 100), false)
  gate.resolve(null)
  await pending
  assert.equal(h.references.size, 0)
})

test('backup intermediates and cache destinations remain protected through compression failure', async() => {
  const h = registry()
  const gate = deferred()
  const removed = []
  const tools = load('src/utils/tools.ts', {
    'react-native': { Platform: { OS: 'android', constants: { Release: '1' } } },
    '@react-native-clipboard/clipboard': {},
    '@/config/constant': {},
    '@/utils/fs': { temporaryDirectoryPath: '/cache', writeFile: async() => {}, gzipFile: async() => gate.promise, unlink: async path => removed.push(path) },
    './temporaryPaths': h.guard,
    '@/utils/nativeModules/utils': {},
    '@/utils/musicSdk': {},
    '@/plugins/storage': {},
    'react-native-background-timer': {},
    './pixelRatio': {},
    './index': {},
    'react-native-quick-md5': {},
    '@/utils/windowSizeTools': {},
    './scheduledTask': {},
  })
  const pending = tools.handleSaveFile('/cache/backup.lxmc', { songs: [1] })
  const rejected = assert.rejects(pending, /compression failed/)
  await flush()
  const temporary = [...h.references.keys()].find(path => path.endsWith('.json'))
  assert.ok(temporary)
  assert.equal(h.delete(h.createFile(temporary), 100), false)
  assert.equal(h.delete(h.createFile('/cache/backup.lxmc'), 100), false)
  gate.reject(new Error('compression failed'))
  await rejected
  assert.deepEqual(removed, [temporary])
  assert.equal(h.references.size, 0)
})

test('cancelling the actual updater keeps its APK protected until native completion and cleanup', async() => {
  const h = registry()
  const gate = deferred()
  const removed = []
  const updater = load('src/utils/version.js', {
    '../../package.json': { name: packageName },
    '../../shared/release': shared,
    '@/utils/request': {},
    '@/config/constant': { APP_PROVIDER_NAME: 'fixture' },
    '@/utils/nativeModules/utils': { getInstalledAppInfo: async() => ({ version: '1.9.2', versionCode: 79 }), getSupportedAbis: async() => ['arm64-v8a'], installApk: async() => assert.fail('cancelled update installed') },
    '@/utils/fs': { temporaryDirectoryPath: '/cache', readDir: async() => [], downloadFile: () => ({ jobId: 1, promise: gate.promise }), stopDownload() {}, unlink: async path => removed.push(path) },
    './temporaryPaths': h.guard,
  })
  const pending = updater.downloadNewVersion(manifest()).catch(error => error)
  await flush()
  const [apk] = h.references.keys()
  assert.ok(apk?.endsWith('.apk'))
  updater.cancelUpdateDownload()
  assert.match((await pending).message, /UPDATE_CANCELLED/)
  assert.equal(h.delete(h.createFile(apk), 100), false)
  assert.equal(removed.length, 0)
  gate.resolve({ statusCode: 200, bytesWritten: 12345 })
  await flush()
  assert.deepEqual(removed, [apk])
  assert.equal(h.references.size, 0)
})

test('native registration and deletion share one monitor and cache clearing uses the guarded delete', () => {
  const source = fs.readFileSync(path.join(__dirname, sourcePath), 'utf8')
  for (const signature of ['retain', 'release', 'delete']) assert.match(source, new RegExp('static synchronized boolean ' + signature + '\\('))
  const utils = fs.readFileSync(path.join(__dirname, '../android/app/src/main/java/cn/toside/music/mobile/cache/Utils.java'), 'utf8')
  assert.match(utils, /ActiveCachePaths\.canTraverse\(dir\)/)
  assert.match(utils, /ActiveCachePaths\.delete\(child, curTime\)/)
  assert.doesNotMatch(utils, /child\.delete\(\)/)
})
