import musicSdk, { findMusic } from '@/utils/musicSdk'
import {
  // getOtherSource as getOtherSourceFromStore,
  // saveOtherSource as saveOtherSourceFromStore,
  getMusicUrl as getStoreMusicUrl,
  getPlayerLyric as getStoreLyric,
} from '@/utils/data'
import { langS2T, toNewMusicInfo, toOldMusicInfo } from '@/utils'
import settingState from '@/store/setting/state'
import { isRequestCancelled, requestMsg } from '@/utils/message'
import BackgroundTimer from 'react-native-background-timer'
import { apis } from '@/utils/musicSdk/api-source'
import { getQQMusicUrlByAccount, validateQQMusicUrl } from '@/core/qqMusicUrl'
import { QQ_LYRIC_CACHE_VERSION } from '@/config/constant'
import { getEnabledMusicSourceIds, getMusicUrlByPriority, isMusicUrlFailed, markMusicUrlFailed, type MusicUrlRequestOptions, type ValidateMusicUrl } from './sourcePriority'
import { getMusicUrlCacheContext } from '@/utils/musicUrlCache'
import { playbackLog, type PlaybackLogContext } from '@/utils/playbackLog'
import { waitForPromise } from '@/utils/abortable'
import { throwIfAborted, withAbort } from '@/utils/abort'
import { withRequestSignal } from '@/utils/musicSdk/requestScope'

interface MatchingTask {
  promise: Promise<LX.Music.MusicInfoOnline[]>
  controller: AbortController
  consumers: number
  finished: boolean
  cancel: () => void
}
const getOtherSourcePromises = new Map<string, MatchingTask>()
export const existTimeExp = /\[\d{1,2}:.*\d{1,4}\]/
const otherSourceCache = new Map<string, LX.Music.MusicInfoOnline[]>()
let otherSourceGeneration = 0
const getSourceSdk = (source: LX.OnlineSource) => {
  const sdk = musicSdk[source]
  if (!sdk) throw new Error('Unsupported music source')
  return sdk
}

/** 后台/设置页清理：换源结果可重建，直接丢 */
export const clearOtherSourceCache = () => {
  otherSourceGeneration++
  otherSourceCache.clear()
}

// 仅让底层任务保留匹配字段，不能留住调用方整份歌曲/下载上下文。
const createMatchingTask = (key: string, searchMusicInfo: Parameters<typeof findMusic>[0]): MatchingTask => {
  const generation = otherSourceGeneration
  const pending: MatchingTask = { controller: new AbortController(), consumers: 0, finished: false, cancel: () => {}, promise: Promise.resolve([]) }
  let timeout: null | number = null
  let resolveTask!: (source: LX.Music.MusicInfoOnline[]) => void
  let rejectTask!: (error: unknown) => void
  const finish = () => {
    if (pending.finished) return
    pending.finished = true
    pending.cancel = () => {}
    resolveTask = () => {}
    rejectTask = () => {}
    if (timeout !== null) BackgroundTimer.clearTimeout(timeout)
    timeout = null
    if (getOtherSourcePromises.get(key) === pending) getOtherSourcePromises.delete(key)
  }
  pending.promise = new Promise<LX.Music.MusicInfoOnline[]>((resolve, reject) => {
    resolveTask = resolve
    rejectTask = reject
  }).finally(finish)
  pending.cancel = () => {
    const reject = rejectTask
    finish()
    reject(new Error(requestMsg.cancelRequest))
    pending.controller.abort()
  }
  timeout = BackgroundTimer.setTimeout(() => {
    const reject = rejectTask
    finish()
    reject(new Error('find music timeout'))
    pending.controller.abort()
  }, 12_000)
  // 注册完整任务后才调用 SDK；取消/HTTP abort 回调中的重入不能拿到占位 Promise。
  getOtherSourcePromises.set(key, pending)
  try {
    void findMusic(searchMusicInfo, pending.controller.signal).then((otherSource) => {
      if (pending.finished || pending.controller.signal.aborted) return
      const source = otherSource.map(toNewMusicInfo) as LX.Music.MusicInfoOnline[]
      if (generation === otherSourceGeneration) {
        otherSourceCache.delete(key)
        otherSourceCache.set(key, source)
        if (otherSourceCache.size > 10) otherSourceCache.delete(otherSourceCache.keys().next().value!)
      }
      resolveTask(source)
    }).catch(error => { rejectTask(error) })
  } catch (error) {
    rejectTask(error)
  }
  return pending
}

