import { useEffect, useRef, useState } from 'react'
import List from './components/List'
import { createCommentController, type CommentState } from './controller'

export default ({ musicInfo, type, onUpdateTotal }: {
  musicInfo: LX.Music.MusicInfoOnline
  type: 'hot' | 'new'
  onUpdateTotal: (total: number) => void
}) => {
  const controller = useRef<ReturnType<typeof createCommentController> | null>(null)
  const [state, setState] = useState<CommentState>({ comments: [], status: 'loading', hasPrevious: false })
  useEffect(() => {
    const current = createCommentController(musicInfo, type, setState, onUpdateTotal)
    controller.current = current
    void current.refresh()
    return () => {
      controller.current = null
      current.dispose()
    }
  }, [musicInfo, type, onUpdateTotal])
  return <List
    list={state.comments}
    status={state.status}
    hasPrevious={state.hasPrevious}
    onRefresh={() => { void controller.current?.refresh() }}
    onLoadMore={() => { void controller.current?.next() }}
    onLoadPrevious={() => { void controller.current?.previous() }}
  />
}
