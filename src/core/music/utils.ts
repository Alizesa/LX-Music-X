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


const getOtherSourcePromises = new Map<string, Promise<LX.Music.MusicInfoOnline[]>>()
export const existTimeExp = /\[\d{1,2}:.*\d{1,4}\]/
const otherSourceCache = new Map<string, LX.Music.MusicInfoOnline[]>()
let otherSourceGeneration = 0

/** 后台/设置页清理：换源结果可重建，直接丢 */
export const clearOtherSourceCache = () => {
  otherSourceGeneration++
  otherSourceCache.clear()
}

export const getOtherSource = async(musicInfo: LX.Music.MusicInfo | LX.Download.ListItem, isRefresh = false): Promise<LX.Music.MusicInfoOnline[]> => {
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
  const pending = getOtherSourcePromises.get(key)
  if (pending) return pending

  const generation = otherSourceGeneration
  const promise = new Promise<LX.Music.MusicInfoOnline[]>((resolve, reject) => {
    let timeout: null | number = BackgroundTimer.setTimeout(() => {
      timeout = null
      reject(new Error('find music timeout'))
    }, 12_000)
    findMusic(searchMusicInfo).then((otherSource) => {
      // 已超时的结果不再转换/缓存，清理后的迟到请求也不能重新填满内存。
      if (timeout === null) return
      const source = otherSource.map(toNewMusicInfo) as LX.Music.MusicInfoOnline[]
      if (generation === otherSourceGeneration) {
        otherSourceCache.delete(key)
        otherSourceCache.set(key, source)
        if (otherSourceCache.size > 10) otherSourceCache.delete(otherSourceCache.keys().next().value!)
      }
      resolve(source)
    }).catch(reject).finally(() => {
      if (timeout !== null) BackgroundTimer.clearTimeout(timeout)
    })
  }).finally(() => {
    if (getOtherSourcePromises.get(key) === promise) getOtherSourcePromises.delete(key)
  })
  getOtherSourcePromises.set(key, promise)
  return promise
}


export const buildLyricInfo = async(lyricInfo: MakeOptional<LX.Player.LyricInfo, 'rawlrcInfo'>): Promise<LX.Player.LyricInfo> => {
  if (!settingState.setting['player.isS2t']) {
    // @ts-expect-error
    if (lyricInfo.rawlrcInfo) return lyricInfo
    return { ...lyricInfo, rawlrcInfo: { ...lyricInfo } }
  }

  if (settingState.setting['player.isS2t']) {
    const tasks = [
      lyricInfo.lyric ? langS2T(lyricInfo.lyric) : Promise.resolve(''),
      lyricInfo.tlyric ? langS2T(lyricInfo.tlyric) : Promise.resolve(''),
      lyricInfo.rlyric ? langS2T(lyricInfo.rlyric) : Promise.resolve(''),
      lyricInfo.lxlyric ? langS2T(lyricInfo.lxlyric) : Promise.resolve(''),
    ]
    if (lyricInfo.rawlrcInfo) {
      tasks.push(lyricInfo.lyric ? langS2T(lyricInfo.lyric) : Promise.resolve(''))
      tasks.push(lyricInfo.tlyric ? langS2T(lyricInfo.tlyric) : Promise.resolve(''))
      tasks.push(lyricInfo.rlyric ? langS2T(lyricInfo.rlyric) : Promise.resolve(''))
      tasks.push(lyricInfo.lxlyric ? langS2T(lyricInfo.lxlyric) : Promise.resolve(''))
    }
    return Promise.all(tasks).then(([lyric, tlyric, rlyric, lxlyric, lyric_raw, tlyric_raw, rlyric_raw, lxlyric_raw]) => {
      const rawlrcInfo = lyric_raw ? {
        lyric: lyric_raw,
        tlyric: tlyric_raw,
        rlyric: rlyric_raw,
        lxlyric: lxlyric_raw,
      } : {
        lyric,
        tlyric,
        rlyric,
        lxlyric,
      }
      return {
        lyric,
        tlyric,
        rlyric,
        lxlyric,
        rawlrcInfo,
      }
    })
  }

  // @ts-expect-error
  return lyricInfo.rawlrcInfo ? lyricInfo : { ...lyricInfo, rawlrcInfo: { ...lyricInfo } }
}

