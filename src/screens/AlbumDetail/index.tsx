import { useEffect } from 'react'

import PageContent from '@/components/PageContent'
import StatusBar from '@/components/common/StatusBar'
import PlayerBar from '@/components/player/PlayerBar'
import { setComponentId } from '@/core/common'
import { COMPONENT_IDS } from '@/config/constant'
import { type AlbumDetailParams } from '@/store/singer/state'
import { releaseAlbumRecord, retainAlbumRecord } from '@/store/singer/action'
import MusicList from './MusicList'
import { useScreenVisible } from '@/utils/hooks/useScreenVisible'

export default ({ componentId, info }: { componentId: string, info: AlbumDetailParams }) => {
  const visible = useScreenVisible()

  useEffect(() => {
    setComponentId(COMPONENT_IDS.albumDetail, componentId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 返回时从本地快照恢复；隐藏页面不占用专辑整表。
  useEffect(() => {
    if (!visible) return
    retainAlbumRecord(info.mid)
    return () => { releaseAlbumRecord(info.mid) }
  }, [info.mid, visible])

  return (
    <PageContent>
      <StatusBar />
      <MusicList params={info} />
      <PlayerBar />
    </PageContent>
  )
}
