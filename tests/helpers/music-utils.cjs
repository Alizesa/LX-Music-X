const { load, deferred } = require('./load.cjs')

const harness = () => {
  const initialization = deferred()
  const requests = []
  const conversions = []
  const setting = { 'player.isS2t': false }
  const message = load('src/utils/message.ts')
  const api = load('src/core/music/utils.ts', {
    '@/utils/musicSdk': { default: {}, findMusic: async() => [] },
    '@/utils/data': { getMusicUrl: async() => null, getPlayerLyric: async() => ({ lyric: '' }) },
    '@/utils': {
      toOldMusicInfo: value => value,
      toNewMusicInfo: value => value,
      langS2T: async text => { conversions.push(text); return `converted:${text}` },
    },
    '@/store/setting/state': { default: { setting } },
    '@/utils/message': message,
    'react-native-background-timer': { default: { setTimeout, clearTimeout } },
    '@/utils/musicSdk/api-source': {
      apis: () => {
        requests.push('api')
        return {
          getMusicUrl: () => ({ promise: Promise.resolve({ url: 'https://audio.test/full' }) }),
          getLyric: () => ({ promise: Promise.resolve({ lyric: '[00:01.00]line' }) }),
          getPic: () => ({ promise: Promise.resolve('https://audio.test/cover') }),
        }
      },
    },
    '@/core/qqMusicUrl': {},
    '@/config/constant': {},
    './sourcePriority': { isMusicUrlFailed: () => false },
    '@/utils/musicUrlCache': { getMusicUrlCacheContext: () => 'context' },
  }, { global: { lx: { apiInitPromise: [initialization.promise] } } })
  return { api, initialization, requests, setting, conversions, message }
}
module.exports = { harness }
