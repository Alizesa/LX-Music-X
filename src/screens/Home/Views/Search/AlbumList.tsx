import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'

import { navigations } from '@/navigation'
import commonState from '@/store/common/state'
import { type Source } from '@/store/search/music/state'
import searchAlbumState, { type AlbumItem } from '@/store/search/album/state'
import { search } from '@/core/search/album'
// 展示层直接复用歌手详情页专辑标签那套封面网格，连共享元素动画都是现成的
import AlbumGridList, { type AlbumListType as AlbumGridListType } from '@/screens/SingerDetail/AlbumList'

export interface AlbumListType {
  loadList: (text: string, source: Source) => void
}

export default forwardRef<AlbumListType, {}>((props, ref) => {
  const listRef = useRef<AlbumGridListType>(null)
  const textRef = useRef('')
  const isUnmountedRef = useRef(false)

  const load = async(page: number, isRefresh = false) => {
    try {
      const list = await search(textRef.current, page, isRefresh)
      // null：这次结果已经作废（关键词换了），列表归新的那次请求管
      if (list == null || isUnmountedRef.current) return
      requestAnimationFrame(() => {
        listRef.current?.setList(list)
        listRef.current?.setStatus(searchAlbumState.listInfo.maxPage <= page ? 'end' : 'idle')
      })
    } catch (err) {
      console.log(err)
      if (isUnmountedRef.current) return
      listRef.current?.setStatus('error')
    }
  }

  useImperativeHandle(ref, () => ({
    loadList(text) {
      // 专辑搜索只有 tx 源，source 参数用不上
      textRef.current = text
      listRef.current?.setList([])
      if (!text) {
        listRef.current?.setStatus('idle')
        return
      }
      listRef.current?.setStatus('loading')
      void load(1)
    },
  }), [])

  useEffect(() => {
    isUnmountedRef.current = false
    return () => {
      isUnmountedRef.current = true
    }
  }, [])

  const handleRefresh = () => {
    listRef.current?.setStatus('refreshing')
    void load(1, true)
  }
  const handleLoadMore = () => {
    const listInfo = searchAlbumState.listInfo
    listRef.current?.setStatus('loading')
    void load(listInfo.list.length ? listInfo.page + 1 : 1)
  }
  const handleOpenDetail = (item: AlbumItem) => {
    navigations.pushAlbumDetailScreen(commonState.componentIds.home!, {
      id: item.id,
      mid: item.mid,
      name: item.name,
      author: item.author,
      img: item.img,
      publishDate: item.publishDate,
    })
  }

  return (
    <AlbumGridList
      ref={listRef}
      onRefresh={handleRefresh}
      onLoadMore={handleLoadMore}
      onOpenDetail={handleOpenDetail}
    />
  )
})
