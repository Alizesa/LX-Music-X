const { load, deferred } = require('./load.cjs')

const metadataHarness = (sdk) => {
  const pending = deferred(); const localLookup = { read: async() => null }
  const calls = []; const writes = []; const conversions = []
  const converter = { run: async text => { conversions.push(text); return text } }
  let cancelled = 0
  const setting = { 'player.isS2t': false }
  const provider = {
    getPic() { calls.push({ kind: 'pic', signal: this.requestSignal }); return pending.promise },
    getLyric() {
      calls.push({ kind: 'lyric', signal: this.requestSignal })
      return { promise: pending.promise, cancelHttp: () => { cancelled++ } }
    },
  }
  const data = {
    getPlayerLyric: async() => ({ lyric: '' }),
    saveLyric: async(...args) => { writes.push(args) },
  }
  const utils = load('src/core/music/utils.ts', {
    '@/utils/musicSdk': { default: sdk ?? { kw: provider }, findMusic: async() => [] },
    '@/utils/data': data,
    '@/utils': { toOldMusicInfo: value => value, toNewMusicInfo: value => value, langS2T: (...args) => converter.run(...args) },
    '@/store/setting/state': { default: { setting } },
    'react-native-background-timer': { default: { setTimeout, clearTimeout } },
    '@/utils/musicSdk/api-source': {},
    '@/core/qqMusicUrl': {},
    '@/config/constant': { QQ_LYRIC_CACHE_VERSION: 1 },
    './sourcePriority': {},
    '@/utils/musicUrlCache': {},
  })
  const online = load('src/core/music/online.ts', {
    '@/utils/data': data,
    '@/core/list': { updateListMusics: async(...args) => { writes.push(args) } },
    '@/store/setting/state': { default: { setting } },
    './sourcePriority': {},
    '@/core/qqMusicUrl': {},
    '@/utils/musicUrlCache': {},
    './utils': utils,
  })
  const downloaded = load('src/core/music/download.ts', { './online': online, './utils': utils })
  const api = load('src/core/music/index.ts', {
    './online': online,
    './download': downloaded,
    './local': { findLocalMusicInfo: (...args) => localLookup.read(...args) },
    '@/utils/music': {},
    '@/config/constant': { LIST_IDS: { LOCAL: 'local' } },
  })
  return { api, utils, online, data, pending, localLookup, calls, writes, conversions, converter, setting, cancelled: () => cancelled }
}

module.exports = { metadataHarness }
