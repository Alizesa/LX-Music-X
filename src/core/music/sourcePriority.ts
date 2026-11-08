import settingState from '@/store/setting/state'
import { state as userApiState } from '@/store/userApi'
import { resolveApiSourceOrder } from '@/utils/apiSourceOrder'
import { isRequestCancelled, requestMsg } from '@/utils/message'
import { requestUserApiMusicUrl } from '@/core/userApiRuntime'
import { validateQQMusicUrl } from '@/core/qqMusicUrl'

const COOLDOWN = 30_000
const failedUrls = new Map<string, number>()
const failedSources = new Map<string, number>()
const sourceUrls = new Map<string, string>()

const remember = <T>(map: Map<string, T>, key: string, value: T) => {
  map.delete(key)
  map.set(key, value)
  if (map.size > 128) map.delete(map.keys().next().value!)
}

export const isMusicUrlFailed = (url: string) => (failedUrls.get(url) ?? 0) > Date.now()
export const markMusicUrlFailed = (url: string) => {
  if (!/^https?:\/\//i.test(url)) return
  const until = Date.now() + COOLDOWN
  remember(failedUrls, url, until)
  for (const [key, candidate] of sourceUrls) if (candidate == url) remember(failedSources, key, until)
}

export type ValidateMusicUrl = (url: string) => Promise<void>
export interface MusicUrlRequestOptions {
  quality?: LX.Quality
  urlSourceOrder?: LX.Music.UrlSourceOrder
  onCancel?: (cancel: () => void) => void
  validateUrl?: ValidateMusicUrl
  rejectedUrls?: ReadonlySet<string>
}
export const getEnabledMusicSourceIds = () => {
  const setting = settingState.setting
  return resolveApiSourceOrder(setting['common.apiSourceOrder'], setting['common.apiSource'], userApiState.list)
}

/** 一轮只依次请求已勾选的脚本；失败冷却按歌曲/音质隔离，不误伤这个源的其他歌曲。 */
export const getMusicUrlByPriority = async({ musicInfo, quality, onCancel, validateUrl, rejectedUrls, allowQualityFallback = true, isRefresh = false }: {
  musicInfo: LX.Music.MusicInfoOnline
  quality: LX.Quality
  onCancel?: (cancel: () => void) => void
  validateUrl?: ValidateMusicUrl
  rejectedUrls?: ReadonlySet<string>
  /** 播放允许降级；下载显式指定音质时必须按原音质继续尝试备用源。 */
  allowQualityFallback?: boolean
  isRefresh?: boolean
}): Promise<{ url: string, quality: LX.Quality, musicInfo: LX.Music.MusicInfoOnline, isFromCache: boolean }> => {
  const ids = getEnabledMusicSourceIds()
  let cancelled = false
  let currentCancel: (() => void) | undefined
  onCancel?.(() => { cancelled = true; currentCancel?.() })
  const assertActive = () => { if (cancelled) throw new Error(requestMsg.cancelRequest) }
  const registerCancel = (cancel: () => void) => {
    currentCancel = cancel
    if (cancelled) cancel()
  }
  for (const apiId of ids) {
    assertActive()
    const key = `${apiId}:${musicInfo.id}:${quality}:${allowQualityFallback ? 'fallback' : 'exact'}`
    if ((failedSources.get(key) ?? 0) > Date.now()) continue
    const previousUrl = sourceUrls.get(key)
    if (previousUrl && rejectedUrls?.has(previousUrl)) continue
    try {
      const result = await requestUserApiMusicUrl(apiId, musicInfo, quality, registerCancel, allowQualityFallback)
      assertActive()
      if (typeof result.url != 'string' || !/^https?:\/\//i.test(result.url) || isMusicUrlFailed(result.url) || rejectedUrls?.has(result.url)) throw new Error('Invalid music URL')
      remember(sourceUrls, key, result.url)
      try {
        // 首次取链与缓存命中使用同一套完整性检查；预加载只能读取通过检查的音频。
        await validateQQMusicUrl(musicInfo, result.url, registerCancel, isRefresh)
        assertActive()
        await validateUrl?.(result.url)
      } catch (error) {
        assertActive()
        if (!isRequestCancelled(error)) markMusicUrlFailed(result.url)
        throw error
      }
      assertActive()
      failedSources.delete(key)
      return { url: result.url, quality: result.type, musicInfo, isFromCache: false }
    } catch (error) {
      assertActive()
      if (isRequestCancelled(error)) throw error
      remember(failedSources, key, Date.now() + COOLDOWN)
    }
  }
  assertActive()
  throw new Error(global.i18n.t('toggle_source_failed'))
}
