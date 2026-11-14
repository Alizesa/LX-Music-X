const { createHash } = require('node:crypto')
const { EventEmitter } = require('node:events')
const { load, deferred, flush } = require('./load.cjs')

const constants = load('src/config/constant.ts')
const song = id => ({ id, source: 'tx', name: id, singer: 'Artist', interval: '03:00', meta: { albumName: 'Album', _qualitys: {} } })
const task = id => ({
  id,
  musicInfo: song(id),
  quality: '128k',
  status: 'waiting',
  directoryUri: 'content://fixture/dir',
  fileName: `${id}.mp3`,
  createdAt: 1,
  progress: { downloaded: 0, total: 0, progress: 0, speed: '' },
})
const copy = value => JSON.parse(JSON.stringify(value))

const harness = ({ active = [], history = [], unlink = async() => {}, url = async() => 'https://fixture.test/audio', enqueue, remove = async() => {}, save, data: extraData = {} } = {}) => {
  const clock = new Map()
  let timerId = 0
  const timers = {
    setTimeout(fn, delay) { const id = ++timerId; clock.set(id, { fn, delay }); return id },
    clearTimeout(id) { clock.delete(id) },
  }
  const app = Object.assign(new EventEmitter(), {
    downloadCountUpdate(value) { this.emit('downloadCountUpdate', value) },
    downloadListUpdate() { this.emit('downloadListUpdate') },
    downloadTaskUpdate(value) { this.emit('downloadTaskUpdate', value) },
  })
  const writes = []; const enqueued = []; const removed = []
  let saved = copy(active)
  const entries = new Map(history.map(item => [item.id, item]))
  const data = {
    getDownloadTasksMigrated: async() => true,
    removeDownloadTasks: async() => {},
    getDownloadActiveTasks: async() => copy(saved),
    getDownloadPath: async() => ({ uri: 'content://fixture/dir' }),
    saveDownloadActiveTasks: async value => {
      await save?.(value)
      saved = copy(value)
      writes.push(saved)
    },
    ...extraData,
  }
  const api = load('src/core/download.ts', {
    '@/core/list': { removeListMusics: async() => {} },
    '@/core/music': { getMusicUrl: url },
    '@/config/constant': constants,
    '@/store/setting/state': { default: { setting: { 'download.fileName': '歌名 - 歌手', 'download.quality': '128k' } } },
    '@/utils': { filterFileName: name => name },
    '@/utils/lrcTools': {},
    '@/utils/data': data,
    './downloadHistory': {
      initDownloadHistory: async() => {},
      getDownloadHistoryCount: () => entries.size,
      getDownloadHistoryIds: () => entries.keys(),
      getDownloadHistoryEntries: () => [...entries.values()],
      getDownloadHistoryByIds: async ids => ids.map(id => entries.get(id)).filter(Boolean),
      hasDownloadHistory: id => entries.has(id),
      releaseDownloadHistoryCache() {},
      removeDownloadHistory: async ids => {
        const selected = [...entries.values()].filter(item => ids.has(item.id))
        selected.forEach(item => entries.delete(item.id))
        return selected
      },
    },
    '@/utils/fs': { privateStorageDirectoryPath: '/private', temporaryDirectoryPath: '/temp', unlink },
    '@/utils/localMediaMetadata': {},
    '@/utils/nativeModules/download': {
      onDownloadUpdate() {},
      getDownloadState: async() => null,
      enqueueDownload: async args => { enqueued.push(args); return enqueue ? enqueue(args) : `work-${args.taskId}` },
      removeDownload: async(...args) => { removed.push(args); await remove(...args) },
      pauseDownload: async() => {},
    },
    '@/utils/tools': { toMD5: text => createHash('md5').update(text).digest('hex') },
    '@/utils/common': {},
  }, { ...timers, global: { app_event: app, i18n: { t: key => key }, lx: {} } })
  return { api, app, data, writes, enqueued, removed, saved: () => saved, clock }
}

module.exports = { harness, task, song, copy, load, deferred, flush, constants }
