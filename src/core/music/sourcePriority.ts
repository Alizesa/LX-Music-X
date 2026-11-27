import settingState from '@/store/setting/state'
import { state as userApiState } from '@/store/userApi'
import { resolveApiSourceOrder } from '@/utils/apiSourceOrder'
import { isRequestCancelled, requestMsg } from '@/utils/message'
import { requestUserApiMusicUrl } from '@/core/userApiRuntime'
import { discardRedirectedAudioProbe, validateMusicUrl } from '@/core/musicUrlValidation'
import { type RemoteAudioInfo } from '@/utils/nativeModules/remoteAudio'
import { playbackLog, type PlaybackLogContext } from '@/utils/playbackLog'

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
export const assertMusicUrlAvailable = (url: string, rejectedUrls?: ReadonlySet<string>) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || isMusicUrlFailed(url) || rejectedUrls?.has(url)) throw new Error('Invalid music URL')
}
const isAudioProbeFailure = (error: unknown) => (error as { isAudioProbeFailure?: boolean } | null)?.isAudioProbeFailure === true
export const markMusicUrlFailed = (url: string, error?: unknown) => {
  if (isAudioProbeFailure(error)) return
  if (!/^https?:\/\//i.test(url)) return
  const until = Date.now() + COOLDOWN
  remember(failedUrls, url, until)
  for (const [key, candidate] of sourceUrls) if (candidate == url) remember(failedSources, key, until)
}

export type ValidateMusicUrl = (url: string, media?: RemoteAudioInfo) => Promise<void>
export interface MusicUrlRequestOptions {
  quality?: LX.Quality
  urlSourceOrder?: LX.Music.UrlSourceOrder
  onCancel?: (cancel: () => void) => void
  validateUrl?: ValidateMusicUrl
  rejectedUrls?: ReadonlySet<string>
  /** 内部换源沿用同一次取址的缓存上下文。 */
  cacheContext?: string
  trace?: PlaybackLogContext
  /** 换源后仍按原曲时长验证，不能把替代版本自身的时长当作完整性依据。 */
  expectedMusicInfo?: LX.Music.MusicInfo
}

export interface OnlineMusicUrl {
  url: string
  /** 播放和下载使用探测得到的直链，持久缓存仍使用脚本的原地址。 */
  sourceUrl?: string
  quality: LX.Quality
  musicInfo: LX.Music.MusicInfoOnline
  isFromCache: boolean
}

export const prepareMusicUrl = async(musicInfo: LX.Music.MusicInfo, sourceUrl: string, assertActive: () => void, {
  onCancel, isRefresh, trace, expectedMusicInfo, validateUrl, rejectedUrls,
}: MusicUrlRequestOptions & { isRefresh?: boolean, trace?: PlaybackLogContext & { apiId?: string } }): Promise<string> => {
  const media = await validateMusicUrl(musicInfo, sourceUrl, onCancel, isRefresh, trace, expectedMusicInfo).catch(error => {
    assertActive()
    if (!isRequestCancelled(error)) markMusicUrlFailed(sourceUrl, error)
    throw error
  })
  const url = media?.resolvedUrl ?? sourceUrl
  const assertAvailable = () => {
    assertActive()
    assertMusicUrlAvailable(sourceUrl, rejectedUrls)
    if (url !== sourceUrl) {
      if (media && (isMusicUrlFailed(url) || rejectedUrls?.has(url))) discardRedirectedAudioProbe(sourceUrl, media)
      assertMusicUrlAvailable(url, rejectedUrls)
    }
  }
  assertAvailable()
  try {
    await validateUrl?.(url, media)
  } catch (error) {
    assertActive()
    if (!isRequestCancelled(error)) {
      markMusicUrlFailed(url, error)
      if (media && !isAudioProbeFailure(error)) discardRedirectedAudioProbe(sourceUrl, media)
    }
    throw error
  }
  assertAvailable()
  return url
}

export const getEnabledMusicSourceIds = () => {
  const setting = settingState.setting
  return resolveApiSourceOrder(setting['common.apiSourceOrder'], setting['common.apiSource'], userApiState.list)
}

/** 一轮只依次请求已勾选的脚本；失败冷却按歌曲/音质隔离，不误伤这个源的其他歌曲。 */
export const getMusicUrlByPriority = async({ musicInfo, quality, onCancel, validateUrl, rejectedUrls, allowQualityFallback = true, isRefresh = false, trace, expectedMusicInfo }: {
  musicInfo: LX.Music.MusicInfoOnline
  quality: LX.Quality
  onCancel?: (cancel: () => void) => void
  validateUrl?: ValidateMusicUrl
  rejectedUrls?: ReadonlySet<string>
  /** 播放允许降级；下载显式指定音质时必须按原音质继续尝试备用源。 */
  allowQualityFallback?: boolean
  isRefresh?: boolean
  trace?: PlaybackLogContext
  expectedMusicInfo?: LX.Music.MusicInfo
}): Promise<OnlineMusicUrl> => {
  const ids = getEnabledMusicSourceIds()
  playbackLog('url.sources', () => ({ ...trace, musicId: musicInfo.id, sources: ids, quality, isRefresh }))
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
    if ((failedSources.get(key) ?? 0) > Date.now()) { playbackLog('url.source_skip', { ...trace, apiId, reason: 'cooldown', until: failedSources.get(key) }); continue }
    const previousUrl = sourceUrls.get(key)
    if (previousUrl && rejectedUrls?.has(previousUrl)) { playbackLog('url.source_skip', { ...trace, apiId, reason: 'rejected_url' }); continue }
    const startedAt = Date.now()
    let sourceUrl: string | undefined
    try {
      playbackLog('url.source_start', () => ({ ...trace, apiId, musicId: musicInfo.id, quality }))
      const result = await requestUserApiMusicUrl(apiId, musicInfo, quality, registerCancel, allowQualityFallback, trace)
      assertActive()
      assertMusicUrlAvailable(result.url, rejectedUrls)
      sourceUrl = result.url
      // 中转地址可以返回新的 CDN。冷却关联使用脚本返回的地址。
      remember(sourceUrls, key, sourceUrl)
      playbackLog('url.source_resolved', () => ({ ...trace, apiId, url: result.url, quality: result.type, elapsedMs: Date.now() - startedAt }))
      playbackLog('url.validate_start', () => ({ ...trace, apiId, musicSource: musicInfo.source }))
      const url = await prepareMusicUrl(musicInfo, sourceUrl, assertActive, {
        onCancel: registerCancel, isRefresh, trace: { ...trace, apiId }, expectedMusicInfo, validateUrl, rejectedUrls,
      })
      assertActive()
      playbackLog('url.validate_done', { ...trace, apiId })
      failedSources.delete(key)
      return { url, sourceUrl, quality: result.type, musicInfo, isFromCache: false }
    } catch (error) {
      const cooldown = !isAudioProbeFailure(error) && (!sourceUrl || isMusicUrlFailed(sourceUrl))
      playbackLog('url.source_failed', () => ({ ...trace, apiId, error, elapsedMs: Date.now() - startedAt, cancelled: cancelled || isRequestCancelled(error), cooldown: !cancelled && !isRequestCancelled(error) && cooldown }))
      assertActive()
      if (isRequestCancelled(error)) throw error
      if (cooldown) remember(failedSources, key, Date.now() + COOLDOWN)
    }
  }
  assertActive()
  throw new Error(global.i18n.t('toggle_source_failed'))
}
