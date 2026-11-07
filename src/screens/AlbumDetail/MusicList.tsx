import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import OnlineList, { type OnlineListType, type OnlineListProps } from '@/components/OnlineList'
import { getAlbumSongs } from '@/core/singer'
import singerState, { type AlbumDetailParams } from '@/store/singer/state'
import Header from './Header'
import { handlePlay } from './listAction'
import { useScreenVisible } from '@/utils/hooks/useScreenVisible'

export interface MusicListType {
  loadList: (mid: string) => void
}

export default forwardRef<MusicListType, { params: AlbumDetailParams }>(({ params }, ref) => {
  const listRef = useRef<OnlineListType>(null)
  const visible = useScreenVisible()
  const version = useRef(0)
  const loadingRef = useRef(false)

  const load = useCallback(async(page: number, isRefresh = false) => {
    if (!visible || loadingRef.current) return
    const request = ++version.current
    loadingRef.current = true
    try {
      const info = await getAlbumSongs(params.mid, page, isRefresh)
      if (request !== version.current) return
      listRef.current?.setList(info.list)
      listRef.current?.setStatus(info.maxPage <= info.page ? 'end' : 'idle')
    } catch (err) {
      console.log(err)
      if (request !== version.current) return
      listRef.current?.setStatus('error')
    } finally {
      if (request === version.current) loadingRef.current = false
    }
  }, [params.mid, visible])

  useImperativeHandle(ref, () => ({
    loadList() {
      listRef.current?.setStatus('loading')
      void load(1)
    },
  }))

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
      releaseOnHide
      onPlayList={handlePlayList}
      onRefresh={handleRefresh}
      onLoadMore={handleLoadMore}
      ListHeaderComponent={header}
    />
  )
})
