import { filterList, getComments, type Comment } from './utils'
import { isRequestCancelled } from '@/utils/message'
import { type Status } from './components/List'

export const COMMENT_PAGE_SIZE = 15
export const MAX_COMMENT_PAGES = 5
export interface CommentState {
  comments: Comment[]
  status: Status
  hasPrevious: boolean
}

export const createCommentController = (musicInfo: LX.Music.MusicInfoOnline, type: 'hot' | 'new',
  onChange: (state: CommentState) => void, onTotal: (total: number) => void) => {
  let pages: Array<{ page: number, comments: Comment[] }> = []
  let maxPage = 1
  let generation = 0
  let disposed = false
  let pending: AbortController | null = null
  const publish = (status: Status) => {
    onChange({ comments: filterList(pages.flatMap(page => page.comments)), status, hasPrevious: (pages[0]?.page ?? 1) > 1 })
  }
  const load = async(page: number, direction: 'reset' | 'next' | 'previous') => {
    if (disposed) return
    const current = ++generation
    pending?.abort()
    const controller = pending = new AbortController()
    if (direction === 'reset') pages = []
    publish(direction === 'reset' ? 'refreshing' : 'loading')
    try {
      const result = await getComments(musicInfo, type, page, COMMENT_PAGE_SIZE, controller.signal)
      if (disposed || current !== generation) return
      maxPage = Math.max(1, result.maxPage)
      const incoming = { page, comments: result.comments }
      if (direction === 'reset') pages = [incoming]
      else if (direction === 'previous') pages = [incoming, ...pages].slice(0, MAX_COMMENT_PAGES)
      else pages = [...pages, incoming].slice(-MAX_COMMENT_PAGES)
      onTotal(result.total)
      publish(pages[pages.length - 1].page >= maxPage ? 'end' : 'idle')
    } catch (error) {
      if (!disposed && current === generation && !isRequestCancelled(error)) publish('error')
    } finally {
      if (pending === controller) pending = null
    }
  }
  return {
    refresh: async() => load(1, 'reset'),
    next: async() => {
      const page = pages[pages.length - 1]?.page ?? 0
      if (!pending && page < maxPage) await load(page + 1, 'next')
    },
    previous: async() => {
      const page = pages[0]?.page ?? 1
      if (!pending && page > 1) await load(page - 1, 'previous')
    },
    dispose: () => {
      disposed = true
      generation++
      pending?.abort()
      pending = null
      pages = []
    },
  }
}
