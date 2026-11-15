import { useEffect, useRef } from 'react'

import MusicList, { type MusicListType } from './MusicList'
import PageContent from '@/components/PageContent'
import StatusBar from '@/components/common/StatusBar'
import { setComponentId } from '@/core/common'
import { COMPONENT_IDS } from '@/config/constant'
import { type ListInfoItem } from '@/store/songlist/state'
import songlistState from '@/store/songlist/state'
import { clearListDetail, releaseSonglistDetail, retainSonglistDetail } from '@/core/songlist'
import PlayerBar from '@/components/player/PlayerBar'
import { ListInfoContext } from './state'
import { useScreenVisible } from '@/utils/hooks/useScreenVisible'


export default ({ componentId, info }: { componentId: string, info: ListInfoItem }) => {
  const musicListRef = useRef<MusicListType>(null)
  const lastPage = useRef(1)
  const visible = useScreenVisible()

  useEffect(() => {
    setComponentId(COMPONENT_IDS.songlistDetail, componentId)

    if (!visible) return
    // 仅可见页面保留完整详情；返回时恢复已缓存分页。
    retainSonglistDetail(info.source, info.id)
    musicListRef.current?.loadList(info.source, info.id, lastPage.current)


    return () => {
      releaseSonglistDetail(info.source, info.id)
      // 卸载后 store 里最后一份完整列表也放掉；重新进入会从缓存/网络重建
      if (songlistState.listDetailInfo.id === info.id && songlistState.listDetailInfo.source === info.source) {
        lastPage.current = songlistState.listDetailInfo.page
        clearListDetail()
      }
    }
  }, [componentId, info.id, info.source, visible])


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
