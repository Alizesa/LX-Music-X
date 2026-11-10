import { isPlayRequested, playNext, setMusicUrl } from '@/core/player/player'
import { setStatusText } from '@/core/player/playStatus'
import { getPosition, isEmpty, setStop } from '@/plugins/player'
import { isActive } from '@/utils/tools'
import BackgroundTimer from 'react-native-background-timer'
import playerState from '@/store/player/state'
import { setNowPlayTime } from '@/core/player/progress'
import settingState from '@/store/setting/state'
import { addPlayHistory } from '@/core/player/playHistory'
import { parseApiSourceOrder } from '@/utils/apiSourceOrder'
import { playbackLog, playbackLogId } from '@/utils/playbackLog'


export default () => {
  let retryNum = 0
  let historyPlayback: typeof playerState.playMusicInfo | null = null
  let recovery: { playback: typeof playerState.playMusicInfo } | null = null

  let loadingTimeout: number | null = null
  let delayNextTimeout: number | null = null
  const startLoadingTimeout = () => {
    if (loadingTimeout != null) return
    const playback = playerState.playMusicInfo
    loadingTimeout = BackgroundTimer.setTimeout(() => {
      loadingTimeout = null
      if (!isPlayRequested() || global.lx.isPlayedStop || playback !== playerState.playMusicInfo) return
      playbackLog('player.buffer_timeout', () => ({ playId: playbackLogId(playback, 'play'), retryNum }))
      // 缓冲超时和原生报错共用换源次数、进度恢复及取消保护，不能跳过剩余备用源。
      handleError()
    }, 25000)
  }
  const clearLoadingTimeout = () => {
    if (!loadingTimeout) return
    // console.log('clear load timeout')
    BackgroundTimer.clearTimeout(loadingTimeout)
    loadingTimeout = null
  }

  const clearDelayNextTimeout = () => {
    // console.log(this.delayNextTimeout)
    if (!delayNextTimeout) return
    BackgroundTimer.clearTimeout(delayNextTimeout)
    delayNextTimeout = null
  }
  const addDelayNextTimeout = () => {
    clearDelayNextTimeout()
    const playback = playerState.playMusicInfo
    delayNextTimeout = BackgroundTimer.setTimeout(() => {
      delayNextTimeout = null
      if (!isPlayRequested() || global.lx.isPlayedStop || playback !== playerState.playMusicInfo) return
      void playNext(true)
    }, 5000)
  }

  const handleLoadstart = () => {
    if (global.lx.isPlayedStop || !isPlayRequested()) return
    startLoadingTimeout()
    setStatusText(global.i18n.t('player__loading'))
  }

  // const handleLoadeddata = () => {
  //   setStatusText(global.i18n.t('player__loading'))
  // }

  // const handleCanplay = () => {
  //   setStatusText('')
  // }

  const handlePlaying = () => {
    setStatusText('')
    clearLoadingTimeout()
    clearDelayNextTimeout()
    const playback = playerState.playMusicInfo
    if (settingState.setting['player.isSavePlayHistory'] && playback.musicInfo && historyPlayback !== playback) {
      // 暂停/缓冲恢复也会触发 Playing，同一次播放只整理和保存一次历史。
      historyPlayback = playback
      void addPlayHistory(playback.musicInfo).catch(error => {
        if (historyPlayback === playback) historyPlayback = null
        console.warn('[PlayHistory] save failed:', error instanceof Error ? error.message : error)
      })
    }
  }

  const handleEmpied = () => {
    clearDelayNextTimeout()
    clearLoadingTimeout()
  }

  const handleWating = () => {
    if (!isPlayRequested() || global.lx.isPlayedStop) return
    startLoadingTimeout()
    setStatusText(global.i18n.t('player__buffering'))
  }

  const handleError = () => {
    if (!playerState.musicInfo.id) return
    clearLoadingTimeout()
    if (global.lx.isPlayedStop || !isPlayRequested()) return
    const playback = playerState.playMusicInfo
    if (recovery?.playback === playback) return
    const maxRetries = Math.max(2, parseApiSourceOrder(settingState.setting['common.apiSourceOrder'], settingState.setting['common.apiSource']).length)
    if (playerState.playMusicInfo.musicInfo && retryNum < maxRetries) { // 为勾选的备用音源保留接替机会
      const current = recovery = { playback }
      const isCurrent = () => recovery === current && playerState.playMusicInfo === playback && isPlayRequested() && !global.lx.isPlayedStop
      retryNum++
      playbackLog('player.retry', () => ({ playId: playbackLogId(playback, 'play'), retryNum, maxRetries }))
      void getPosition().then((position) => {
        if (isCurrent() && Number.isFinite(position) && position > 0) setNowPlayTime(position)
      }).catch(error => {
        console.warn(error)
      }).finally(() => {
        if (isCurrent()) {
          setMusicUrl(playback.musicInfo!, true)
          setStatusText(global.i18n.t('player__refresh_url'))
        }
        if (recovery === current) recovery = null
      })
      return
    }
    void (isEmpty() ? Promise.resolve() : setStop()).catch(console.warn).then(() => {
      if (playback !== playerState.playMusicInfo || !isPlayRequested() || global.lx.isPlayedStop) return
      if (isActive()) {
        setStatusText(global.i18n.t('player__error'))
        addDelayNextTimeout()
      } else void playNext(true)
    })
  }

  const handleSetPlayInfo = () => {
    retryNum = 0
    recovery = null
    if (historyPlayback !== playerState.playMusicInfo) historyPlayback = null
    clearDelayNextTimeout()
    clearLoadingTimeout()
  }

  // const handlePlayedStop = () => {
  //   clearDelayNextTimeout()
  //   clearLoadingTimeout()
  // }


  global.app_event.on('playerLoadstart', handleLoadstart)
  // global.app_event.on('playerLoadeddata', handleLoadeddata)
  // global.app_event.on('playerCanplay', handleCanplay)
  global.app_event.on('playerPlaying', handlePlaying)
  global.app_event.on('playerWaiting', handleWating)
  global.app_event.on('playerEmptied', handleEmpied)
  global.app_event.on('playerError', handleError)
  global.app_event.on('musicToggled', handleSetPlayInfo)
  global.app_event.on('playerPause', clearLoadingTimeout)
  global.app_event.on('pause', () => {
    // Buffering 也会发布 pause；只有用户暂停才取消恢复计时。
    if (!isPlayRequested()) handleEmpied()
  })
  global.app_event.on('stop', handleEmpied)
}
