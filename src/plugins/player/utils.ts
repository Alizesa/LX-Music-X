import TrackPlayer, { Capability, Event, RepeatMode, State } from 'react-native-track-player'
import BackgroundTimer from 'react-native-background-timer'
import { playMusic as handlePlayMusic } from './playList'
import { existsFile, moveFile, privateStorageDirectoryPath, temporaryDirectoryPath } from '@/utils/fs'
import { toast } from '@/utils/tools'
import { MUSIC_TOGGLE_MODE } from '@/config/constant'
import settingState from '@/store/setting/state'
// import { PlayerMusicInfo } from '@/store/modules/player/playInfo'


export { useBufferProgress } from './hook'

const emptyIdRxp = /\/\/default$/
const tempIdRxp = /\/\/default$|\/\/default\/\/restorePlay$/
export const isEmpty = (trackId = global.lx.playerTrackId) => {
  // console.log(trackId)
  return !trackId || emptyIdRxp.test(trackId)
}
export const isTempId = (trackId = global.lx.playerTrackId) => !trackId || tempIdRxp.test(trackId)

// export const replacePlayTrack = async(newTrack, oldTrack) => {
//   console.log('replaceTrack')
//   await TrackPlayer.add(newTrack)
//   await TrackPlayer.skip(newTrack.id)
//   await TrackPlayer.remove(oldTrack.id)
// }

// let timeout
// let isFirstPlay = true
// const updateInfo = async track => {
//   if (isFirstPlay) {
//     // timeout = setTimeout(() => {
//     await delayUpdateMusicInfo(track)
//     isFirstPlay = false
//     // }, 500)
//   }
// }


// 解决快速切歌导致的通知栏歌曲信息与当前播放歌曲对不上的问题
// const debouncePlayMusicTools = {
//   prevPlayMusicPromise: Promise.resolve(),
//   trackInfo: {},
//   isDelayUpdate: false,
//   isDebounced: false,
//   delay: 1000,
//   delayTimer: null,
//   debounce(fn, delay = 100) {
//     let timer = null
//     let _tracks = null
//     let _time = null
//     return (tracks, time) => {
//       if (!this.isDebounced && _tracks != null) this.isDebounced = true
//       _tracks = tracks
//       _time = time
//       if (timer) {
//         BackgroundTimer.clearTimeout(timer)
//         timer = null
//       }
//       if (this.isDelayUpdate) {
//         if (this.updateDelayTimer) {
//           BackgroundTimer.clearTimeout(this.updateDelayTimer)
//           this.updateDelayTimer = null
//         }
//         timer = BackgroundTimer.setTimeout(() => {
//           timer = null
//           let tracks = _tracks
//           let time = _time
//           _tracks = null
//           _time = null
//           this.isDelayUpdate = false
//           fn(tracks, time)
//         }, delay)
//       } else {
//         this.isDelayUpdate = true
//         fn(tracks, time)
//         this.updateDelayTimer = BackgroundTimer.setTimeout(() => {
//           this.updateDelayTimer = null
//           this.isDelayUpdate = false
//         }, this.delay)
//       }
//     }
//   },
//   delayUpdateMusicInfo() {
//     if (this.delayTimer) BackgroundTimer.clearTimeout(this.delayTimer)
//     this.delayTimer = BackgroundTimer.setTimeout(() => {
//       this.delayTimer = null
//       if (this.trackInfo.tracks && this.trackInfo.tracks.length) delayUpdateMusicInfo(this.trackInfo.tracks[0])
//     }, this.delay)
//   },
//   init() {
//     return this.debounce((tracks, time) => {
//       tracks = [...tracks]
//       this.trackInfo.tracks = tracks
//       this.trackInfo.time = time
//       return this.prevPlayMusicPromise.then(() => {
//         // console.log('run')
//         if (this.trackInfo.tracks === tracks) {
//           this.prevPlayMusicPromise = handlePlayMusic(tracks, time).then(() => {
//             if (this.isDebounced) {
//               this.delayUpdateMusicInfo()
//               this.isDebounced = false
//             }
//           })
//         }
//       })
//     }, 200)
//   },
// }

const playMusic = ((fn: (musicInfo: LX.Player.PlayMusic, url: string, time: number) => void, delay = 800) => {
  let delayTimer: number | null = null
  let isDelayRun = false
  let timer: number | null = null
  let _musicInfo: LX.Player.PlayMusic | null = null
  let _url = ''
  let _time = 0
  return (musicInfo: LX.Player.PlayMusic, url: string, time: number) => {
    _musicInfo = musicInfo
    _url = url
    _time = time
    if (timer) {
      BackgroundTimer.clearTimeout(timer)
      timer = null
    }
    if (isDelayRun) {
      if (delayTimer) {
        BackgroundTimer.clearTimeout(delayTimer)
        delayTimer = null
      }
      timer = BackgroundTimer.setTimeout(() => {
        timer = null
        let musicInfo = _musicInfo
        let url = _url
        let time = _time
        _musicInfo = null
        _url = ''
        _time = 0
        isDelayRun = false
        fn(musicInfo!, url, time)
      }, delay)
    } else {
      isDelayRun = true
      fn(musicInfo, url, time)
      delayTimer = BackgroundTimer.setTimeout(() => {
        delayTimer = null
        isDelayRun = false
      }, 500)
    }
  }
})((musicInfo, url, time) => {
  handlePlayMusic(musicInfo, url, time)
})

