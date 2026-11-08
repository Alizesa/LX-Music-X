import TrackPlayer from 'react-native-track-player'
import BackgroundTimer from 'react-native-background-timer'
import { getNextPlayMusicInfo, resetRandomNextMusicInfo } from '@/core/player/player'
import { cancelPreload, hasPreloadMusic, isPreloadPaused, keepPreloadFor, pausePreload, preloadMusic } from '@/core/player/preload'
import { canPreloadAudio } from '@/plugins/player/preload'
import playerState from '@/store/player/state'
import settingState from '@/store/setting/state'
import { isRequestCancelled } from '@/utils/message'

export default () => {
  let revision = 0
  let checking = false
  let playbackReady = playerState.isPlay
  let checkTimer: number | null = null
  let stableSince = Date.now()
  let lastCheck = 0
  let nextInfo: LX.Player.PlayMusicInfo | null | undefined

  const clearCheck = () => {
    if (checkTimer == null) return
    BackgroundTimer.clearTimeout(checkTimer)
    checkTimer = null
  }
  const needsPreload = () => {
    const setting = settingState.setting
    if (!setting['player.preloadNext'] || !canPreloadAudio() || !(Number(setting['player.cacheSize']) > 0) ||
      !playbackReady || !playerState.isPlay || global.lx.isPlayedStop || nextInfo === null) return false
    return !nextInfo || (nextInfo.musicInfo.id != playerState.playMusicInfo.musicInfo?.id &&
      (!hasPreloadMusic(nextInfo.musicInfo) || isPreloadPaused()))
  }
  const scheduleCheck = () => {
    if (checkTimer != null || checking || !needsPreload()) return
    const now = Date.now()
    const delay = Math.max(0, 3000 - (now - stableSince), 3000 - (now - lastCheck))
    checkTimer = BackgroundTimer.setTimeout(() => {
      checkTimer = null
      void check()
    }, delay)
  }

  // 进度事件和按需定时器共用检查；已有预加载任务后停止定时检查，熄屏时也能触发。
  const check = async() => {
    if (!needsPreload()) { clearCheck(); return }
    if (checking) return
    const now = Date.now()
    if (now - stableSince < 3000 || now - lastCheck < 3000) { scheduleCheck(); return }
    clearCheck()
    const generation = revision
    lastCheck = now
    checking = true
    try {
      if (nextInfo === undefined) {
        const info = await getNextPlayMusicInfo()
        if (generation != revision) return
        // generation 已确认选曲期间队列未变化。
        // eslint-disable-next-line require-atomic-updates
        nextInfo = info
      }
      if (!nextInfo || nextInfo.musicInfo.id == playerState.playMusicInfo.musicInfo?.id) return
      // 熄屏后 UI 进度停止更新，缓冲余量必须使用播放器的实时位置。
      const [position, buffered] = await Promise.all([TrackPlayer.getPosition(), TrackPlayer.getBufferedPosition()])
      if (generation != revision || !needsPreload() || Date.now() - stableSince < 3000) return
      const { maxPlayTime } = playerState.progress
      if (buffered - position < 10 && !(maxPlayTime > 0 && buffered >= maxPlayTime - 0.5)) return
      const promise = preloadMusic(nextInfo.musicInfo)
      void promise?.catch(error => {
        if (!isRequestCancelled(error)) console.log('[Preload] Next track is not ready:', error.message)
      })
    } catch (error) {
      if (generation == revision) nextInfo = null
    } finally {
      // checking 在整个 await 期间阻止第二次检查进入。
      // eslint-disable-next-line require-atomic-updates
      checking = false
      scheduleCheck()
    }
  }

  const invalidate = () => {
    revision++
    nextInfo = undefined
    lastCheck = 0
    clearCheck()
    // 稍后播放出队前已更新当前歌曲，保留前台即将接管的任务。
    keepPreloadFor(playerState.playMusicInfo.musicInfo)
    scheduleCheck()
  }
  const pause = () => {
    playbackReady = false
    revision++
    stableSince = Date.now()
    clearCheck()
    const current = playerState.playMusicInfo.musicInfo
    if (current && hasPreloadMusic(current)) keepPreloadFor(current)
    pausePreload()
  }
  const musicToggled = () => {
    playbackReady = false
    stableSince = Date.now()
    invalidate()
  }
  const playing = () => {
    playbackReady = true
    stableSince = Date.now()
    clearCheck()
    scheduleCheck()
  }
  const queueChanged = () => {
    resetRandomNextMusicInfo()
    invalidate()
  }
  const configUpdated: typeof global.state_event.configUpdated = (keys) => {
    if (!keys.some(key => [
      'player.preloadNext', 'player.cacheSize', 'player.playQuality', 'player.urlSource', 'player.noVipStandardQuality',
      'player.togglePlayMethod', 'common.apiSourceOrder', 'common.apiSource',
    ].includes(key))) return
    if (keys.includes('player.togglePlayMethod')) resetRandomNextMusicInfo()
    cancelPreload()
    invalidate()
  }

  global.app_event.on('musicToggled', musicToggled)
  global.app_event.on('play', scheduleCheck)
  global.app_event.on('playerPlaying', playing)
  global.app_event.on('playerWaiting', pause)
  global.app_event.on('pause', pause)
  global.app_event.on('error', pause)
  global.app_event.on('stop', () => {
    pause()
    if (global.lx.isPlayedStop) cancelPreload()
  })
  global.app_event.on('playQueueUpdate', queueChanged)
  global.state_event.on('playTempPlayListChanged', invalidate)
  global.state_event.on('configUpdated', configUpdated)
  global.state_event.on('playProgressChanged', () => { void check() })
  scheduleCheck()
}
