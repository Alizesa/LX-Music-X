import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import OnlineList, { type OnlineListType, type OnlineListProps } from '@/components/OnlineList'
import { clearListDetail, getListDetail, setListDetail, setListDetailInfo } from '@/core/songlist'
import songlistState from '@/store/songlist/state'
import { handlePlay } from './listAction'
import Header, { type HeaderType } from './Header'
import { useListInfo } from './state'
import { useScreenVisible } from '@/utils/hooks/useScreenVisible'

export interface MusicListProps {
  componentId: string
}

export interface MusicListType {
  loadList: (source: LX.OnlineSource, listId: string, lastPage?: number) => void
}

export default forwardRef<MusicListType, MusicListProps>(({ componentId }, ref) => {
  const listRef = useRef<OnlineListType>(null)
  const headerRef = useRef<HeaderType>(null)
  const isUnmountedRef = useRef(false)
  const requestVersion = useRef(0)
  const info = useListInfo()
  const visible = useScreenVisible()
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const controller = useRef<AbortController | null>(null)
  const startRequest = () => {
    controller.current?.abort()
    controller.current = new AbortController()
    return controller.current.signal
  }
  const isCurrentRequest = (version: number, source: LX.OnlineSource, id: string) =>
    !isUnmountedRef.current && visibleRef.current && version === requestVersion.current &&
    songlistState.listDetailInfo.source === source && songlistState.listDetailInfo.id === id

  useImperativeHandle(ref, () => ({
    async loadList(source, id, lastPage = 1) {
      if (!visibleRef.current) return
      const signal = startRequest()
      const version = ++requestVersion.current
      clearListDetail()
      const listDetailInfo = songlistState.listDetailInfo
      listRef.current?.setList([])
      if (listDetailInfo.id == id && listDetailInfo.source == source && listDetailInfo.list.length) {
        requestAnimationFrame(() => {
          if (!isCurrentRequest(version, source, id)) return
          listRef.current?.setList(listDetailInfo.list)
          headerRef.current?.setInfo({
            name: (info.name || listDetailInfo.info.name) ?? '',
            // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
            desc: listDetailInfo.info.desc || info.desc || '',
            playCount: (info.play_count ?? listDetailInfo.info.play_count) ?? '',
            imgUrl: info.img ?? listDetailInfo.info.img,
          })
        })
      } else {
        listRef.current?.setStatus('loading')
        const page = 1
        setListDetailInfo(info.source, info.id)
        headerRef.current?.setInfo({
          name: (info.name || listDetailInfo.info.name) ?? '',
          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          desc: listDetailInfo.info.desc || info.desc || '',
          playCount: (info.play_count ?? listDetailInfo.info.play_count) ?? '',
          imgUrl: info.img ?? listDetailInfo.info.img,
        })
        const restorePages = async() => {
          for (let currentPage = 1; currentPage <= Math.max(1, lastPage); currentPage++) {
            const detail = await getListDetail(id, source, currentPage, false, signal)
            if (!isCurrentRequest(version, source, id)) return null
            const result = setListDetail(detail, id, currentPage)
            if (currentPage >= result.maxPage || !detail.list.length) break
          }
          return songlistState.listDetailInfo
        }
        return restorePages().then((result) => {
          if (!result || !isCurrentRequest(version, source, id)) return
          requestAnimationFrame(() => {
            if (!isCurrentRequest(version, source, id)) return
            headerRef.current?.setInfo({
              name: (info.name || listDetailInfo.info.name) ?? '',
              // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
              desc: listDetailInfo.info.desc || info.desc || '',
              playCount: (info.play_count ?? listDetailInfo.info.play_count) ?? '',
              imgUrl: info.img ?? listDetailInfo.info.img,
            })
            listRef.current?.setList(result.list)
            listRef.current?.setStatus(result.maxPage <= result.page ? 'end' : 'idle')
          })
        }).catch(() => {
          if (!isCurrentRequest(version, source, id)) return
          if (songlistState.listDetailInfo.list.length && page == 1) clearListDetail()
          listRef.current?.setStatus('error')
        })
      }
    },
  }))

  useEffect(() => {
    isUnmountedRef.current = false
    return () => {
      isUnmountedRef.current = true
      requestVersion.current += 1
      controller.current?.abort()
      controller.current = null
    }
  }, [])

  useEffect(() => {
    if (visible) return
    requestVersion.current++
    controller.current?.abort()
    controller.current = null
  }, [visible])


  const handlePlayList: OnlineListProps['onPlayList'] = (index) => {
    const listDetailInfo = songlistState.listDetailInfo
    // console.log(songlistState.listDetailInfo)
    void handlePlay(listDetailInfo.id, listDetailInfo.source, listDetailInfo.list, index)
  }
  const handleRefresh: OnlineListProps['onRefresh'] = () => {
    if (!visibleRef.current) return
    const signal = startRequest()
    const page = 1
    const { id, source } = songlistState.listDetailInfo
    const version = ++requestVersion.current
    listRef.current?.setStatus('refreshing')
    getListDetail(id, source, page, true, signal).then((listDetail) => {
      if (!isCurrentRequest(version, source, id)) return
      const result = setListDetail(listDetail, id, page)
      listRef.current?.setList(result.list)
      listRef.current?.setStatus(songlistState.listDetailInfo.maxPage <= page ? 'end' : 'idle')
    }).catch(() => {
      if (!isCurrentRequest(version, source, id)) return
      if (songlistState.listDetailInfo.list.length && page == 1) clearListDetail()
      listRef.current?.setStatus('error')
    })
  }
  const handleLoadMore: OnlineListProps['onLoadMore'] = () => {
    if (!visibleRef.current) return
    const signal = startRequest()
    listRef.current?.setStatus('loading')
    const page = songlistState.listDetailInfo.list.length ? songlistState.listDetailInfo.page + 1 : 1
    const { id, source } = songlistState.listDetailInfo
    const version = ++requestVersion.current
    getListDetail(id, source, page, false, signal).then((listDetail) => {
      if (!isCurrentRequest(version, source, id)) return
      const result = setListDetail(listDetail, id, page)
      listRef.current?.setList(result.list, true)
      listRef.current?.setStatus(songlistState.listDetailInfo.maxPage <= page ? 'end' : 'idle')
    }).catch(() => {
      if (!isCurrentRequest(version, source, id)) return
      if (songlistState.listDetailInfo.list.length && page == 1) clearListDetail()
      listRef.current?.setStatus('error')
    })
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const header = useMemo(() => <Header ref={headerRef} componentId={componentId} />, [])

  return <OnlineList
    ref={listRef}
    releaseOnHide
    onPlayList={handlePlayList}
    onRefresh={handleRefresh}
    onLoadMore={handleLoadMore}
    ListHeaderComponent={header}
    // progressViewOffset={}
   />
})

