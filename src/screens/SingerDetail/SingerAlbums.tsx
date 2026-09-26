import { useEffect, useRef } from 'react'
import { getSingerAlbums } from '@/core/singer'
import singerState, { type AlbumItem } from '@/store/singer/state'
import { navigations } from '@/navigation'
import commonState from '@/store/common/state'
import AlbumList, { type AlbumListType } from './AlbumList'

export default ({ mid }: { mid: string }) => {
  const listRef = useRef<AlbumListType>(null)
  const isUnmountedRef = useRef(false)
  // setStatus 是异步的，光靠 status 判不住重复请求
  const loadingRef = useRef(false)

  const load = async(page: number, isRefresh = false) => {
    if (loadingRef.current) return
    loadingRef.current = true
    try {
      const info = await getSingerAlbums(mid, page, isRefresh)
      if (isUnmountedRef.current) return
      requestAnimationFrame(() => {
        listRef.current?.setList(info.list)
        listRef.current?.setStatus(info.maxPage <= page ? 'end' : 'idle')
      })
    } catch (err) {
      console.log(err)
      if (isUnmountedRef.current) return
      listRef.current?.setStatus('error')
    } finally {
      loadingRef.current = false
    }
  }

  useEffect(() => {
    isUnmountedRef.current = false
    listRef.current?.setStatus('loading')
    void load(1)
    return () => {
      isUnmountedRef.current = true
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleRefresh = () => {
    listRef.current?.setStatus('refreshing')
    void load(1, true)
  }
  const handleLoadMore = () => {
    const albums = singerState.singers[mid]?.albums
    if (!albums) return
    listRef.current?.setStatus('loading')
    void load(albums.list.length ? albums.page + 1 : 1)
  }
  const handleOpenDetail = (item: AlbumItem) => {
    navigations.pushAlbumDetailScreen(commonState.componentIds.singerDetail!, {
      id: item.id,
      mid: item.mid,
      name: item.name,
      author: item.author,
      img: item.img,
      publishDate: item.publishDate,
    })
  }

  return (
    <AlbumList
      ref={listRef}
      onRefresh={handleRefresh}
      onLoadMore={handleLoadMore}
      onOpenDetail={handleOpenDetail}
    />
  )
}
