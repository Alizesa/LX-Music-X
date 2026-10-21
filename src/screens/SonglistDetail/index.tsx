import { useEffect, useRef } from 'react'

import MusicList, { type MusicListType } from './MusicList'
import PageContent from '@/components/PageContent'
import StatusBar from '@/components/common/StatusBar'
import { setComponentId } from '@/core/common'
import { COMPONENT_IDS } from '@/config/constant'
import { type ListInfoItem } from '@/store/songlist/state'
import { clearListDetail, releaseSonglistDetail, retainSonglistDetail } from '@/core/songlist'
import PlayerBar from '@/components/player/PlayerBar'
import { ListInfoContext } from './state'


export default ({ componentId, info }: { componentId: string, info: ListInfoItem }) => {
  const musicListRef = useRef<MusicListType>(null)
  const isUnmountedRef = useRef(false)

  useEffect(() => {
    setComponentId(COMPONENT_IDS.songlistDetail, componentId)

    isUnmountedRef.current = false

    // 页面打开期间保住这份详情缓存，后台统一释放时跳过
    retainSonglistDetail(info.source, info.id)
    musicListRef.current?.loadList(info.source, info.id)


    return () => {
      isUnmountedRef.current = true
      releaseSonglistDetail(info.source, info.id)
      // 卸载后 store 里最后一份完整列表也放掉；重新进入会从缓存/网络重建
      clearListDetail()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])


  return (
    <PageContent>
      <StatusBar />
      <ListInfoContext.Provider value={info}>
        <MusicList ref={musicListRef} componentId={componentId} />
      </ListInfoContext.Provider>
      <PlayerBar />
    </PageContent>
  )
}

// const styles = createStyle({
//   container: {
//     width: '100%',
//     flex: 1,
//     flexDirection: 'row',
//     borderTopWidth: BorderWidths.normal,
//   },
//   content: {
//     flex: 1,
//   },
// })
