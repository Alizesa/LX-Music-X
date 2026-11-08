import TrackPlayer from 'react-native-track-player'
import { updateOptions, setVolume, setPlaybackRate, migratePlayerCache } from './utils'
import { playbackLog } from '@/utils/playbackLog'

let initializing: Promise<void> | null = null

const initial = async({ volume, playRate, cacheSize, isHandleAudioFocus, isEnableAudioOffload }: {
  volume: number
  playRate: number
  cacheSize: number
  isHandleAudioFocus: boolean
  isEnableAudioOffload: boolean
}) => {
  if (initializing) return initializing
  if (global.lx.playerStatus.isInitialized) return
  global.lx.playerStatus.isIniting = true
  initializing = (async() => {
    playbackLog('player.initialization_start', { cacheMiB: cacheSize, volume, playRate, isHandleAudioFocus, isEnableAudioOffload })
    await migratePlayerCache()
    try {
      await TrackPlayer.setupPlayer({
        maxCacheSize: cacheSize * 1024,
        // RNTP 的单位是秒；默认 minBuffer 50 秒，前向缓冲留 60 秒。
        maxBuffer: 60,
        waitForBuffer: true,
        handleAudioFocus: isHandleAudioFocus,
        audioOffload: isEnableAudioOffload,
        autoUpdateMetadata: false,
      })
      await updateOptions()
      await setVolume(volume)
      await setPlaybackRate(playRate)
      global.lx.playerStatus.isInitialized = true
      playbackLog('player.initialization_done')
    } catch (error) {
      playbackLog('player.initialization_failed', { error })
      // 配置阶段失败也要清理已创建的原生播放器，让下一次初始化可以重试。
      await TrackPlayer.destroy().catch(() => {})
      throw error
    }
  })().finally(() => {
    global.lx.playerStatus.isIniting = false
    initializing = null
  })
  return initializing
}


const isInitialized = () => global.lx.playerStatus.isInitialized


export {
  initial,
  isInitialized,
  setVolume,
  setPlaybackRate,
}

export {
  setResource,
  setPause,
  setPlay,
  setCurrentTime,
  getDuration,
  setStop,
  resetPlay,
  getPosition,
  updateMetaData,
  onStateChange,
  isEmpty,
  useBufferProgress,
  initTrackInfo,
} from './utils'
