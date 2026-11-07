import { useCallback, useEffect, useRef } from 'react'
import OnlineList, { type OnlineListType, type OnlineListProps } from '@/components/OnlineList'
import { getSingerDetail, getSingerSongs } from '@/core/singer'
import singerState, { type SingerInfo } from '@/store/singer/state'
import { handlePlay } from './listAction'
import { useScreenVisible } from '@/utils/hooks/useScreenVisible'

export default ({ mid, onInfoLoaded }: {
  mid: string
  onInfoLoaded: (info: SingerInfo) => void
}) => {
  const listRef = useRef<OnlineListType>(null)
  const visible = useScreenVisible()
  const version = useRef(0)
  // setStatus 是异步的，光靠 status 判不住重复请求
  const loadingRef = useRef(false)

  const load = useCallback(async(page: number, isRefresh = false) => {
    if (!visible || loadingRef.current) return
    const request = ++version.current
    loadingRef.current = true
    try {
      if (page <= 1) {
        // 歌手信息和第一页歌曲是同一个接口，一次请求全拿到
        const record = await getSingerDetail(mid, isRefresh)
        if (request !== version.current) return
        onInfoLoaded(record.info)
        listRef.current?.setList(record.songs.list)
        listRef.current?.setStatus(record.songs.maxPage <= record.songs.page ? 'end' : 'idle')
      } else {
        const songs = await getSingerSongs(mid, page)
        if (request !== version.current) return
        listRef.current?.setList(songs.list)
        listRef.current?.setStatus(songs.maxPage <= songs.page ? 'end' : 'idle')
      }
    } catch (err) {
      console.log(err)
      if (request !== version.current) return
      listRef.current?.setStatus('error')
    } finally {
      if (request === version.current) loadingRef.current = false
    }
  }, [mid, onInfoLoaded, visible])

  useEffect(() => {
    if (!visible) return
    listRef.current?.setStatus('loading')
    void load(1)
    return () => {
      version.current += 1
      loadingRef.current = false
    }
  }, [load, visible])

  const handlePlayList: OnlineListProps['onPlayList'] = (index) => {
    void handlePlay(mid, singerState.singers[mid]?.songs.list ?? [], index)
  }
  const handleRefresh: OnlineListProps['onRefresh'] = () => {
    listRef.current?.setStatus('refreshing')
    void load(1, true)
  }
  // 出错时列表是空的，此时点“重新加载”也是重来第一页
  const handleLoadMore: OnlineListProps['onLoadMore'] = () => {
    const songs = singerState.singers[mid]?.songs
    listRef.current?.setStatus('loading')
    void load(songs?.list.length ? songs.page + 1 : 1)
  }

  return (
    <OnlineList
      ref={listRef}
      releaseOnHide
      onPlayList={handlePlayList}
      onRefresh={handleRefresh}
      onLoadMore={handleLoadMore}
    />
  )
}
