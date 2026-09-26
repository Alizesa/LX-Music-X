import { useEffect, useRef } from 'react'

import PageContent from '@/components/PageContent'
import StatusBar from '@/components/common/StatusBar'
import PlayerBar from '@/components/player/PlayerBar'
import { setComponentId } from '@/core/common'
import { COMPONENT_IDS } from '@/config/constant'
import { type AlbumDetailParams } from '@/store/singer/state'
import MusicList, { type MusicListType } from './MusicList'

export default ({ componentId, info }: { componentId: string, info: AlbumDetailParams }) => {
  const musicListRef = useRef<MusicListType>(null)

  useEffect(() => {
    setComponentId(COMPONENT_IDS.albumDetail, componentId)
    musicListRef.current?.loadList(info.mid)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <PageContent>
      <StatusBar />
      <MusicList ref={musicListRef} params={info} />
      <PlayerBar />
    </PageContent>
  )
}
