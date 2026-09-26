import { useCallback, useEffect, useRef } from 'react'
import OnlineList, { type OnlineListType, type OnlineListProps } from '@/components/OnlineList'
import { getSingerDetail } from '@/core/singer'
import singerState, { type SingerInfo } from '@/store/singer/state'
import { handlePlay } from './listAction'

export default ({ mid, onInfoLoaded }: {
  mid: string
  onInfoLoaded: (info: SingerInfo) => void
}) => {
  const listRef = useRef<OnlineListType>(null)
  const isUnmountedRef = useRef(false)

  const load = useCallback(async(isRefresh = false) => {
    try {
      // 歌手信息和热门歌曲是同一个接口，一次请求全拿到
      const record = await getSingerDetail(mid, isRefresh)
      if (isUnmountedRef.current) return
      requestAnimationFrame(() => {
        onInfoLoaded(record.info)
        listRef.current?.setList(record.songs.list)
        // 热门歌曲只有一页，不往下翻
        listRef.current?.setStatus(record.songs.list.length ? 'end' : 'idle')
      })
    } catch (err) {
      if (isUnmountedRef.current) return
      console.log(err)
      listRef.current?.setStatus('error')
    }
  }, [mid, onInfoLoaded])

  useEffect(() => {
    isUnmountedRef.current = false
    listRef.current?.setStatus('loading')
    void load()
    return () => {
      isUnmountedRef.current = true
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handlePlayList: OnlineListProps['onPlayList'] = (index) => {
    void handlePlay(mid, singerState.singers[mid]?.songs.list ?? [], index)
  }
  const handleRefresh: OnlineListProps['onRefresh'] = () => {
    listRef.current?.setStatus('refreshing')
    void load(true)
  }
  // 热门歌曲一次就是全部，不翻页；只有列表空着（加载失败）时，
  // 底部的“加载失败，点击重试”才有意义
  const handleLoadMore: OnlineListProps['onLoadMore'] = () => {
    if (singerState.singers[mid]?.songs.list.length) return
    listRef.current?.setStatus('loading')
    void load(true)
  }

  return (
    <OnlineList
      ref={listRef}
      onPlayList={handlePlayList}
      onRefresh={handleRefresh}
      onLoadMore={handleLoadMore}
    />
  )
}
