import { NativeModules } from 'react-native'
import { requestMsg } from '@/utils/message'
import { defaultUserAgent } from './playList'
import BackgroundTimer from 'react-native-background-timer'
import { playbackLog, type PlaybackLogContext } from '@/utils/playbackLog'

interface CacheResult { cachedBytes: number, complete: boolean }
const nativePlayer = (NativeModules.TrackPlayerModule ?? {}) as {
  preloadMusic?: (id: string, url: string, userAgent: string, maxBytes: number) => Promise<CacheResult | null>
  cancelPreloadMusic?: (id: string) => void
}
let nextId = 0

export const canPreloadAudio = () => typeof nativePlayer.preloadMusic == 'function'

export const preloadAudio = async(url: string, maxBytes: number, onCancel: (cancel: () => void) => void, trace?: PlaybackLogContext): Promise<CacheResult | null> => {
  if (!nativePlayer.preloadMusic) { playbackLog('audio.unavailable', { ...trace, reason: 'native_method_missing' }); return null }
  const id = `audio_${Date.now()}_${++nextId}`
  const startedAt = Date.now()
  playbackLog('audio.request', () => ({ ...trace, audioId: id, url, maxBytes, phase: maxBytes > 0 ? 'head' : 'fill' }))
  let aborted = false
  let settled = false
  let rejectCancelled: (error: Error) => void = () => {}
  const cancelled = new Promise<never>((resolve, reject) => { rejectCancelled = reject })
  const abort = (message: string) => {
    if (aborted || settled) return
    aborted = true
    playbackLog('audio.cancel', () => ({ ...trace, audioId: id, reason: message, elapsedMs: Date.now() - startedAt }))
    try { nativePlayer.cancelPreloadMusic?.(id) } catch {}
    rejectCancelled(new Error(message))
  }
  onCancel(() => { abort(requestMsg.cancelRequest) })
  const timeout = maxBytes > 0 ? BackgroundTimer.setTimeout(() => { abort('Audio preload timeout') }, 15_000) : null
  const request = aborted ? Promise.reject(new Error(requestMsg.cancelRequest)) : nativePlayer.preloadMusic(id, url, defaultUserAgent, maxBytes)
  return Promise.race([request, cancelled]).then(result => {
    playbackLog('audio.result', () => ({ ...trace, audioId: id, result, reason: result == null ? 'cache_unavailable' : result.complete ? 'complete' : 'partial', elapsedMs: Date.now() - startedAt }))
    return result
  }).catch((error: Error & { code?: string }) => {
    playbackLog('audio.failed', () => ({ ...trace, audioId: id, error, elapsedMs: Date.now() - startedAt }))
    if (error.code == 'preload_cancelled') throw new Error(requestMsg.cancelRequest)
    throw error
  }).finally(() => {
    settled = true
    if (timeout != null) BackgroundTimer.clearTimeout(timeout)
  })
}