export const setResource = (musicInfo: LX.Player.PlayMusic, url: string, duration?: number) => {
  playMusic(musicInfo, url, duration ?? 0)
}

export const setPlay = async() => TrackPlayer.play()
export const getPosition = async() => TrackPlayer.getPosition()
export const getDuration = async() => TrackPlayer.getDuration()
export const setStop = async() => {
  await TrackPlayer.stop()
  if (!isEmpty()) await TrackPlayer.skipToNext()
}
export const setLoop = async(loop: boolean) => TrackPlayer.setRepeatMode(loop ? RepeatMode.Off : RepeatMode.Track)

export const setPause = async() => TrackPlayer.pause()
// export const skipToNext = () => TrackPlayer.skipToNext()
export const setCurrentTime = async(time: number) => TrackPlayer.seekTo(time)
export const setVolume = async(num: number) => TrackPlayer.setVolume(num)
export const setPlaybackRate = async(num: number) => TrackPlayer.setRate(num)
export interface NowPlayingTitles {
  title?: string
  artist?: string
  album?: string
  lyric?: string
}
export const updateNowPlayingTitles = async(titles: NowPlayingTitles) => {
  // console.log('set playing titles', titles)
  return TrackPlayer.updateNowPlayingTitles(titles)
}

export const resetPlay = async() => Promise.all([setPause(), setCurrentTime(0)])

export const isCached = async(url: string) => TrackPlayer.isCached(url)
export const getCacheSize = async() => TrackPlayer.getCacheSize()
export const clearCache = async() => TrackPlayer.clearCache()
export const migratePlayerCache = async() => {
  const newCachePath = privateStorageDirectoryPath + '/TrackPlayer'
  if (await existsFile(newCachePath)) return
  const oldCachePath = temporaryDirectoryPath + '/TrackPlayer'
  if (!await existsFile(oldCachePath)) return
  let timeout: number | null = BackgroundTimer.setTimeout(() => {
    timeout = null
    toast(global.i18n.t('player_cache_migrating'), 'long')
  }, 2_000)
  await moveFile(oldCachePath, newCachePath).finally(() => {
    if (timeout) BackgroundTimer.clearTimeout(timeout)
  })
}

export const destroy = async() => {
  if (global.lx.playerStatus.isIniting || !global.lx.playerStatus.isInitialized) return
  await TrackPlayer.destroy()
  global.lx.playerStatus.isInitialized = false
}

type PlayStatus = 'None' | 'Ready' | 'Playing' | 'Paused' | 'Stopped' | 'Buffering' | 'Connecting'

export const onStateChange = async(listener: (state: PlayStatus) => void) => {
  const sub = TrackPlayer.addEventListener(Event.PlaybackState, state => {
    let _state: PlayStatus
    switch (state) {
      case State.Ready:
        _state = 'Ready'
        break
      case State.Playing:
        _state = 'Playing'
        break
      case State.Paused:
        _state = 'Paused'
        break
      case State.Stopped:
        _state = 'Stopped'
        break
      case State.Buffering:
        _state = 'Buffering'
        break
      case State.Connecting:
        _state = 'Connecting'
        break
      case State.None:
      default:
        _state = 'None'
        break
    }
    listener(_state)
  })

  return () => {
    sub.remove()
  }
}

/**
 * Subscription player state chuange event
 * @param options state change event
 * @returns remove event function
 */
// export const playState = callback => TrackPlayer.addEventListener('playback-state', callback)

// 通知栏按钮用的图标：写的是本应用 drawable 的名字，原生侧按名字找资源
// （见 dependencies-patch.js）。RNTP 自带的那套 PNG 图形画得比较小，
// 这里换成图形画得更满的自绘矢量图，看着大一圈
const NOTIFICATION_ICONS = {
  previous: 'ic_notify_previous',
  next: 'ic_notify_next',
  play: 'ic_notify_play',
  pause: 'ic_notify_pause',
}
// 播放模式按钮的图标跟着当前模式变，通知栏/锁屏上一眼能看出现在是什么模式
const PLAY_MODE_ICONS: Record<string, string> = {
  [MUSIC_TOGGLE_MODE.listLoop]: 'ic_notify_mode_list_loop',
  [MUSIC_TOGGLE_MODE.singleLoop]: 'ic_notify_mode_single_loop',
  [MUSIC_TOGGLE_MODE.random]: 'ic_notify_mode_random',
  [MUSIC_TOGGLE_MODE.list]: 'ic_notify_mode_order',
  [MUSIC_TOGGLE_MODE.none]: 'ic_notify_mode_order',
}
// RNTP 的 TS 类型把图标写成 require() 出来的资源 id（是个 number），但原生侧的
// MetadataManager.getIcon 实际读的是 { uri: 'drawable 名' }，用本应用的 drawable 就得绕过这层类型
const drawableIcon = (name: string) => ({ uri: name }) as unknown as number

