import {
  saveLyric,
  saveMusicUrl,
  getMusicUrl as getStoreMusicUrl,
} from '@/utils/data'
import { updateListMusics } from '@/core/list'
import settingState from '@/store/setting/state'
import { isMusicUrlFailed, markMusicUrlFailed, type ValidateMusicUrl } from './sourcePriority'
import { isRequestCancelled, requestMsg } from '@/utils/message'
import { validateQQMusicUrl } from '@/core/qqMusicUrl'
import { getMusicUrlCacheContext } from '@/utils/musicUrlCache'
import { playbackLog, type PlaybackLogContext } from '@/utils/playbackLog'

import {
  buildLyricInfo,
  getPlayQuality,
  handleGetOnlineLyricInfo,
  handleGetOnlineMusicUrl,
  handleGetOnlinePicUrl,
  getCachedLyricInfo,
  isLyricCacheStale,
} from './utils'

/* export const setMusicUrl = ({ musicInfo, type, url }: {
  musicInfo: LX.Music.MusicInfo
  type: LX.Quality
  url: string
}) => {
  saveMusicUrl(musicInfo, type, url)
}

export const setPic = (datas: {
  listId: string
  musicInfo: LX.Music.MusicInfo
  url: string
}) => {
  datas.musicInfo.img = datas.url
  updateMusicInfo({
    listId: datas.listId,
    id: datas.musicInfo.songmid,
    data: { img: datas.url },
    musicInfo: datas.musicInfo,
  })
}
 */


export const getMusicUrl = async({ musicInfo, quality, isRefresh, allowToggleSource = true, onToggleSource = () => {}, urlSourceOrder, onCancel, validateUrl, rejectedUrls, cacheContext = getMusicUrlCacheContext(settingState.setting, urlSourceOrder), trace }: {
  musicInfo: LX.Music.MusicInfoOnline
  quality?: LX.Quality
  isRefresh: boolean
  allowToggleSource?: boolean
  onToggleSource?: (musicInfo?: LX.Music.MusicInfoOnline) => void
  /** 两条链的先后，见 core/music/utils.ts。不传按播放设置走 */
  urlSourceOrder?: LX.Music.UrlSourceOrder
  onCancel?: (cancel: () => void) => void
  validateUrl?: ValidateMusicUrl
  rejectedUrls?: ReadonlySet<string>
  cacheContext?: string
  trace?: PlaybackLogContext
}): Promise<string> => {
  let cancelled = false
  let currentCancel: (() => void) | undefined
  onCancel?.(() => { cancelled = true; currentCancel?.() })
  const assertActive = () => { if (cancelled) throw new Error(requestMsg.cancelRequest) }
  const registerCancel = (cancel: () => void) => {
    currentCancel = cancel
    if (cancelled) cancel()
  }
  assertActive()
  // if (!musicInfo._types[type]) {
  //   // 兼容旧版酷我源搜索列表过滤128k音质的bug
  //   if (!(musicInfo.source == 'kw' && type == '128k')) throw new Error('该歌曲没有可播放的音频')

  //   // return Promise.reject(new Error('该歌曲没有可播放的音频'))
  // }
  const targetQuality = quality ?? getPlayQuality(settingState.setting['player.playQuality'], musicInfo)
  playbackLog('url.cache_lookup', () => ({ ...trace, musicId: musicInfo.id, quality: targetQuality }))
  const cachedUrl = await getStoreMusicUrl(musicInfo, targetQuality, cacheContext)
  assertActive()
  if (cachedUrl && !isRefresh && !isMusicUrlFailed(cachedUrl) && !rejectedUrls?.has(cachedUrl)) {
    try {
      playbackLog('url.cache_validate', { ...trace, musicId: musicInfo.id })
      await validateQQMusicUrl(musicInfo, cachedUrl, registerCancel, false, trace)
      assertActive()
      await validateUrl?.(cachedUrl)
      assertActive()
      playbackLog('url.cache_hit', () => ({ ...trace, musicId: musicInfo.id, url: cachedUrl }))
      return cachedUrl
    } catch (error) {
      playbackLog('url.cache_rejected', () => ({ ...trace, error }))
      assertActive()
      if (isRequestCancelled(error)) throw error
      markMusicUrlFailed(cachedUrl, error)
    }
  }

  playbackLog('url.cache_miss', () => ({ ...trace, musicId: musicInfo.id, isRefresh }))
  return handleGetOnlineMusicUrl({ musicInfo, quality, onToggleSource, isRefresh, allowToggleSource, urlSourceOrder, onCancel: registerCancel, validateUrl, rejectedUrls, cacheContext, trace }).then(({ url, quality: actualQuality, musicInfo: targetMusicInfo, isFromCache }) => {
    assertActive()
    playbackLog('url.resolved', () => ({ ...trace, musicId: musicInfo.id, actualMusicId: targetMusicInfo.id, quality: actualQuality, url, isFromCache }))
    if (cacheContext !== getMusicUrlCacheContext(settingState.setting, urlSourceOrder)) return url
    if (targetMusicInfo.id != musicInfo.id && !isFromCache) void saveMusicUrl(targetMusicInfo, actualQuality, url, cacheContext)
    void saveMusicUrl(musicInfo, actualQuality, url, cacheContext)
    return url
  })
}

