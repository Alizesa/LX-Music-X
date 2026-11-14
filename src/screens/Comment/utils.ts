import { toOldMusicInfo } from '@/utils'
import music from '@/utils/musicSdk'
import { waitForPromise } from '@/utils/abortable'
import { isRequestCancelled, requestMsg } from '@/utils/message'

export interface Comment {
  id: string
  text: string
  images?: string[]
  location?: string
  timeStr?: string
  userName: string
  avatar?: string
  userId?: string
  likedCount?: number
  replyNum?: number
  reply: Comment[]
}
export interface CommentInfo {
  source: LX.OnlineSource
  comments: Comment[]
  total: number
  page: number
  limit: number
  maxPage: number
}

export const getComments = async(musicInfo: LX.Music.MusicInfoOnline, type: 'hot' | 'new', page: number, limit: number, signal: AbortSignal): Promise<CommentInfo> => {
  const api = music[musicInfo.source]?.comment
  if (!api) throw new Error('Unsupported comment source')
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw new Error(requestMsg.cancelRequest)
    try {
      const request = type === 'hot' ? api.getHotComment : api.getComment
      return await waitForPromise(request.call(api, toOldMusicInfo(musicInfo), page, limit, signal) as Promise<CommentInfo>, signal)
    } catch (error) {
      if (signal.aborted || isRequestCancelled(error) || attempt >= 2) throw error
    }
  }
}

export const filterList = (list: Comment[]) => {
  const set = new Set()
  return list.filter(c => {
    let id = String(c.id)
    if (set.has(id)) return false
    set.add(id)
    return true
  })
}
