const { load, flush, deferred } = require('./load.cjs')
const { harness: storageHarness } = require('./download-storage.cjs')
const { task, song } = require('./download-runtime.cjs')

const createHarness = async({ active = [], history = [], receipts = new Map(), cover } = {}) => {
  const disk = storageHarness()
  const files = new Set(history.map(item => item.filePath).filter(Boolean))
  const local = new Set(files)
  const removed = []; const enqueued = []; const acknowledged = []
  const protectedPaths = new Set()
  const stoppedCovers = []
  const settings = { failLocal: false, failUnlink: null, failAck: false, failTags: false }
  await disk.data.saveDownloadActiveTasks(active)
  await disk.data.saveDownloadTasksMigrated()
  await disk.data.saveDownloadHistoryMigrated()
  await disk.data.saveDownloadPath({ uri: 'content://fixture/dir' })
  const constants = load('src/config/constant.ts')
  const historyKey = item => `${constants.storageDataPrefix.downloadHistoryItem}${item.createdAt}__${encodeURIComponent(item.id)}`
  await disk.data.saveDownloadHistoryItems(history.map(item => [historyKey(item), item]))
  let urlCalls = 0
  const start = () => {
    const data = disk.createData()
    const historyApi = load('src/core/downloadHistory.ts', { '@/config/constant': constants, '@/utils/data': data })
    const clock = new Map(); let nextTimer = 0; let listener
    const api = load('src/core/download.ts', {
      '@/core/list': {
        addListMusics: async(_id, items) => { items.forEach(item => local.add(item.id)) },
        removeListMusics: async(_id, paths) => {
          if (settings.failLocal) throw new Error('LOCAL write failed')
          paths.forEach(path => local.delete(path))
        },
      },
      '@/core/music': { getMusicUrl: async() => { urlCalls++; return 'https://fixture/audio' }, getPicPath: async() => cover ? 'https://fixture/cover.jpg' : '', getLyricInfo: async() => ({ lyric: '' }) },
      '@/config/constant': constants,
      '@/store/setting/state': { default: { setting: { 'download.fileName': '歌名', 'download.quality': '128k' } } },
      '@/utils': { filterFileName: value => value },
      '@/utils/lrcTools': { buildLyrics: () => '' },
      '@/utils/data': data,
      '@/utils/temporaryPaths': load('src/utils/temporaryPaths.ts', {
        'react-native': {
          NativeModules: {
            CacheModule: {
              protectCachePath: path => { protectedPaths.add(path); return true },
              unprotectCachePath: path => { protectedPaths.delete(path); return true },
            },
          },
        },
      }),
      './downloadHistory': historyApi,
      '@/utils/fs': {
        privateStorageDirectoryPath: '/private',
        temporaryDirectoryPath: '/temp',
        extname: value => value.split('.').at(-1),
        downloadFile: (_url, path) => { files.add(path); return { jobId: 1, promise: cover.download() } },
        stopDownload: id => { stoppedCovers.push(id) },
        existsFile: async path => files.has(path),
        unlink: async path => {
          if (path.startsWith('/temp/') && cover.unlink) await cover.unlink(path)
          if (settings.failUnlink === path) throw new Error('unlink failed')
          if (!files.delete(path)) throw new Error('file missing')
          removed.push(path)
        },
      },
      '@/utils/localMediaMetadata': { writeDownloadMetadata: async() => { if (cover?.metadata) await cover.metadata(); if (settings.failTags) throw new Error('tags failed') } },
      '@/utils/nativeModules/download': {
        onDownloadUpdate: callback => { listener = callback },
        getDownloadState: async id => receipts.get(id) ?? null,
        getDownloadCompletionIds: async() => [...receipts].map(([nativeId, state]) => ({ nativeId, taskId: state.taskId })),
        acknowledgeDownloadCompletion: async id => {
          if (settings.failAck) throw new Error('ack failed')
          acknowledged.push(id); receipts.delete(id)
        },
        enqueueDownload: async options => { enqueued.push(options); return `work-${enqueued.length}` },
        removeDownload: async() => {},
        pauseDownload: async() => {},
      },
      '@/utils/tools': { toMD5: value => value },
      '@/utils/common': { sizeFormate: String },
    }, {
      setTimeout: (fn, delay) => { const id = ++nextTimer; clock.set(id, { fn, delay }); return id },
      clearTimeout: id => clock.delete(id),
      global: { app_event: { downloadCountUpdate() {}, downloadListUpdate() {}, downloadTaskUpdate() {} }, i18n: { t: key => key } },
    })
    return {
      api,
      data,
      historyApi,
      clock,
      emit: event => listener(event),
      run: async delay => {
        for (const [id, timer] of [...clock]) if (timer.delay === delay) { clock.delete(id); timer.fn() }
        await flush()
      },
    }
  }
  return { ...start(), restart: start, disk, files, local, removed, enqueued, receipts, acknowledged, settings, protectedPaths, stoppedCovers, historyKey, urlCalls: () => urlCalls, journalKeys: () => [...disk.values.keys()].filter(key => key.startsWith('@download_cleanup__')) }
}

const item = id => ({ id: String(id), name: String(id), singer: 'Singer', quality: '128k', filePath: `content://fixture/${id}`, createdAt: Number(id) + 1 })
const completed = (id, nativeId, path, downloaded = 1024) => ({ taskId: id, nativeId, status: 'completed', filePath: path, fileName: `${id}.mp3`, downloaded, total: downloaded })

module.exports = { createHarness, item, completed, task, song, flush, deferred }