export const isLyricCacheStale = (musicInfo: LX.Music.MusicInfo, lyricInfo: Pick<LX.Player.LyricInfo, 'isEdited' | 'qqLyricVersion'>) =>
  musicInfo.source === 'tx' && !lyricInfo.isEdited && (lyricInfo.qqLyricVersion ?? 0) < QQ_LYRIC_CACHE_VERSION

export const getCachedLyricInfo = async(musicInfo: LX.Music.MusicInfo, allowStale = false): Promise<LX.Player.LyricInfo | null> => {
  let lrcInfo = await getStoreLyric(musicInfo)
  if (lrcInfo.isEdited && existTimeExp.test(lrcInfo.lyric)) return lrcInfo
  if (!allowStale && isLyricCacheStale(musicInfo, lrcInfo)) return null
  // lrcInfo = {}
  if (existTimeExp.test(lrcInfo.lyric) && lrcInfo.tlyric != null) {
    // if (musicInfo.lrc.startsWith('\ufeff[id:$00000000]')) {
    //   let str = musicInfo.lrc.replace('\ufeff[id:$00000000]\n', '')
    //   commit('setLrc', { musicInfo, lyric: str, tlyric: musicInfo.tlrc, lxlyric: musicInfo.tlrc })
    // } else if (musicInfo.lrc.startsWith('[id:$00000000]')) {
    //   let str = musicInfo.lrc.replace('[id:$00000000]\n', '')
    //   commit('setLrc', { musicInfo, lyric: str, tlyric: musicInfo.tlrc, lxlyric: musicInfo.tlrc })
    // }

    // if (lrcInfo.lxlyric == null) {
    //   switch (musicInfo.source) {
    //     case 'kg':
    //     case 'kw':
    //     case 'mg':
    //       break
    //     default:
    //       return lrcInfo
    //   }
    // } else
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
  let cancelled = false
  let cancelRequest: (() => void) | undefined
  options.onCancel?.(() => { cancelled = true; cancelRequest?.() })
  const assertActive = () => { if (cancelled) throw new Error(requestMsg.cancelRequest) }
  assertActive()
  if (!await global.lx.apiInitPromise[0]) throw new Error('source init failed')
  assertActive()

  const quality = options.quality ?? '128k'

  const cachedUrl = await getStoreMusicUrl(musicInfo, quality)
  assertActive()
  if (cachedUrl && !isRefresh && !isMusicUrlFailed(cachedUrl) && !options.rejectedUrls?.has(cachedUrl)) {
    try {
      if (/^https?:\/\//i.test(cachedUrl)) await options.validateUrl?.(cachedUrl)
      assertActive()
      return { url: cachedUrl, quality, isFromCache: true }
    } catch (error) {
      assertActive()
      if (isRequestCancelled(error)) throw error
      markMusicUrlFailed(cachedUrl)
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

  return reqPromise.then(async({ url }: { url: string }) => {
    assertActive()
    if (isMusicUrlFailed(url) || options.rejectedUrls?.has(url)) throw new Error('Audio resource already failed')
    if (/^https?:\/\//i.test(url)) await options.validateUrl?.(url)
    assertActive()
    return { url, quality, isFromCache: false }
  })
}

export const getOnlineOtherSourceLyricByLocal = async(musicInfo: LX.Music.MusicInfoLocal, isRefresh: boolean): Promise<{
  lyricInfo: LX.Music.LyricInfo
  isFromCache: boolean
}> => {
  if (!await global.lx.apiInitPromise[0]) throw new Error('source init failed')

  const lyricInfo = await getCachedLyricInfo(musicInfo)
  if (lyricInfo && !isRefresh) return { lyricInfo, isFromCache: true }

  let reqPromise
  try {
    reqPromise = apis('local').getLyric(toOldMusicInfo(musicInfo)).promise
  } catch (err: any) {
    reqPromise = Promise.reject(err)
  }

  return reqPromise.then((lyricInfo: LX.Music.LyricInfo) => {
    return { lyricInfo, isFromCache: false }
  })
}

export const getOnlineOtherSourcePicByLocal = async(musicInfo: LX.Music.MusicInfoLocal): Promise<{
  url: string
}> => {
  if (!await global.lx.apiInitPromise[0]) throw new Error('source init failed')

  let reqPromise
  try {
    reqPromise = apis('local').getPic(toOldMusicInfo(musicInfo)).promise
  } catch (err: any) {
    reqPromise = Promise.reject(err)
  }

  return reqPromise.then((url: string) => {
    return { url }
  })
}

export const TRY_QUALITYS_LIST = ['flac24bit', 'flac', '320k'] as const
type TryQualityType = typeof TRY_QUALITYS_LIST[number]
export const getPlayQuality = (highQuality: LX.Quality, musicInfo: LX.Music.MusicInfoOnline): LX.Quality => {
  let type: LX.Quality = '128k'
  if (TRY_QUALITYS_LIST.includes(highQuality as TryQualityType)) {
    let list = global.lx.qualityList[musicInfo.source]

    let t = TRY_QUALITYS_LIST
      .slice(TRY_QUALITYS_LIST.indexOf(highQuality as TryQualityType))
      .find(q => musicInfo.meta._qualitys[q] && list?.includes(q))

    if (t) type = t
  }
  return type
}

export const getOnlineOtherSourceMusicUrl = async({ musicInfos, quality, onToggleSource, isRefresh, retryedSource = [], onCancel, validateUrl, rejectedUrls }: {
  musicInfos: LX.Music.MusicInfoOnline[]
  quality?: LX.Quality
  onToggleSource: (musicInfo?: LX.Music.MusicInfoOnline) => void
  isRefresh: boolean
  retryedSource?: LX.OnlineSource[]
  onCancel?: (cancel: () => void) => void
  validateUrl?: ValidateMusicUrl
  rejectedUrls?: ReadonlySet<string>
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

  const cachedUrl = await getStoreMusicUrl(musicInfo, itemQuality)
  assertActive()
  if (cachedUrl && !isRefresh && !isMusicUrlFailed(cachedUrl) && !rejectedUrls?.has(cachedUrl)) {
    try {
      await validateQQMusicUrl(musicInfo, cachedUrl, registerCancel)
      assertActive()
      await validateUrl?.(cachedUrl)
      assertActive()
      return { url: cachedUrl, musicInfo, quality: itemQuality, isFromCache: true }
    } catch (error) {
      assertActive()
      if (isRequestCancelled(error)) throw error
      markMusicUrlFailed(cachedUrl)
    }
  }

  let reqPromise
  try {
    reqPromise = getMusicUrlByPriority({ musicInfo, quality: itemQuality, onCancel: registerCancel, validateUrl, rejectedUrls, allowQualityFallback: quality == null, isRefresh })
  } catch (err: any) {
    reqPromise = Promise.reject(err)
  }
  // retryedSource.includes(musicInfo.source)
  // eslint-disable-next-line @typescript-eslint/promise-function-async
  return reqPromise.then(({ url, quality: actualQuality }: { url: string, quality: LX.Quality }) => {
    assertActive()
    return { musicInfo, url, quality: actualQuality, isFromCache: false }
    // eslint-disable-next-line @typescript-eslint/promise-function-async
  }).catch((err: any) => {
    assertActive()
    // 取消不是失败，不要继续换下一个源
    if (isRequestCancelled(err) || err.message == requestMsg.tooManyRequests) throw err
    console.log(err)
    return getOnlineOtherSourceMusicUrl({ musicInfos, quality, onToggleSource, isRefresh, retryedSource, onCancel: registerCancel, validateUrl, rejectedUrls })
  })
}

/**
 * 获取在线音乐URL
 */
export const handleGetOnlineMusicUrl = async({ musicInfo, quality, onToggleSource, isRefresh, allowToggleSource, urlSourceOrder, onCancel, validateUrl, rejectedUrls }: {
  musicInfo: LX.Music.MusicInfoOnline
  quality?: LX.Quality
  isRefresh: boolean
  allowToggleSource: boolean
  onToggleSource: (musicInfo?: LX.Music.MusicInfoOnline) => void
  onCancel?: (cancel: () => void) => void
  validateUrl?: ValidateMusicUrl
  rejectedUrls?: ReadonlySet<string>
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
    try {
      const byAccount = await getQQMusicUrlByAccount(musicInfo, accountQuality, accountQuality, {
        isRefresh,
        onCancel: registerCancel,
        allowQualityFallback: quality == null,
      })
      assertActive()
      if (!byAccount || (quality != null && byAccount.quality !== quality)) return null
      if (isMusicUrlFailed(byAccount.url) || rejectedUrls?.has(byAccount.url)) return null
      await validateUrl?.(byAccount.url)
      assertActive()
      return { musicInfo, url: byAccount.url, quality: byAccount.quality, isFromCache: false }
    } catch (error) {
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
      })
      assertActive()
      return result
    } catch (err: any) {
      assertActive()
      console.log(err)
      if (isRequestCancelled(err) || !allowToggleSource || err.message == requestMsg.tooManyRequests || !getEnabledMusicSourceIds().length) throw err
      onToggleSource()
      // eslint-disable-next-line @typescript-eslint/promise-function-async
      return getOtherSource(musicInfo).then(otherSource => {
        assertActive()
        // console.log('find otherSource', otherSource.length)
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


export const getOnlineOtherSourcePicUrl = async({ musicInfos, onToggleSource, isRefresh, retryedSource = [] }: {
  musicInfos: LX.Music.MusicInfoOnline[]
  onToggleSource: (musicInfo?: LX.Music.MusicInfoOnline) => void
  isRefresh: boolean
  retryedSource?: LX.OnlineSource[]
}): Promise<{
  url: string
  musicInfo: LX.Music.MusicInfoOnline
  isFromCache: boolean
}> => {
  let musicInfo: LX.Music.MusicInfoOnline | null = null
  // eslint-disable-next-line no-cond-assign
  while (musicInfo = (musicInfos.shift()!)) {
    if (retryedSource.includes(musicInfo.source)) continue
    retryedSource.push(musicInfo.source)
    // if (!assertApiSupport(musicInfo.source)) continue
    console.log('try toggle to: ', musicInfo.source, musicInfo.name, musicInfo.singer, musicInfo.interval)
    onToggleSource(musicInfo)
    break
  }
  if (!musicInfo) throw new Error(global.i18n.t('toggle_source_failed'))

  if (musicInfo.meta.picUrl && !isRefresh) return { musicInfo, url: musicInfo.meta.picUrl, isFromCache: true }

  let reqPromise
  try {
    reqPromise = musicSdk[musicInfo.source].getPic(toOldMusicInfo(musicInfo))
  } catch (err: any) {
    reqPromise = Promise.reject(err)
  }
  // retryedSource.includes(musicInfo.source)
  return reqPromise.then((url: string) => {
    return { musicInfo, url, isFromCache: false }
    // eslint-disable-next-line @typescript-eslint/promise-function-async
  }).catch((err: any) => {
    console.log(err)
    return getOnlineOtherSourcePicUrl({ musicInfos, onToggleSource, isRefresh, retryedSource })
  })
}

/**
 * 获取在线歌曲封面
 */
export const handleGetOnlinePicUrl = async({ musicInfo, isRefresh, onToggleSource, allowToggleSource }: {
  musicInfo: LX.Music.MusicInfoOnline
  onToggleSource: (musicInfo?: LX.Music.MusicInfoOnline) => void
  isRefresh: boolean
  allowToggleSource: boolean
}): Promise<{
  url: string
  musicInfo: LX.Music.MusicInfoOnline
  isFromCache: boolean
}> => {
  // console.log(musicInfo.source)
  let reqPromise
  try {
    reqPromise = musicSdk[musicInfo.source].getPic(toOldMusicInfo(musicInfo))
  } catch (err) {
    reqPromise = Promise.reject(err)
  }
  return reqPromise.then((url: string) => {
    return { musicInfo, url, isFromCache: false }
  }).catch(async(err: any) => {
    console.log(err)
    if (!allowToggleSource) throw err
    onToggleSource()
    // eslint-disable-next-line @typescript-eslint/promise-function-async
    return getOtherSource(musicInfo).then(otherSource => {
      // console.log('find otherSource', otherSource.length)
      if (otherSource.length) {
        return getOnlineOtherSourcePicUrl({
          musicInfos: [...otherSource],
          onToggleSource,
          isRefresh,
          retryedSource: [musicInfo.source],
        })
      }
      throw err
    })
  })
}


export const getOnlineOtherSourceLyricInfo = async({ musicInfos, onToggleSource, isRefresh, retryedSource = [] }: {
  musicInfos: LX.Music.MusicInfoOnline[]
  onToggleSource: (musicInfo?: LX.Music.MusicInfoOnline) => void
  isRefresh: boolean
  retryedSource?: LX.OnlineSource[]
}): Promise<{
  lyricInfo: LX.Music.LyricInfo | LX.Player.LyricInfo
  musicInfo: LX.Music.MusicInfoOnline
  isFromCache: boolean
}> => {
  let musicInfo: LX.Music.MusicInfoOnline | null = null
  // eslint-disable-next-line no-cond-assign
  while (musicInfo = (musicInfos.shift()!)) {
    if (retryedSource.includes(musicInfo.source)) continue
    retryedSource.push(musicInfo.source)
    // if (!assertApiSupport(musicInfo.source)) continue
    console.log('try toggle to: ', musicInfo.source, musicInfo.name, musicInfo.singer, musicInfo.interval)
    onToggleSource(musicInfo)
    break
  }
  if (!musicInfo) throw new Error(global.i18n.t('toggle_source_failed'))

  if (!isRefresh) {
    const lyricInfo = await getCachedLyricInfo(musicInfo)
    if (lyricInfo) return { musicInfo, lyricInfo, isFromCache: true }
  }

  let reqPromise
  try {
    // TODO: remove any type
    reqPromise = musicSdk[musicInfo.source].getLyric(toOldMusicInfo(musicInfo)).promise
  } catch (err: any) {
    reqPromise = Promise.reject(err)
  }
  // retryedSource.includes(musicInfo.source)
  return reqPromise.then(async(lyricInfo: LX.Music.LyricInfo) => {
    return existTimeExp.test(lyricInfo.lyric) ? {
      lyricInfo,
      musicInfo,
      isFromCache: false,
    } : Promise.reject(new Error('failed'))
    // eslint-disable-next-line @typescript-eslint/promise-function-async
  }).catch((err: any) => {
    console.log(err)
    return getOnlineOtherSourceLyricInfo({ musicInfos, onToggleSource, isRefresh, retryedSource })
  })
}

/**
 * 获取在线歌词信息
 */
export const handleGetOnlineLyricInfo = async({ musicInfo, onToggleSource, isRefresh, allowToggleSource }: {
  musicInfo: LX.Music.MusicInfoOnline
  onToggleSource: (musicInfo?: LX.Music.MusicInfoOnline) => void
  isRefresh: boolean
  allowToggleSource: boolean
}): Promise<{
  musicInfo: LX.Music.MusicInfoOnline
  lyricInfo: LX.Music.LyricInfo | LX.Player.LyricInfo
  isFromCache: boolean
}> => {
  // console.log(musicInfo.source)
  let reqPromise
  try {
    // TODO: remove any type
    reqPromise = musicSdk[musicInfo.source].getLyric(toOldMusicInfo(musicInfo)).promise
  } catch (err) {
    reqPromise = Promise.reject(err)
  }
  return reqPromise.then(async(lyricInfo: LX.Music.LyricInfo) => {
    return existTimeExp.test(lyricInfo.lyric) ? {
      musicInfo,
      lyricInfo,
      isFromCache: false,
    } : Promise.reject(new Error('failed'))
  }).catch(async(err: any) => {
    console.log(err)
    if (!allowToggleSource) throw err

    onToggleSource()
    // eslint-disable-next-line @typescript-eslint/promise-function-async
    return getOtherSource(musicInfo).then(otherSource => {
      // console.log('find otherSource', otherSource.length)
      if (otherSource.length) {
        return getOnlineOtherSourceLyricInfo({
          musicInfos: [...otherSource],
          onToggleSource,
          isRefresh,
          retryedSource: [musicInfo.source],
        })
      }
      throw err
    })
  })
}
