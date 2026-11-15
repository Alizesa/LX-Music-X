import {
  getMusicUrl as getOnlineMusicUrl,
  getPicUrl as getOnlinePicUrl,
  getLyricInfo as getOnlineLyricInfo,
} from './online'
import { buildLyricInfo, getCachedLyricInfo } from './utils'
import { type MusicUrlRequestOptions } from './sourcePriority'
import { throwIfAborted } from '@/utils/abort'
import { waitForPromise } from '@/utils/abortable'

export const getMusicUrl = async({ musicInfo, isRefresh, allowToggleSource = true, onToggleSource = () => {}, ...options }: {
  musicInfo: LX.Download.ListItem
  isRefresh: boolean
  onToggleSource?: (musicInfo?: LX.Music.MusicInfoOnline) => void
  allowToggleSource?: boolean
} & MusicUrlRequestOptions): Promise<string> => {
  return getOnlineMusicUrl({ musicInfo: musicInfo.metadata.musicInfo, isRefresh, onToggleSource, allowToggleSource, ...options })
}

export const getPicUrl = async({ musicInfo, isRefresh, listId, onToggleSource = () => {}, signal }: {
  musicInfo: LX.Download.ListItem
  isRefresh: boolean
  listId?: string | null
  onToggleSource?: (musicInfo?: LX.Music.MusicInfoOnline) => void
  signal?: AbortSignal
}): Promise<string> => {
  throwIfAborted(signal)
  if (!isRefresh) {
    const onlineMusicInfo = musicInfo.metadata.musicInfo
    if (onlineMusicInfo.meta.picUrl) return onlineMusicInfo.meta.picUrl
  }

  return getOnlinePicUrl({ musicInfo: musicInfo.metadata.musicInfo, isRefresh, onToggleSource, signal }).then((url) => {
    // TODO: when listId required save url (update downloadInfo)

    return url
  })
}

export const getLyricInfo = async({ musicInfo, isRefresh, onToggleSource = () => {}, signal }: {
  musicInfo: LX.Download.ListItem
  isRefresh: boolean
  onToggleSource?: (musicInfo?: LX.Music.MusicInfoOnline) => void
  signal?: AbortSignal
}): Promise<LX.Player.LyricInfo> => {
  throwIfAborted(signal)
  if (!isRefresh) {
    const lyricInfo = await waitForPromise(getCachedLyricInfo(musicInfo.metadata.musicInfo, false, signal), signal)
    if (lyricInfo) return waitForPromise(buildLyricInfo(lyricInfo, signal), signal)
  }

  return getOnlineLyricInfo({
    musicInfo: musicInfo.metadata.musicInfo,
    isRefresh,
    onToggleSource,
    signal,
  }).catch(async() => {
    throwIfAborted(signal)
    throw new Error('failed')
  })
}
