import { AppState, DeviceEventEmitter, NativeModules, Platform } from 'react-native'
import { version, versionCode } from '../../../package.json'
import settingState from '@/store/setting/state'
import { flushPlaybackLogs, isPlaybackLogEnabled, playbackLog, registerPlaybackLogSnapshot, setPlaybackLogEnabled } from '@/utils/playbackLog'

let initialized = false
const native = (NativeModules.TrackPlayerModule ?? {}) as {
  preloadMusic?: unknown
  setPreloadDebugLogging?: (enabled: boolean) => void
}

export default (setting: LX.AppSetting) => {
  if (initialized) return
  initialized = true
  let subscription: { remove: () => void } | undefined
  registerPlaybackLogSnapshot('environment', () => {
    const current = settingState.setting
    return {
      version,
      versionCode,
      platform: Platform.OS,
      android: Platform.Version,
      appState: AppState.currentState,
      nativePreload: typeof native.preloadMusic === 'function',
      nativeDetails: typeof native.setPreloadDebugLogging === 'function',
      preloadEnabled: current['player.preloadNext'],
      cacheMiB: current['player.cacheSize'],
      quality: current['player.playQuality'],
      mode: current['player.togglePlayMethod'],
      urlSource: current['player.urlSource'],
      standardOnly: current['player.noVipStandardQuality'],
      primarySource: current['common.apiSource'],
      sourceOrder: current['common.apiSourceOrder'],
    }
  })
  const configure = (enable: boolean) => {
    setPlaybackLogEnabled(enable)
    if (enable && !subscription) {
      subscription = DeviceEventEmitter.addListener('playback-preload-debug', data => {
        playbackLog('native.preload', () => data as Record<string, unknown>)
      })
    }
    try { native.setPreloadDebugLogging?.(enable) } catch (error) { playbackLog('native.debug_error', { error }) }
    if (!enable) { subscription?.remove(); subscription = undefined }
    if (enable && !native.setPreloadDebugLogging) playbackLog('native.debug_unavailable', { reason: 'app_update_required' })
  }
  configure(setting['player.debugLog'])
  global.state_event.on('configUpdated', keys => {
    if (keys.includes('player.debugLog')) configure(settingState.setting['player.debugLog'])
    if (keys.some(key => key.startsWith('player.') || key.startsWith('common.apiSource'))) playbackLog('settings.changed', { keys })
  })
  AppState.addEventListener('change', state => {
    if (!isPlaybackLogEnabled()) return
    playbackLog('app.state', { state })
    if (state !== 'active') void flushPlaybackLogs().catch(() => {})
  })
}
