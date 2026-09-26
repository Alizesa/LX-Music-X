import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import OnlineList, { type OnlineListType, type OnlineListProps } from '@/components/OnlineList'
import { getAlbumSongs } from '@/core/singer'
import singerState, { type AlbumDetailParams } from '@/store/singer/state'
import Header from './Header'
import { handlePlay } from './listAction'

export interface MusicListType {
  loadList: (mid: string) => void
}

export default forwardRef<MusicListType, { params: AlbumDetailParams }>(({ params }, ref) => {
  const listRef = useRef<OnlineListType>(null)
  const isUnmountedRef = useRef(false)

  const load = async(page: number, isRefresh = false) => {
    try {
      const info = await getAlbumSongs(params.mid, page, isRefresh)
      if (isUnmountedRef.current) return
      requestAnimationFrame(() => {
        listRef.current?.setList(info.list)
        listRef.current?.setStatus(info.maxPage <= page ? 'end' : 'idle')
      })
    } catch (err) {
      console.log(err)
      if (isUnmountedRef.current) return
      listRef.current?.setStatus('error')
    }
  }

  useImperativeHandle(ref, () => ({
    loadList() {
      listRef.current?.setStatus('loading')
      void load(1)
    },
  }))

  useEffect(() => {
    isUnmountedRef.current = false
    return () => {
      isUnmountedRef.current = true
    }
  }, [])

  const handlePlayList: OnlineListProps['onPlayList'] = (index) => {
    void handlePlay(params.mid, singerState.albumSongs[params.mid]?.list ?? [], index)
  }
  const handleRefresh: OnlineListProps['onRefresh'] = () => {
    listRef.current?.setStatus('refreshing')
    void load(1, true)
  }
  const handleLoadMore: OnlineListProps['onLoadMore'] = () => {
    const info = singerState.albumSongs[params.mid]
    if (!info) return
    listRef.current?.setStatus('loading')
    void load(info.list.length ? info.page + 1 : 1)
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const header = useMemo(() => <Header params={params} />, [])

  return (
    <OnlineList
      ref={listRef}
      onPlayList={handlePlayList}
      onRefresh={handleRefresh}
      onLoadMore={handleLoadMore}
      ListHeaderComponent={header}
    />
  )
})
