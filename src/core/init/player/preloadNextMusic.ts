import TrackPlayer from 'react-native-track-player'
import BackgroundTimer from 'react-native-background-timer'
import { getNextPlayMusicInfo, resetRandomNextMusicInfo } from '@/core/player/player'
import { cancelPreload, hasPreloadMusic, isPreloadCacheClearing, isPreloadPaused, keepPreloadFor, onPreloadCacheClearingChanged, pausePreload, preloadMusic } from '@/core/player/preload'
import { canPreloadAudio } from '@/plugins/player/preload'
import playerState from '@/store/player/state'
import settingState from '@/store/setting/state'
import { isRequestCancelled } from '@/utils/message'
import { playbackLog, playbackLogId, playbackLogState, registerPlaybackLogSnapshot } from '@/utils/playbackLog'

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
  let reason = ''
  let phaseSince = Date.now()
  let lastBuffer: { position: number, buffered: number, duration?: number } | undefined

  const blockReason = () => {
    const setting = settingState.setting
    if (!setting['player.preloadNext']) return 'disabled'
    if (!canPreloadAudio()) return 'native_unavailable'
    if (!(Number(setting['player.cacheSize']) > 0)) return 'cache_disabled'
    if (isPreloadCacheClearing()) return 'cache_clearing'
    if (global.lx.isPlayedStop) return 'stopping'
    if (!playbackReady) return 'playback_not_ready'
    if (!playerState.isPlay) return 'not_playing'
    if (nextInfo === null) return failures > 2 ? 'retry_exhausted' : 'no_next'
    if (nextInfo && nextInfo.musicInfo.id === playerState.playMusicInfo.musicInfo?.id) return 'same_track'
    if (nextInfo && hasPreloadMusic(nextInfo.musicInfo) && !isPreloadPaused()) return 'task_exists'
    return ''
  }
  const snapshot = () => ({
    initialized: true,
    playId: playbackLogId(playerState.playMusicInfo, 'play'),
    musicId: playerState.playMusicInfo.musicInfo?.id,
    nextMusicId: nextInfo?.musicInfo.id,
    reason: blockReason() || (Date.now() < retryAfter ? 'cooldown' : Date.now() - stableSince < 3000 ? 'stable_playback' : reason || 'waiting_check'),
    revision,
    checking,
    scheduled: checkTimer != null,
    playbackReady,
    isPlay: playerState.isPlay,
    stableMs: Date.now() - stableSince,
    retryInMs: Math.max(0, retryAfter - Date.now()),
    failures,
    phaseElapsedMs: Date.now() - phaseSince,
    lastCheck,
    ...lastBuffer,
    bufferSeconds: lastBuffer ? lastBuffer.buffered - lastBuffer.position : undefined,
    requiredBufferSeconds: 10,
  })
  const phase = (value: string) => {
    if (reason !== value) phaseSince = Date.now()
    reason = value
    playbackLogState(`preload.wait.${value}`, String(revision), snapshot)
  }

  const clearCheck = () => {
    if (checkTimer == null) return
    BackgroundTimer.clearTimeout(checkTimer)
    checkTimer = null
  }
  const needsPreload = () => {
    return !blockReason()
  }
  const scheduleCheck = () => {
    const blocked = blockReason()
    if (blocked) { phase(blocked); return }
    if (checkTimer != null || checking) return
    const now = Date.now()
    const delay = Math.max(0, 3000 - (now - stableSince), 3000 - (now - lastCheck), retryAfter - now)
    playbackLogState('preload.scheduled', `${revision}:${reason}`, () => ({ ...snapshot(), delayMs: delay }))
    checkTimer = BackgroundTimer.setTimeout(() => {
      checkTimer = null
      void check()
    }, delay)
  }

  const handleFailure = (error: unknown, generation: number) => {
    if (generation !== revision) { playbackLog('preload.stale_failure', { generation, revision, error }); return }
    playbackLog('preload.failed', () => ({ ...snapshot(), error, cancelled: isRequestCancelled(error) }))
    if (!isRequestCancelled(error)) console.log('[Preload] Next track is not ready:', error instanceof Error ? error.message : error)
    clearCheck()
    // 与音源失败冷却对齐；同一首正在播放的歌曲最多补两次，不靠 UI 进度事件重试。
    if (++failures > 2) nextInfo = null
    else retryAfter = Date.now() + failures * 30_000
    phase(failures > 2 ? 'retry_exhausted' : 'cooldown')
    scheduleCheck()
  }

  // 进度事件和按需定时器共用检查；已有预加载任务后停止定时检查，熄屏时也能触发。
  const check = async() => {
    if (!needsPreload()) { phase(blockReason()); clearCheck(); return }
    if (checking) return
    const now = Date.now()
    if (now - stableSince < 3000 || now - lastCheck < 3000 || now < retryAfter) {
      phase(now < retryAfter ? 'cooldown' : now - stableSince < 3000 ? 'stable_playback' : 'check_interval')
      scheduleCheck()
      return
    }
    clearCheck()
    const generation = revision
    lastCheck = now
    checking = true
    try {
      if (nextInfo === undefined) {
        phase('selecting')
        const info = await getNextPlayMusicInfo()
        if (generation != revision) { playbackLog('preload.selection_discarded', { generation, revision }); return }
        // generation 已确认选曲期间队列未变化。
        // eslint-disable-next-line require-atomic-updates
        nextInfo = info
        playbackLog('preload.selected', snapshot)
      }
      if (!nextInfo || nextInfo.musicInfo.id == playerState.playMusicInfo.musicInfo?.id) { phase(blockReason()); return }
      // 熄屏后 UI 进度停止更新，缓冲余量必须使用播放器的实时位置。
      phase('buffer_query')
      const [position, buffered] = await Promise.all([TrackPlayer.getPosition(), TrackPlayer.getBufferedPosition()])
      if (generation != revision || !needsPreload() || Date.now() - stableSince < 3000) { playbackLog('preload.buffer_discarded', { generation, revision }); return }
      lastBuffer = { position, buffered }
      if (!Number.isFinite(position) || !Number.isFinite(buffered) || position < 0 || buffered < 0) { phase('invalid_buffer'); return }
      if (buffered - position < 10) {
        phase('duration_query')
        const duration = await TrackPlayer.getDuration()
        if (generation != revision || !needsPreload() || Date.now() - stableSince < 3000) { playbackLog('preload.duration_discarded', { generation, revision }); return }
        lastBuffer.duration = duration
        if (!(duration > 0 && buffered >= duration - 0.5)) { phase('buffer_low'); return }
      }
      // 回调也覆盖首段就绪之后的补缓存失败，不能只观察第一次取链的 Promise。
      phase('preparing')
      playbackLog('preload.start', snapshot)
      const promise = preloadMusic(nextInfo.musicInfo, error => { handleFailure(error, generation) }, playbackLogId(playerState.playMusicInfo, 'play'))
      if (!promise) playbackLog('preload.not_created', snapshot)
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
    reason = ''
    lastBuffer = undefined
    phaseSince = Date.now()
    playbackLog('preload.invalidated', snapshot)
    clearCheck()
    // 稍后播放出队前已更新当前歌曲，保留前台即将接管的任务。
    keepPreloadFor(playerState.playMusicInfo.musicInfo)
    scheduleCheck()
  }
  const pause = (origin: string) => {
    playbackReady = false
    revision++
    stableSince = Date.now()
    clearCheck()
    const current = playerState.playMusicInfo.musicInfo
    if (current && hasPreloadMusic(current)) keepPreloadFor(current)
    pausePreload()
    playbackLog('preload.paused', () => ({ ...snapshot(), origin }))
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
    playbackLog('preload.playing_event', snapshot)
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
    playbackLog('preload.settings_invalidated', { keys })
    invalidate()
  }

  registerPlaybackLogSnapshot('scheduler', snapshot)
  playbackLog('preload.scheduler_initialized', snapshot)
  global.app_event.on('musicToggled', syncPlayback)
  global.app_event.on('play', playing)
  global.app_event.on('playerPlaying', playing)
  global.app_event.on('playerWaiting', () => { pause('buffering') })
  global.app_event.on('pause', () => { pause('pause') })
  global.app_event.on('error', () => { pause('error') })
  global.app_event.on('stop', () => {
    pause('stop')
    if (global.lx.isPlayedStop) cancelPreload()
  })
  global.app_event.on('playQueueUpdate', queueChanged)
  global.state_event.on('playTempPlayListChanged', invalidate)
  global.state_event.on('configUpdated', configUpdated)
  global.state_event.on('playProgressChanged', () => { void check() })
  onPreloadCacheClearingChanged(invalidate)
  scheduleCheck()
}