export const updateOptions = async(options = {
  // Whether the player should stop running when the app is closed on Android
  // stopWithApp: true,

  // An array of media controls capabilities
  // Can contain CAPABILITY_PLAY, CAPABILITY_PAUSE, CAPABILITY_STOP, CAPABILITY_SEEK_TO,
  // CAPABILITY_SKIP_TO_NEXT, CAPABILITY_SKIP_TO_PREVIOUS, CAPABILITY_SET_RATING
  capabilities: [
    Capability.Play,
    Capability.Pause,
    Capability.SeekTo,
    Capability.SkipToNext,
    Capability.SkipToPrevious,
    // 通知栏里多出来的那两个按钮（播放模式 / 桌面歌词）走的是 ACTION_REWIND /
    // ACTION_FAST_FORWARD 这两个媒体键，系统把媒体键交给会话之前会先看播放状态里
    // 有没有对应的 action，所以这两条能力要带上；但别放进 notificationCapabilities，
    // 一放进去 RNTP 自带的 Rewind / Forward 两个按钮也会跟着冒出来
    Capability.JumpBackward,
    Capability.JumpForward,
  ],

  // 通知栏只保留 上一首 / 播放暂停 / 下一首，去掉退出（Stop）。
  // 这些按钮在原生侧由 notificationCapabilities 门控创建
  // （MetadataManager 里的 createAction(notification, ...)），capabilities
  // 只是广告给系统的能力集合，不影响应用自身的 setStop()（那是直接调用
  // MusicModule.stop，不走能力掩码）。
  notificationCapabilities: [
    Capability.Play,
    Capability.Pause,
    Capability.SkipToNext,
    Capability.SkipToPrevious,
  ],

  // // An array of capabilities that will show up when the notification is in the compact form on Android
  // 折叠态最多显示 3 个按钮，所以上一首也要列进来，三个键才会同时出现
  compactCapabilities: [
    Capability.Play,
    Capability.Pause,
    Capability.SkipToPrevious,
    Capability.SkipToNext,
  ],

  // Icons for the notification on Android (if you don't like the default ones)
  previousIcon: drawableIcon(NOTIFICATION_ICONS.previous),
  nextIcon: drawableIcon(NOTIFICATION_ICONS.next),
  playIcon: drawableIcon(NOTIFICATION_ICONS.play),
  pauseIcon: drawableIcon(NOTIFICATION_ICONS.pause),
  // icon: notificationIcon, // The notification icon

  // 通知栏里额外两个按钮：播放模式切换（「上一首」前面）、桌面歌词开关（「下一首」后面）。
  // 位置和点下去干什么由原生补丁 + src/plugins/player/service.ts 决定；
  // 图标跟着当前状态走（切模式/开关歌词时会重推一次这里的选项）
  playModeButton: true,
  playModeIcon: drawableIcon(PLAY_MODE_ICONS[settingState.setting['player.togglePlayMethod']] ?? PLAY_MODE_ICONS[MUSIC_TOGGLE_MODE.listLoop]),
  lyricButton: true,
  lyricIcon: drawableIcon(settingState.setting['desktopLyric.enable'] ? 'ic_notify_lyric_on' : 'ic_notify_lyric_off'),
}) => {
  return TrackPlayer.updateOptions(options)
}

// export const setMaxCache = async size => {
//   // const currentTrack = await TrackPlayer.getCurrentTrack()
//   // if (!currentTrack) return
//   // console.log(currentTrack)
//   // const currentTime = await TrackPlayer.getPosition()
//   // const state = await TrackPlayer.getState()
//   // await stop()
//   // await TrackPlayer.destroy()
//   // await TrackPlayer.setupPlayer({ maxCacheSize: size * 1024, maxBuffer: 1000, waitForBuffer: true })
//   // await updateOptions()
//   // await TrackPlayer.seekTo(currentTime)
//   // switch (state) {
//   //   case TrackPlayer.STATE_PLAYING:
//   //   case TrackPlayer.STATE_BUFFERING:
//   //     await TrackPlayer.play()
//   //     break
//   //   default:
//   //     break
//   // }
// }

// export {
//   useProgress,
// }

export { updateMetaData, initTrackInfo } from './playList'
