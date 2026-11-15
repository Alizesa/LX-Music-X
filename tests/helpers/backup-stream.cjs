const { gzipSync, gunzipSync } = require('node:zlib')
const { load } = require('./load.cjs')

const harness = ({ lists = [], rows = () => [], failure } = {}) => {
  const files = new Map(); const outputs = new Map(); const appends = []; const removed = []; const reads = []; const released = []; const errors = []; const notices = []; const references = []
  const state = { playInfo: {}, playMusicInfo: {} }
  let queueFromTemp = false
  const fs = {
    temporaryDirectoryPath: '/cache',
    writeFile: async(path, value) => { if (failure === 'create') throw new Error('create failed'); files.set(path, Buffer.from(value, 'utf8')) },
    appendFile: async(path, value) => {
      appends.push(value)
      if (failure === 'append' && appends.length > 1) throw new Error('append failed')
      files.set(path, Buffer.concat([files.get(path), Buffer.from(value, 'utf8')]))
    },
    gzipFile: async(input, output) => {
      if (failure === 'gzip') { outputs.set(output, Buffer.from('partial')); throw new Error('gzip failed') }
      outputs.set(output, gzipSync(files.get(input)))
    },
    unlink: async path => { files.delete(path); removed.push(path) },
  }
  const tools = load('src/utils/tools.ts', {
    'react-native': { Platform: { OS: 'android', constants: { Release: '1' } } },
    '@react-native-clipboard/clipboard': {},
    '@/config/constant': {},
    '@/utils/fs': fs,
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
  let peakCached = 0
  const cache = load('src/utils/listManage.ts', {
    '@/utils/data': {
      getListMusics: async id => {
        reads.push(id)
        if (failure === 'read') throw new Error('read failed')
        const result = await rows(id)
        references.push(new WeakRef(result))
        return result
      },
    },
    '@/utils/common': {},
    '@/utils/localMatchIndex': {},
    '@/config/constant': { LIST_IDS: { LOCAL: 'local', TEMP: 'temp' } },
    '@/store/player/state': { default: state },
    '@/core/player/playQueue': { isPlayQueueFromList: id => id === 'temp' && queueFromTemp },
  }, { global: { lx: {} }, setTimeout: () => 1 })
  const actions = load('src/screens/Home/Views/Setting/settings/Backup/actions.ts', {
    '@/core/list': {
      getListMusics: async id => {
        const result = await cache.getListMusics(id)
        peakCached = Math.max(peakCached, cache.allMusicList.size)
        return result
      },
    },
    '@/utils': {},
    '@/utils/log': { log: { error: value => errors.push(value) } },
    '@/utils/tools': { ...tools, toast: value => notices.push(value) },
    '@/store/list/state': { default: { userList: lists } },
    '@/utils/legacyList': { isRemovedUserList: info => info.source === 'removed' },
    '@/utils/listManage': { releaseIdleListCache: id => { released.push(id); cache.releaseIdleListCache(id) } },
  }, { global: { i18n: { t: value => value } } })
  return {
    tools,
    actions,
    fs,
    files,
    outputs,
    appends,
    removed,
    reads,
    released,
    errors,
    notices,
    cache,
    state,
    references,
    peakCached: () => peakCached,
    setQueueFromTemp: value => { queueFromTemp = value },
    output: path => gunzipSync(outputs.get(path)).toString('utf8'),
  }
}
const songs = (id, count = 251) => Array.from({ length: count }, (_, index) => ({ id: `${id}-${index}`, name: `歌曲 "${index}" 😀`, source: 'kw', meta: { albumName: 'Album' } }))
module.exports = { harness, songs }
