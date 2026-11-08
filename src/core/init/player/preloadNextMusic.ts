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
  let failures = 0
  let retryAfter = 0
  let playback = playerState.playMusicInfo
  let playbackId = playback.musicInfo?.id

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
    const delay = Math.max(0, 3000 - (now - stableSince), 3000 - (now - lastCheck), retryAfter - now)
    checkTimer = BackgroundTimer.setTimeout(() => {
      checkTimer = null
      void check()
    }, delay)
  }

  const handleFailure = (error: unknown, generation: number) => {
    if (generation !== revision) return
    if (!isRequestCancelled(error)) console.log('[Preload] Next track is not ready:', error instanceof Error ? error.message : error)
    clearCheck()
    // 与音源失败冷却对齐；同一首正在播放的歌曲最多补两次，不靠 UI 进度事件重试。
    if (++failures > 2) nextInfo = null
    else retryAfter = Date.now() + failures * 30_000
    scheduleCheck()
  }

  // 进度事件和按需定时器共用检查；已有预加载任务后停止定时检查，熄屏时也能触发。
  const check = async() => {
    if (!needsPreload()) { clearCheck(); return }
    if (checking) return
    const now = Date.now()
    if (now - stableSince < 3000 || now - lastCheck < 3000 || now < retryAfter) { scheduleCheck(); return }
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
      if (!Number.isFinite(position) || !Number.isFinite(buffered) || position < 0 || buffered < 0) return
      if (buffered - position < 10) {
        const duration = await TrackPlayer.getDuration()
        if (generation != revision || !needsPreload() || Date.now() - stableSince < 3000) return
        if (!(duration > 0 && buffered >= duration - 0.5)) return
      }
      // 回调也覆盖首段就绪之后的补缓存失败，不能只观察第一次取链的 Promise。
      const promise = preloadMusic(nextInfo.musicInfo, error => { handleFailure(error, generation) })
      void promise?.catch(() => {})
    } catch (error) {
      handleFailure(error, generation)
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
    failures = 0
    retryAfter = 0
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
  const syncPlayback = () => {
    const current = playerState.playMusicInfo
    if (playback === current && playbackId === current.musicInfo?.id) return
    playback = current
    playbackId = current.musicInfo?.id
    playbackReady = false
    stableSince = Date.now()
    invalidate()
  }
  const playing = () => {
    syncPlayback()
    if (!playbackReady) stableSince = Date.now()
    playbackReady = true
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

  global.app_event.on('musicToggled', syncPlayback)
  global.app_event.on('play', playing)
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
