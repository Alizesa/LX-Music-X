// if (targetSong.key) { // 如果是已下载的歌曲
//   const filePath = path.join(appSetting['download.savePath'], targetSong.metadata.fileName)
//   // console.log(filePath)

import {
  getMusicUrl as getOnlineMusicUrl,
  getPicUrl as getOnlinePicUrl,
  getLyricInfo as getOnlineLyricInfo,
} from './online'
import {
  getMusicUrl as getDownloadMusicUrl,
  getPicUrl as getDownloadPicUrl,
  getLyricInfo as getDownloadLyricInfo,
} from './download'
import {
  getMusicUrl as getLocalMusicUrl,
  getPicUrl as getLocalPicUrl,
  getLyricInfo as getLocalLyricInfo,
  findLocalMusicInfo,
} from './local'
import { getLocalFilePath } from '@/utils/music'
import { LIST_IDS } from '@/config/constant'
import { type ValidateMusicUrl } from './sourcePriority'
import { playbackLog, type PlaybackLogContext } from '@/utils/playbackLog'
import { throwIfAborted } from '@/utils/abort'
import { waitForPromise } from '@/utils/abortable'


export const getMusicUrl = async({
  musicInfo,
  quality,
  isRefresh = false,
  onToggleSource,
  allowToggleSource,
  urlSourceOrder,
  onCancel,
  validateUrl,
  rejectedUrls,
  trace,
  expectedMusicInfo,
}: {
  musicInfo: LX.Music.MusicInfo | LX.Download.ListItem
  isRefresh?: boolean
  quality?: LX.Quality
  onToggleSource?: (musicInfo?: LX.Music.MusicInfoOnline) => void
  allowToggleSource?: boolean
  /** 两条链的先后，见 core/music/utils.ts。下载按自己的设置传，不传按播放设置走 */
  urlSourceOrder?: LX.Music.UrlSourceOrder
  /** 拿到可取消句柄时回调；调用方切歌/取消预加载时用它中断在途请求 */
  onCancel?: (cancel: () => void) => void
  validateUrl?: ValidateMusicUrl
  rejectedUrls?: ReadonlySet<string>
  trace?: PlaybackLogContext
  expectedMusicInfo?: LX.Music.MusicInfo
}): Promise<string> => {
  playbackLog('url.request', () => ({ ...trace, musicId: musicInfo.id, quality, isRefresh, urlSourceOrder }))
  if ('progress' in musicInfo) {
    return getDownloadMusicUrl({ musicInfo, isRefresh, onToggleSource, allowToggleSource, quality, urlSourceOrder, onCancel, validateUrl, rejectedUrls, trace, expectedMusicInfo })
  } else if (musicInfo.source == 'local') {
    return getLocalMusicUrl({ musicInfo, isRefresh, onToggleSource, allowToggleSource, quality, urlSourceOrder, onCancel, validateUrl, rejectedUrls, trace, expectedMusicInfo })
  } else {
    if (!isRefresh) {
      const localMusicInfo = await findLocalMusicInfo(musicInfo)
      if (localMusicInfo) {
        const localPath = await getLocalFilePath(localMusicInfo)
        if (localPath) { playbackLog('url.local_hit', { ...trace, musicId: musicInfo.id }); return localPath }
      }
    }
    return getOnlineMusicUrl({ musicInfo, isRefresh, quality, onToggleSource, allowToggleSource, urlSourceOrder, onCancel, validateUrl, rejectedUrls, trace, expectedMusicInfo })
  }
}

export const getPicPath = async({
  musicInfo,
  isRefresh = false,
  listId,
  onToggleSource,
  signal,
}: {
  musicInfo: LX.Music.MusicInfo | LX.Download.ListItem
  listId?: string | null
  isRefresh?: boolean
  onToggleSource?: (musicInfo?: LX.Music.MusicInfoOnline) => void
  signal?: AbortSignal
}): Promise<string> => {
  throwIfAborted(signal)
  if ('progress' in musicInfo) {
    return getDownloadPicUrl({ musicInfo, isRefresh, listId, onToggleSource, signal })
  } else if (musicInfo.source == 'local') {
    return getLocalPicUrl({ musicInfo, isRefresh, listId, onToggleSource, signal })
  } else {
    if (!isRefresh) {
      const localMusicInfo = await waitForPromise(findLocalMusicInfo(musicInfo), signal)
      if (localMusicInfo) return getLocalPicUrl({ musicInfo: localMusicInfo, isRefresh: false, listId: LIST_IDS.LOCAL, onToggleSource, signal })
    }
    return getOnlinePicUrl({ musicInfo, isRefresh, listId, onToggleSource, signal })
  }
}

export const getLyricInfo = async({
  musicInfo,
  isRefresh = false,
  onToggleSource,
  signal,
}: {
  musicInfo: LX.Music.MusicInfo | LX.Download.ListItem
  isRefresh?: boolean
  onToggleSource?: (musicInfo?: LX.Music.MusicInfoOnline) => void
  signal?: AbortSignal
}): Promise<LX.Player.LyricInfo> => {
  throwIfAborted(signal)
  if ('progress' in musicInfo) {
    return getDownloadLyricInfo({ musicInfo, isRefresh, onToggleSource, signal })
  } else if (musicInfo.source == 'local') {
    return getLocalLyricInfo({ musicInfo, isRefresh, onToggleSource, signal })
  } else {
    if (!isRefresh) {
      const localMusicInfo = await waitForPromise(findLocalMusicInfo(musicInfo), signal)
      if (localMusicInfo) return getLocalLyricInfo({ musicInfo: localMusicInfo, isRefresh: false, onToggleSource, signal })
    }
    return getOnlineLyricInfo({ musicInfo, isRefresh, onToggleSource, signal })
  }
}
