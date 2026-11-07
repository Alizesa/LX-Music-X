import { NativeModules } from 'react-native'
import { requestMsg } from '@/utils/message'
import { defaultUserAgent } from './playList'
import BackgroundTimer from 'react-native-background-timer'

interface CacheResult { cachedBytes: number, complete: boolean }
const nativePlayer = (NativeModules.TrackPlayerModule ?? {}) as {
  preloadMusic?: (id: string, url: string, userAgent: string, maxBytes: number) => Promise<CacheResult | null>
  cancelPreloadMusic?: (id: string) => void
}
let nextId = 0

export const canPreloadAudio = () => typeof nativePlayer.preloadMusic == 'function'

export const preloadAudio = async(url: string, maxBytes: number, onCancel: (cancel: () => void) => void): Promise<CacheResult | null> => {
  if (!nativePlayer.preloadMusic) return null
  const id = `audio_${Date.now()}_${++nextId}`
  let aborted = false
  let settled = false
  let rejectCancelled: (error: Error) => void = () => {}
  const cancelled = new Promise<never>((resolve, reject) => { rejectCancelled = reject })
  const abort = (message: string) => {
    if (aborted || settled) return
    aborted = true
    try { nativePlayer.cancelPreloadMusic?.(id) } catch {}
    rejectCancelled(new Error(message))
  }
  onCancel(() => { abort(requestMsg.cancelRequest) })
  const timeout = maxBytes > 0 ? BackgroundTimer.setTimeout(() => { abort('Audio preload timeout') }, 15_000) : null
  const request = aborted ? Promise.reject(new Error(requestMsg.cancelRequest)) : nativePlayer.preloadMusic(id, url, defaultUserAgent, maxBytes)
  return Promise.race([request, cancelled]).catch((error: Error & { code?: string }) => {
    if (error.code == 'preload_cancelled') throw new Error(requestMsg.cancelRequest)
    throw error
  }).finally(() => {
    settled = true
    if (timeout != null) BackgroundTimer.clearTimeout(timeout)
  })
}