export const getOtherSource = async(musicInfo: LX.Music.MusicInfo | LX.Download.ListItem, isRefresh = false, signal?: AbortSignal): Promise<LX.Music.MusicInfoOnline[]> => {
  throwIfAborted(signal)
  const music = 'progress' in musicInfo ? musicInfo.metadata.musicInfo : musicInfo
  const searchMusicInfo = {
    name: music.name,
    singer: music.singer,
    source: music.source,
    albumName: music.meta.albumName,
    interval: music.interval ?? '',
  }
  // 同一首歌在队列、历史和下载里可能是不同对象，按匹配条件共享结果。
  const key = JSON.stringify([music.id, searchMusicInfo])
  const cached = otherSourceCache.get(key)
  if (!isRefresh && cached) {
    otherSourceCache.delete(key)
    otherSourceCache.set(key, cached)
    return cached
  }
  let task = getOtherSourcePromises.get(key)
  if (!task || task.finished || task.controller.signal.aborted) task = createMatchingTask(key, searchMusicInfo)
  task.consumers++
  try {
    return await waitForPromise(task.promise, signal)
  } finally {
    if (--task.consumers === 0 && !task.finished) task.cancel()
  }
}

export const buildLyricInfo = async(lyricInfo: MakeOptional<LX.Player.LyricInfo, 'rawlrcInfo'>, signal?: AbortSignal): Promise<LX.Player.LyricInfo> => {
  throwIfAborted(signal)
  const {
    rawlrcInfo = {
      lyric: lyricInfo.lyric,
      tlyric: lyricInfo.tlyric,
      rlyric: lyricInfo.rlyric,
      lxlyric: lyricInfo.lxlyric,
    },
  } = lyricInfo
  if (!settingState.setting['player.isS2t']) {
    return { ...lyricInfo, rawlrcInfo }
  }
  const converted: string[] = []
  for (const text of [lyricInfo.lyric, lyricInfo.tlyric, lyricInfo.rlyric, lyricInfo.lxlyric]) {
    throwIfAborted(signal)
    converted.push(text ? await waitForPromise(Promise.resolve(langS2T(text)), signal) : '')
  }
  const [lyric, tlyric, rlyric, lxlyric] = converted
  return { ...lyricInfo, lyric, tlyric, rlyric, lxlyric, rawlrcInfo }
}

export const isLyricCacheStale = (musicInfo: LX.Music.MusicInfo, lyricInfo: Pick<LX.Player.LyricInfo, 'isEdited' | 'qqLyricVersion'>) =>
  musicInfo.source === 'tx' && !lyricInfo.isEdited && (lyricInfo.qqLyricVersion ?? 0) < QQ_LYRIC_CACHE_VERSION

export const getCachedLyricInfo = async(musicInfo: LX.Music.MusicInfo, allowStale = false, signal?: AbortSignal): Promise<LX.Player.LyricInfo | null> => {
  const lrcInfo = await waitForPromise(getStoreLyric(musicInfo), signal)
  if (lrcInfo.isEdited && existTimeExp.test(lrcInfo.lyric)) return lrcInfo
  if (!allowStale && isLyricCacheStale(musicInfo, lrcInfo)) return null
  // lrcInfo = {}
  if (existTimeExp.test(lrcInfo.lyric) && lrcInfo.tlyric != null) {
    if (lrcInfo.rlyric == null) {
      if (!['wy', 'kg'].includes(musicInfo.source)) return lrcInfo
    } else return lrcInfo
  }
  return null
}

