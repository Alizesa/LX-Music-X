import { useEffect } from 'react'
import PageContent from '@/components/PageContent'
import StatusBar from '@/components/common/StatusBar'
import SimpleHeader from '@/components/SimpleHeader'
import PlayerBar from '@/components/player/PlayerBar'
import PlayHistory from '@/screens/Home/Views/Setting/settings/PlayHistoryPage'
import { setComponentId } from '@/core/common'
import { COMPONENT_IDS } from '@/config/constant'
import { useI18n } from '@/lang'

// 播放历史从 pager 页改成了推入式页面：入口在「我的」页的「最近播放」。
export default ({ componentId }: { componentId: string }) => {
  const t = useI18n()

  useEffect(() => {
    setComponentId(COMPONENT_IDS.playHistory, componentId)
  }, [componentId])

  return (
    <PageContent>
      <StatusBar />
      <SimpleHeader componentId={componentId} title={t('nav_history')} />
      <PlayHistory />
      <PlayerBar />
    </PageContent>
  )
}
