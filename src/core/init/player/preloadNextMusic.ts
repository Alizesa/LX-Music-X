import TrackPlayer from 'react-native-track-player'
import { getNextPlayMusicInfo, resetRandomNextMusicInfo } from '@/core/player/player'
import { cancelPreload, hasPreloadMusic, isPreloadPaused, keepPreloadFor, pausePreload, preloadMusic } from '@/core/player/preload'
import { canPreloadAudio } from '@/plugins/player/preload'
import playerState from '@/store/player/state'
import settingState from '@/store/setting/state'
import { isRequestCancelled } from '@/utils/message'

export default () => {
  let revision = 0
  let checking = false
  let stableSince = Date.now()
  let lastCheck = 0
  let nextInfo: LX.Player.PlayMusicInfo | null | undefined

  // 使用已有的播放进度事件，不另开常驻轮询。确定下一首后，只有队列变化才重新选曲。
  const check = async() => {
    const setting = settingState.setting
    const now = Date.now()
    if (!setting['player.preloadNext'] || !canPreloadAudio() || !(Number(setting['player.cacheSize']) > 0) ||
      !playerState.isPlay || global.lx.isPlayedStop || checking || now - stableSince < 3000 || now - lastCheck < 3000) return
    if (nextInfo === null || (nextInfo && hasPreloadMusic(nextInfo.musicInfo) && !isPreloadPaused())) return
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
      const buffered = await TrackPlayer.getBufferedPosition()
      if (generation != revision || !playerState.isPlay || global.lx.isPlayedStop || Date.now() - stableSince < 3000) return
      const { nowPlayTime, maxPlayTime } = playerState.progress
      if (buffered - nowPlayTime < 10 && !(maxPlayTime > 0 && buffered >= maxPlayTime - 0.5)) return
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
    }
  }

  const invalidate = () => {
    revision++
    nextInfo = undefined
    lastCheck = 0
    // 稍后播放在真正切歌前会先从列表移除；此时当前歌曲已更新，要保住交接中的任务。
    keepPreloadFor(playerState.playMusicInfo.musicInfo)
  }
  const pause = () => {
    revision++
    stableSince = Date.now()
    const current = playerState.playMusicInfo.musicInfo
    if (current && hasPreloadMusic(current)) keepPreloadFor(current)
    pausePreload()
  }
  const musicToggled = () => {
    invalidate()
    stableSince = Date.now()
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
  global.app_event.on('playerPlaying', () => { stableSince = Date.now() })
  global.app_event.on('playerWaiting', pause)
  global.app_event.on('pause', pause)
  global.app_event.on('stop', () => {
    if (global.lx.isPlayedStop) cancelPreload()
    else pause()
  })
  global.app_event.on('playQueueUpdate', queueChanged)
  global.state_event.on('playTempPlayListChanged', invalidate)
  global.state_event.on('configUpdated', configUpdated)
  global.state_event.on('playProgressChanged', () => { void check() })
}
