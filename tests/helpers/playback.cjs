const assert = require('node:assert/strict')
const { load, deferred, flush } = require('./load.cjs')

const song = id => ({ id, source: 'kw', name: id, singer: 'Singer', interval: '03:00', meta: { _qualitys: { '128k': {}, '320k': {}, flac: {} } } })
const Event = load('src/event/Event.ts', {}, { setImmediate }).default
const { createStateEventHub } = load('src/event/stateEvent.ts', { './Event': { default: Event } })
const { createAppEventHub } = load('src/event/appEvent.ts', { './Event': { default: Event } })
const constants = load('src/config/constant.ts')
const message = load('src/utils/message.ts')
const scheduled = load('src/utils/scheduledTask.ts')

const harness = async(options = {}) => {
  const state = load('src/store/player/state.ts').default
  const setting = { 'player.togglePlayMethod': 'listLoop', 'player.playQuality': '128k', 'player.playbackRate': 1, ...options.setting }
  const globals = { lx: { isPlayedStop: false, gettingUrlId: '', playerTrackId: '', playerStatus: { isInitialized: true }, apiInitPromise: [Promise.resolve(true), true, () => {}] }, state_event: createStateEventHub(), app_event: createAppEventHub(), i18n: { t: key => key } }
  const actions = load('src/store/player/action.ts', { '@/utils': { arrPush: (arr, items) => arr.push(...items), arrUnshift: (arr, items) => arr.unshift(...items), formatPlayTime2: String }, './state': { default: state } }, { global: globals }).default
  const progress = load('src/core/player/progress.ts', { '@/store/player/action': { default: actions } })
  const status = load('src/core/player/playStatus.ts', { '@/store/player/action': { default: actions }, '@/store/player/state': { default: state } })
  let now = 0; let timerId = 0
  const timers = new Map()
  const clock = { setTimeout: (fn, ms = 0) => { timers.set(++timerId, { fn, at: now + ms, ms }); return timerId }, clearTimeout: id => timers.delete(id) }
  const advance = async ms => {
    const target = now + ms
    for (let guard = 0; guard < 100; guard++) {
      const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      now = due[1].at; timers.delete(due[0]); due[1].fn(); await flush()
    }
    now = target; await flush()
  }
  const io = { savePlayQueue: async() => {} }
  const queue = load('src/core/player/playQueue.ts', { '@/utils/data': { getPlayQueue: async() => [], savePlayQueue: (...args) => io.savePlayQueue(...args) }, '@/config/constant': constants, '@/store/player/state': { default: state }, '@/store/player/action': { default: actions } }, { global: globals })
  const lists = { library: [song('A'), song('B'), song('C')] }
  const info = load('src/core/player/playInfo.ts', { '@/store/player/action': { default: actions }, '@/store/player/state': { default: state }, '@/utils/listManage': { getListMusicSync: id => lists[id] ?? [] }, '@/core/player/progress': progress, '@/config/constant': constants, './playQueue': queue }, { global: globals })
  const played = load('src/core/player/playedList.ts', { '@/store/player/action': { default: actions } })
  const playerProxy = {}
  const temp = load('src/core/player/tempPlayList.ts', { '@/store/player/action': { default: actions }, '@/store/player/state': { default: state }, './player': playerProxy })
  const filters = load('src/core/player/utils.ts', { './playedList': played, '@/config/constant': constants, '@/store/dislikeList': { state: { dislikeInfo: { names: new Set(), musicNames: new Set(), singerNames: new Set() } } } })
  const nativeCalls = []; const nativeTracks = []; const listeners = new Map()
  let current = null; let known = null; let position = 0
  const emitNative = (name, data) => { setImmediate(() => { for (const fn of listeners.get(name) ?? []) fn(data) }) }
  const eventNames = ['RemotePlay', 'RemotePause', 'RemoteNext', 'RemotePrevious', 'RemoteStop', 'RemoteJumpBackward', 'RemoteJumpForward', 'PlaybackError', 'RemoteSeek', 'PlaybackState', 'PlaybackTrackChanged']
  const states = ['None', 'Ready', 'Playing', 'Stopped', 'Paused', 'Buffering', 'Connecting']
  const native = {
    getCurrentTrack: async() => { const snapshot = current; if (options.beforeCurrent) await options.beforeCurrent(); return snapshot },
    getQueue: async() => [...nativeTracks],
    add: async tracks => { if (options.beforeAdd) await options.beforeAdd(tracks); nativeTracks.push(...tracks) },
    skip: async index => { const prev = known; current = index; known = index; position = 0; emitNative('PlaybackTrackChanged', { track: prev, nextTrack: index }) },
    skipToNext: async() => { if (current == null || current + 1 >= nativeTracks.length) throw new Error('no next track'); return native.skip(current + 1) },
    play: async() => { nativeCalls.push({ action: 'play', id: nativeTracks[current]?.musicId, selected: state.playMusicInfo.musicInfo?.id }); emitNative('PlaybackState', { state: 'Playing' }) },
    pause: async() => { nativeCalls.push({ action: 'pause' }); emitNative('PlaybackState', { state: 'Paused' }) },
    stop: async() => { known = null; position = 0; nativeCalls.push({ action: 'stop' }); emitNative('PlaybackState', { state: 'None' }) },
    seekTo: async time => { position = time; nativeCalls.push({ action: 'seek', time }) },
    getPosition: async() => options.getPosition ? options.getPosition() : position,
    getDuration: async() => 180,
    getState: async() => 'Paused',
    remove: async indices => { for (const index of [...indices].sort((a, b) => b - a)) { nativeTracks.splice(index, 1); if (current >= index) current-- } },
    addEventListener: (event, handler) => { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(handler); return { remove() {} } },
    registerPlaybackService: factory => { factory()() },
    updateNowPlayingMetadata: async() => {},
    updateOptions: async() => {},
  }
  const nativeModule = { default: native, State: Object.fromEntries(states.map(x => [x, x])), Event: Object.fromEntries(eventNames.map(x => [x, x])), Capability: {} }
  const playList = load('src/plugins/player/playList.ts', { 'react-native-track-player': nativeModule, 'react-native-background-timer': { default: clock }, '@/config': { defaultUrl: 'file:///default.mp3' }, '@/store/setting/state': { default: { setting } }, '@/store/player/state': { default: state } }, { global: globals })
  const plugin = load('src/plugins/player/utils.ts', { 'react-native-track-player': nativeModule, 'react-native-background-timer': { default: clock }, './playList': playList, '@/utils/fs': {}, '@/utils/tools': {}, '@/config/constant': constants, '@/store/setting/state': { default: { setting } }, './hook': {} }, { global: globals })
  const sourceRequests = []
  const music = {
    getMusicUrl: args => {
      const gate = deferred()
      const entry = { ...args, gate, cancelled: false }
      sourceRequests.push(entry)
      args.onCancel?.(() => { entry.cancelled = true; gate.reject(new Error(message.requestMsg.cancelRequest)) })
      return gate.promise
    },
    getPicPath: async() => '',
    getLyricInfo: async() => ({ lyric: '', rawlrcInfo: { lyric: '' } }),
  }
  const tools = { debounceBackgroundTimer: (fn, ms) => scheduled.createScheduledTask(fn, ms, true, clock), checkNotificationPermission: async() => {}, checkIgnoringBatteryOptimization: async() => {} }
  const recommendSession = { parkRecommendQueue: async() => {} }
  const player = load('src/core/player/player.ts', {
    '@/plugins/player': { ...plugin, isInitialized: () => true },
    '@/core/player/playStatus': status,
    '@/store/player/state': { default: state },
    '@/store/setting/state': { default: { setting } },
    '@/core/player/playInfo': info,
    '@/core/player/playedList': played,
    '@/core/player/tempPlayList': temp,
    '@/core/music': music,
    '@/utils/message': message,
    '@/utils/common': { getRandom: (min, max) => min },
    './utils': filters,
    'react-native-background-timer': { default: clock },
    '@/utils/tools': tools,
    '@/config/constant': constants,
    '@/core/qqMusicFavorite': {},
    '@/core/dislikeList': {},
    './playQueue': queue,
    '@/core/qqMusicRecommendSession': recommendSession,
    '@/core/localList': options.localList ?? {},
    './preload': { cancelPreload() {}, takePreloadedMusicUrl: () => null },
    '@/core/music/sourcePriority': { markMusicUrlFailed() {} },
  }, { global: globals, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout })
  Object.assign(playerProxy, player)
  await load('src/core/init/player/player.ts', {
    '@/core/player/playedList': played,
    '@/core/player/player': player,
    '@/core/player/playStatus': status,
    '@/plugins/player': plugin,
    '@/plugins/player/playList': playList,
    '@/store/player/state': { default: state },
    '@/store/setting/state': { default: { setting } },
  }, { global: globals }).default(setting)
  load('src/plugins/player/service.ts', {
    '@/store/player/state': { default: state },
    'react-native-track-player': nativeModule,
    './utils': plugin,
    '@/core/common': {},
    './playList': playList,
    '@/core/player/player': player,
    '@/core/player/playMode': {},
    '@/core/desktopLyric': {},
    '@/lang': {},
    '@/utils/tools': {},
    '@/store/setting/state': { default: { setting } },
  }, { global: globals }).default()
  await queue.replacePlayQueue('library', lists.library)
  await flush()
  return { state, setting, globals, actions, progress, status, info, io, lists, queue, player, played, recommendSession, plugin, playList, music, native, nativeCalls, nativeTracks, sourceRequests, timers, clock, advance, emitNative }
}

module.exports = { harness, song, load, deferred, flush, constants, message, assert }