export const getPicUrl = async({ musicInfo, listId, isRefresh, allowToggleSource = true, onToggleSource = () => {} }: {
  musicInfo: LX.Music.MusicInfoOnline
  listId?: string | null
  isRefresh: boolean
  allowToggleSource?: boolean
  onToggleSource?: (musicInfo?: LX.Music.MusicInfoOnline) => void
}): Promise<string> => {
  if (musicInfo.meta.picUrl && !isRefresh) return musicInfo.meta.picUrl
  return handleGetOnlinePicUrl({ musicInfo, onToggleSource, isRefresh, allowToggleSource }).then(({ url, musicInfo: targetMusicInfo, isFromCache }) => {
    // picRequest = null
    if (listId) {
      musicInfo.meta.picUrl = url
      void updateListMusics([{ id: listId, musicInfo }])
    }
    // savePic({ musicInfo, url, listId })
    return url
  })
}
export const getLyricInfo = async({ musicInfo, isRefresh, allowToggleSource = true, onToggleSource = () => {} }: {
  musicInfo: LX.Music.MusicInfoOnline
  isRefresh: boolean
  allowToggleSource?: boolean
  onToggleSource?: (musicInfo?: LX.Music.MusicInfoOnline) => void
}): Promise<LX.Player.LyricInfo> => {
  const cached = isRefresh ? null : await getCachedLyricInfo(musicInfo, true)
  if (cached && !isLyricCacheStale(musicInfo, cached)) return buildLyricInfo(cached)

  try {
    const { lyricInfo, musicInfo: targetMusicInfo, isFromCache } = await handleGetOnlineLyricInfo({
      musicInfo,
      onToggleSource,
      isRefresh,
      // 旧缓存升级失败时继续显示已有歌词，避免断网时丢歌词或切到别的版本。
      allowToggleSource: cached ? false : allowToggleSource,
    })
    // 主接口暂时失败时，网页备用结果不能覆盖已有的翻译和逐字时间。
    if (cached && isLyricCacheStale(targetMusicInfo, lyricInfo)) return buildLyricInfo(cached)
    if (isFromCache) return buildLyricInfo(lyricInfo)
    if (targetMusicInfo.id == musicInfo.id) void saveLyric(musicInfo, lyricInfo)
    else void saveLyric(targetMusicInfo, lyricInfo)

    return buildLyricInfo(lyricInfo)
  } catch (error) {
    if (cached) return buildLyricInfo(cached)
    throw error
  }
}