export const getOnlineOtherSourceMusicUrlByLocal = async(musicInfo: LX.Music.MusicInfoLocal, isRefresh: boolean, options: MusicUrlRequestOptions = {}): Promise<{
  url: string
  quality: LX.Quality
  isFromCache: boolean
}> => {
  const cacheContext = options.cacheContext ?? getMusicUrlCacheContext(settingState.setting, options.urlSourceOrder)
  playbackLog('url.local_source_wait', () => ({ ...options.trace, musicId: musicInfo.id }))
  let cancelled = false
  const controller = new AbortController()
  let cancelRequest: (() => void) | undefined
  options.onCancel?.(() => { cancelled = true; controller.abort(); cancelRequest?.() })
  const assertActive = () => { if (cancelled) throw new Error(requestMsg.cancelRequest) }
  assertActive()
  if (!await waitForPromise(global.lx.apiInitPromise[0], controller.signal)) throw new Error('source init failed')
  assertActive()

  const quality = options.quality ?? '128k'

  const cachedUrl = await waitForPromise(getStoreMusicUrl(musicInfo, quality, cacheContext), controller.signal)
  assertActive()
  if (cachedUrl && !isRefresh && !isMusicUrlFailed(cachedUrl) && !options.rejectedUrls?.has(cachedUrl)) {
    try {
      if (/^https?:\/\//i.test(cachedUrl)) await options.validateUrl?.(cachedUrl)
      assertActive()
      return { url: cachedUrl, quality, isFromCache: true }
    } catch (error) {
      assertActive()
      if (isRequestCancelled(error)) throw error
      markMusicUrlFailed(cachedUrl, error)
    }
  }

  let reqPromise
  try {
    const request = apis('local').getMusicUrl(toOldMusicInfo(musicInfo), options.quality ?? null)
    const cancel = request.canceleFn ?? request.cancelHttp
    if (typeof cancel == 'function') cancelRequest = cancel as () => void
    reqPromise = request.promise
  } catch (err: any) {
    reqPromise = Promise.reject(err)
  }

  return waitForPromise(reqPromise as Promise<{ url: string }>, controller.signal).then(async({ url }) => {
    assertActive()
    if (isMusicUrlFailed(url) || options.rejectedUrls?.has(url)) throw new Error('Audio resource already failed')
    if (/^https?:\/\//i.test(url)) await options.validateUrl?.(url)
    assertActive()
    return { url, quality, isFromCache: false }
  })
}

export const getOnlineOtherSourceLyricByLocal = async(musicInfo: LX.Music.MusicInfoLocal, isRefresh: boolean, signal?: AbortSignal): Promise<{
  lyricInfo: LX.Music.LyricInfo
  isFromCache: boolean
}> => {
  if (!await waitForPromise(global.lx.apiInitPromise[0], signal)) throw new Error('source init failed')

  const lyricInfo = await waitForPromise(getCachedLyricInfo(musicInfo, false, signal), signal)
  if (lyricInfo && !isRefresh) return { lyricInfo, isFromCache: true }

  let reqPromise
  try {
    const request = apis('local').getLyric(toOldMusicInfo(musicInfo)) as { promise: Promise<LX.Music.LyricInfo>, canceleFn?: () => void, cancelHttp?: () => void }
    reqPromise = withAbort(request.promise, signal, () => {
      if (request.canceleFn) request.canceleFn()
      else request.cancelHttp?.()
    })
  } catch (err: any) {
    reqPromise = Promise.reject(err)
  }

  return waitForPromise(reqPromise, signal).then((lyricInfo) => {
    return { lyricInfo, isFromCache: false }
  })
}

export const getOnlineOtherSourcePicByLocal = async(musicInfo: LX.Music.MusicInfoLocal, signal?: AbortSignal): Promise<{
  url: string
}> => {
  if (!await waitForPromise(global.lx.apiInitPromise[0], signal)) throw new Error('source init failed')

  let reqPromise
  try {
    const request = apis('local').getPic(toOldMusicInfo(musicInfo)) as { promise: Promise<string>, canceleFn?: () => void, cancelHttp?: () => void }
    reqPromise = withAbort(request.promise, signal, () => {
      if (request.canceleFn) request.canceleFn()
      else request.cancelHttp?.()
    })
  } catch (err: any) {
    reqPromise = Promise.reject(err)
  }

  return waitForPromise(reqPromise, signal).then((url) => {
    return { url }
  })
}

export const TRY_QUALITYS_LIST = ['flac24bit', 'flac', '320k'] as const
type TryQualityType = typeof TRY_QUALITYS_LIST[number]
// 歌曲信息决定用户可请求的上限；账号与每个脚本各自协商降档，不受主脚本能力限制。
export const getPlayQuality = (highQuality: LX.Quality, musicInfo: LX.Music.MusicInfoOnline): LX.Quality => {
  let type: LX.Quality = '128k'
  if (TRY_QUALITYS_LIST.includes(highQuality as TryQualityType)) {
    let t = TRY_QUALITYS_LIST
      .slice(TRY_QUALITYS_LIST.indexOf(highQuality as TryQualityType))
      .find(q => musicInfo.meta._qualitys[q])

    if (t) type = t
  }
  return type
}

export const getOnlineOtherSourceMusicUrl = async({ musicInfos, quality, onToggleSource, isRefresh, retryedSource = [], onCancel, validateUrl, rejectedUrls, cacheContext = getMusicUrlCacheContext(settingState.setting), trace }: {
  musicInfos: LX.Music.MusicInfoOnline[]
  quality?: LX.Quality
  onToggleSource: (musicInfo?: LX.Music.MusicInfoOnline) => void
  isRefresh: boolean
  retryedSource?: LX.OnlineSource[]
  onCancel?: (cancel: () => void) => void
  validateUrl?: ValidateMusicUrl
  rejectedUrls?: ReadonlySet<string>
  cacheContext?: string
  trace?: PlaybackLogContext
}): Promise<{
  url: string
  musicInfo: LX.Music.MusicInfoOnline
  quality: LX.Quality
  isFromCache: boolean
}> => {
  let cancelled = false
  let currentCancel: (() => void) | undefined
  onCancel?.(() => { cancelled = true; currentCancel?.() })
  const assertActive = () => { if (cancelled) throw new Error(requestMsg.cancelRequest) }
  const registerCancel = (cancel: () => void) => {
    currentCancel = cancel
    if (cancelled) cancel()
  }
  assertActive()
  let musicInfo: LX.Music.MusicInfoOnline | null = null
  let itemQuality: LX.Quality | null = null
  // eslint-disable-next-line no-cond-assign
  while (musicInfo = (musicInfos.shift()!)) {
    if (retryedSource.includes(musicInfo.source)) continue
    retryedSource.push(musicInfo.source)
    itemQuality = quality ?? settingState.setting['player.playQuality']

    console.log('try toggle to: ', musicInfo.source, musicInfo.name, musicInfo.singer, musicInfo.interval)
    onToggleSource(musicInfo)
    break
  }
  if (!musicInfo || !itemQuality) throw new Error(global.i18n.t('toggle_source_failed'))
  playbackLog('url.alternate', () => ({ ...trace, musicId: musicInfo.id, source: musicInfo.source, quality: itemQuality }))

  const cachedUrl = await getStoreMusicUrl(musicInfo, itemQuality, cacheContext)
  assertActive()
  if (cachedUrl && !isRefresh && !isMusicUrlFailed(cachedUrl) && !rejectedUrls?.has(cachedUrl)) {
    try {
      await validateQQMusicUrl(musicInfo, cachedUrl, registerCancel, false, trace)
      assertActive()
      await validateUrl?.(cachedUrl)
      assertActive()
      return { url: cachedUrl, musicInfo, quality: itemQuality, isFromCache: true }
    } catch (error) {
      assertActive()
      if (isRequestCancelled(error)) throw error
      markMusicUrlFailed(cachedUrl, error)
    }
  }

  let reqPromise
  try {
    reqPromise = getMusicUrlByPriority({ musicInfo, quality: itemQuality, onCancel: registerCancel, validateUrl, rejectedUrls, allowQualityFallback: quality == null, isRefresh, trace })
  } catch (err: any) {
    reqPromise = Promise.reject(err)
  }
  return reqPromise.then(({ url, quality: actualQuality }: { url: string, quality: LX.Quality }) => {
    assertActive()
    return { musicInfo, url, quality: actualQuality, isFromCache: false }
    // eslint-disable-next-line @typescript-eslint/promise-function-async
  }).catch((err: any) => {
    assertActive()
    // 取消不是失败，不要继续换下一个源
    if (isRequestCancelled(err) || err.message == requestMsg.tooManyRequests) throw err
    console.log(err)
    return getOnlineOtherSourceMusicUrl({ musicInfos, quality, onToggleSource, isRefresh, retryedSource, onCancel: registerCancel, validateUrl, rejectedUrls, cacheContext, trace })
  })
}

/**
 * 获取在线音乐URL
 */
export const handleGetOnlineMusicUrl = async({ musicInfo, quality, onToggleSource, isRefresh, allowToggleSource, urlSourceOrder, onCancel, validateUrl, rejectedUrls, cacheContext = getMusicUrlCacheContext(settingState.setting, urlSourceOrder), trace }: {
  musicInfo: LX.Music.MusicInfoOnline
  quality?: LX.Quality
  isRefresh: boolean
  allowToggleSource: boolean
  onToggleSource: (musicInfo?: LX.Music.MusicInfoOnline) => void
  onCancel?: (cancel: () => void) => void
  validateUrl?: ValidateMusicUrl
  rejectedUrls?: ReadonlySet<string>
  cacheContext?: string
  trace?: PlaybackLogContext
  /**
   * 两条链的先后：
   * - 'accountFirst' 账号优先，拿不到再走音源（播放的默认）
   * - 'sourceFirst' 音源优先，拿不到再回落账号（播放设置里选了「音源」）
   * - 'sourceOnly' 只走音源，不回落账号（下载设置里选了「音源」）
   * 不传就按播放设置 player.urlSource 来
   */
  urlSourceOrder?: LX.Music.UrlSourceOrder
}): Promise<{
  url: string
  musicInfo: LX.Music.MusicInfoOnline
  quality: LX.Quality
  isFromCache: boolean
}> => {
  const targetQuality = quality ?? getPlayQuality(settingState.setting['player.playQuality'], musicInfo)
  // 播放时，没开会员的账号只按标准音质取链（设置里那一项就是给这种情况用的），
  // 不再逐档往下试无损/320k —— 每试一档就是一次 vkey 请求，非会员账号那些尝试注定落空。
  // 开了会员（或没开这个设置）时按 targetQuality 走：上限就是用户选的那一档，不越过它往上试。
  // 下载显式传入 quality，必须保留指定音质，拿不到时尝试后续音源。
  const accountQuality = quality ?? (settingState.setting['player.noVipStandardQuality'] ? '128k' : targetQuality)
  const order = urlSourceOrder ?? (settingState.setting['player.urlSource'] === 'source' ? 'sourceFirst' : 'accountFirst')
  playbackLog('url.strategy', () => ({ ...trace, musicId: musicInfo.id, order, targetQuality, accountQuality }))
  // 对外只注册一次取消句柄，账号结束到音源初始化之间也不能丢失取消状态。
  let cancelled = false
  let currentCancel: (() => void) | undefined
  const assertActive = () => {
    if (cancelled) throw new Error(requestMsg.cancelRequest)
  }
  const registerCancel = (cancel: () => void) => {
    currentCancel = cancel
    if (cancelled) cancel()
  }
  onCancel?.(() => {
    cancelled = true
    currentCancel?.()
  })
  assertActive()

  // QQ 账号直取：App 和网页通道都拿不到完整音频，才回落音源。
  // 是否完整由取链层验证，不能根据 VIP 标签或 URL 参数推断。
  const byAccountUrl = async() => {
    if (musicInfo.source != 'tx') return null
    const startedAt = Date.now()
    playbackLog('url.account_start', () => ({ ...trace, quality: accountQuality }))
    try {
      const byAccount = await getQQMusicUrlByAccount(musicInfo, accountQuality, accountQuality, {
        isRefresh,
        onCancel: registerCancel,
        allowQualityFallback: quality == null,
        isUrlRejected: url => isMusicUrlFailed(url) || rejectedUrls?.has(url) === true,
        trace,
      })
      assertActive()
      playbackLog('url.account_result', () => ({ ...trace, available: !!byAccount, quality: byAccount?.quality, elapsedMs: Date.now() - startedAt }))
      if (!byAccount || (quality != null && byAccount.quality !== quality)) return null
      if (isMusicUrlFailed(byAccount.url) || rejectedUrls?.has(byAccount.url)) return null
      await validateUrl?.(byAccount.url)
      assertActive()
      return { musicInfo, url: byAccount.url, quality: byAccount.quality, isFromCache: false }
    } catch (error) {
      playbackLog('url.account_failed', () => ({ ...trace, error, elapsedMs: Date.now() - startedAt }))
      assertActive()
      if (isRequestCancelled(error)) throw error
      console.log('[QQMusic] 账号取链失败:', error)
      return null
    }
  }

  // 脚本按用户勾选顺序尝试，运行环境各自等待初始化完成。
  const bySourceUrl = async() => {
    assertActive()
    try {
      const result = await getMusicUrlByPriority({
        musicInfo,
        quality: quality ?? settingState.setting['player.playQuality'],
        isRefresh,
        allowQualityFallback: quality == null,
        onCancel: registerCancel,
        validateUrl,
        rejectedUrls,
        trace,
      })
      assertActive()
      return result
    } catch (err: any) {
      assertActive()
      console.log(err)
      if (isRequestCancelled(err) || !allowToggleSource || err.message == requestMsg.tooManyRequests || !getEnabledMusicSourceIds().length) throw err
      onToggleSource()
      playbackLog('url.match_start', () => ({ ...trace, musicId: musicInfo.id }))
      const matching = new AbortController()
      registerCancel(() => { matching.abort() })
      // eslint-disable-next-line @typescript-eslint/promise-function-async
      return getOtherSource(musicInfo, false, matching.signal).then(otherSource => {
        assertActive()
        playbackLog('url.match_result', () => ({ ...trace, count: otherSource.length }))
        if (otherSource.length) {
          return getOnlineOtherSourceMusicUrl({
            musicInfos: [...otherSource],
            onToggleSource,
            quality,
            isRefresh,
            retryedSource: [musicInfo.source],
            onCancel: registerCancel,
            validateUrl,
            rejectedUrls,
            cacheContext,
            trace,
          })
        }
        throw err
      })
    }
  }

  if (order === 'accountFirst') {
    const byAccount = await byAccountUrl()
    if (byAccount) return byAccount
    return bySourceUrl()
  }

  try {
    return await bySourceUrl()
  } catch (error) {
    // 用户已取消整次取链，不能再把取消当作音源失败去请求账号链接
    if (isRequestCancelled(error)) throw error
    // 音源优先时它拿不到才回落账号，别让播放直接失败（下载的 'sourceOnly' 不走这一步）
    if (order === 'sourceFirst') {
      const byAccount = await byAccountUrl()
      if (byAccount) return byAccount
    }
    throw error
  }
}

export const getOnlineOtherSourcePicUrl = async({ musicInfos, onToggleSource, isRefresh, retryedSource = [], signal }: {
  musicInfos: LX.Music.MusicInfoOnline[]
  onToggleSource: (musicInfo?: LX.Music.MusicInfoOnline) => void
  isRefresh: boolean
  retryedSource?: LX.OnlineSource[]
  signal?: AbortSignal
}): Promise<{
  url: string
  musicInfo: LX.Music.MusicInfoOnline
  isFromCache: boolean
}> => {
  throwIfAborted(signal)
  let musicInfo: LX.Music.MusicInfoOnline | null = null
  // eslint-disable-next-line no-cond-assign
  while (musicInfo = (musicInfos.shift()!)) {
    if (retryedSource.includes(musicInfo.source)) continue
    retryedSource.push(musicInfo.source)
    console.log('try toggle to: ', musicInfo.source, musicInfo.name, musicInfo.singer, musicInfo.interval)
    onToggleSource(musicInfo)
    break
  }
  if (!musicInfo) throw new Error(global.i18n.t('toggle_source_failed'))

  if (musicInfo.meta.picUrl && !isRefresh) return { musicInfo, url: musicInfo.meta.picUrl, isFromCache: true }

  let reqPromise
  try {
    reqPromise = withRequestSignal(getSourceSdk(musicInfo.source), signal).getPic(toOldMusicInfo(musicInfo))
  } catch (err: any) {
    reqPromise = Promise.reject(err)
  }
  return waitForPromise(reqPromise as Promise<string>, signal).then((url: string) => {
    return { musicInfo, url, isFromCache: false }
    // eslint-disable-next-line @typescript-eslint/promise-function-async
  }).catch((err: any) => {
    console.log(err)
    throwIfAborted(signal)
    return getOnlineOtherSourcePicUrl({ musicInfos, onToggleSource, isRefresh, retryedSource, signal })
  })
}

/**
 * 获取在线歌曲封面
 */
export const handleGetOnlinePicUrl = async({ musicInfo, isRefresh, onToggleSource, allowToggleSource, signal }: {
  musicInfo: LX.Music.MusicInfoOnline
  onToggleSource: (musicInfo?: LX.Music.MusicInfoOnline) => void
  isRefresh: boolean
  allowToggleSource: boolean
  signal?: AbortSignal
}): Promise<{
  url: string
  musicInfo: LX.Music.MusicInfoOnline
  isFromCache: boolean
}> => {
  throwIfAborted(signal)
  let reqPromise
  try {
    reqPromise = withRequestSignal(getSourceSdk(musicInfo.source), signal).getPic(toOldMusicInfo(musicInfo))
  } catch (err) {
    reqPromise = Promise.reject(err)
  }
  return waitForPromise(reqPromise as Promise<string>, signal).then((url: string) => {
    return { musicInfo, url, isFromCache: false }
  }).catch(async(err: any) => {
    throwIfAborted(signal)
    console.log(err)
    if (!allowToggleSource) throw err
    onToggleSource()
    // eslint-disable-next-line @typescript-eslint/promise-function-async
    return getOtherSource(musicInfo, false, signal).then(otherSource => {
      if (otherSource.length) {
        return getOnlineOtherSourcePicUrl({
          musicInfos: [...otherSource],
          onToggleSource,
          isRefresh,
          retryedSource: [musicInfo.source],
          signal,
        })
      }
      throw err
    })
  })
}

export const getOnlineOtherSourceLyricInfo = async({ musicInfos, onToggleSource, isRefresh, retryedSource = [], signal }: {
  musicInfos: LX.Music.MusicInfoOnline[]
  onToggleSource: (musicInfo?: LX.Music.MusicInfoOnline) => void
  isRefresh: boolean
  retryedSource?: LX.OnlineSource[]
  signal?: AbortSignal
}): Promise<{
  lyricInfo: LX.Music.LyricInfo | LX.Player.LyricInfo
  musicInfo: LX.Music.MusicInfoOnline
  isFromCache: boolean
}> => {
  throwIfAborted(signal)
  let musicInfo: LX.Music.MusicInfoOnline | null = null
  // eslint-disable-next-line no-cond-assign
  while (musicInfo = (musicInfos.shift()!)) {
    if (retryedSource.includes(musicInfo.source)) continue
    retryedSource.push(musicInfo.source)
    console.log('try toggle to: ', musicInfo.source, musicInfo.name, musicInfo.singer, musicInfo.interval)
    onToggleSource(musicInfo)
    break
  }
  if (!musicInfo) throw new Error(global.i18n.t('toggle_source_failed'))

  if (!isRefresh) {
    const lyricInfo = await waitForPromise(getCachedLyricInfo(musicInfo, false, signal), signal)
    if (lyricInfo) return { musicInfo, lyricInfo, isFromCache: true }
  }

  let reqPromise
  try {
    // TODO: remove any type
    const request = withRequestSignal(getSourceSdk(musicInfo.source), signal).getLyric(toOldMusicInfo(musicInfo))
    reqPromise = withAbort(request.promise as Promise<LX.Music.LyricInfo>, signal, () => { request.cancelHttp?.() })
  } catch (err: any) {
    reqPromise = Promise.reject(err)
  }
  return waitForPromise(reqPromise, signal).then(async(lyricInfo: LX.Music.LyricInfo) => {
    return existTimeExp.test(lyricInfo.lyric) ? {
      lyricInfo,
      musicInfo,
      isFromCache: false,
    } : Promise.reject(new Error('failed'))
    // eslint-disable-next-line @typescript-eslint/promise-function-async
  }).catch((err: any) => {
    console.log(err)
    throwIfAborted(signal)
    return getOnlineOtherSourceLyricInfo({ musicInfos, onToggleSource, isRefresh, retryedSource, signal })
  })
}

/**
 * 获取在线歌词信息
 */
export const handleGetOnlineLyricInfo = async({ musicInfo, onToggleSource, isRefresh, allowToggleSource, signal }: {
  musicInfo: LX.Music.MusicInfoOnline
  onToggleSource: (musicInfo?: LX.Music.MusicInfoOnline) => void
  isRefresh: boolean
  allowToggleSource: boolean
  signal?: AbortSignal
}): Promise<{
  musicInfo: LX.Music.MusicInfoOnline
  lyricInfo: LX.Music.LyricInfo | LX.Player.LyricInfo
  isFromCache: boolean
}> => {
  throwIfAborted(signal)
  let reqPromise
  try {
    // TODO: remove any type
    const request = withRequestSignal(getSourceSdk(musicInfo.source), signal).getLyric(toOldMusicInfo(musicInfo))
    reqPromise = withAbort(request.promise as Promise<LX.Music.LyricInfo>, signal, () => { request.cancelHttp?.() })
  } catch (err) {
    reqPromise = Promise.reject(err)
  }
  return waitForPromise(reqPromise, signal).then(async(lyricInfo: LX.Music.LyricInfo) => {
    return existTimeExp.test(lyricInfo.lyric) ? {
      musicInfo,
      lyricInfo,
      isFromCache: false,
    } : Promise.reject(new Error('failed'))
  }).catch(async(err: any) => {
    throwIfAborted(signal)
    console.log(err)
    if (!allowToggleSource) throw err

    onToggleSource()
    // eslint-disable-next-line @typescript-eslint/promise-function-async
    return getOtherSource(musicInfo, false, signal).then(otherSource => {
      if (otherSource.length) {
        return getOnlineOtherSourceLyricInfo({
          musicInfos: [...otherSource],
          onToggleSource,
          isRefresh,
          retryedSource: [musicInfo.source],
          signal,
        })
      }
      throw err
    })
  })
}
