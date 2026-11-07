import { useCallback, useEffect, useRef } from 'react'
import { getSingerAlbums } from '@/core/singer'
import singerState, { type AlbumItem } from '@/store/singer/state'
import { navigations } from '@/navigation'
import commonState from '@/store/common/state'
import AlbumList, { type AlbumListType } from './AlbumList'
import { useScreenVisible } from '@/utils/hooks/useScreenVisible'

export default ({ mid }: { mid: string }) => {
  const listRef = useRef<AlbumListType>(null)
  const visible = useScreenVisible()
  const version = useRef(0)
  // setStatus 是异步的，光靠 status 判不住重复请求
  const loadingRef = useRef(false)

  const load = useCallback(async(page: number, isRefresh = false) => {
    if (!visible || loadingRef.current) return
    const request = ++version.current
    loadingRef.current = true
    try {
      const info = await getSingerAlbums(mid, page, isRefresh)
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
  }, [mid, visible])

  useEffect(() => {
    if (!visible) return
    listRef.current?.setStatus('loading')
    void load(1)
    return () => {
      version.current += 1
      loadingRef.current = false
    }
  }, [load, visible])

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
      releaseOnHide
      onRefresh={handleRefresh}
      onLoadMore={handleLoadMore}
      onOpenDetail={handleOpenDetail}
    />
  )
}
