import { useEffect } from 'react'
import PageContent from '@/components/PageContent'
import StatusBar from '@/components/common/StatusBar'
import SimpleHeader from '@/components/SimpleHeader'
import PlayerBar from '@/components/player/PlayerBar'
import Setting from '@/screens/Home/Views/Setting'
import { setComponentId } from '@/core/common'
import { COMPONENT_IDS } from '@/config/constant'
import { useI18n } from '@/lang'

// 设置从 pager 页改成了推入式页面：入口在「我的」页右上角。
export default ({ componentId }: { componentId: string }) => {
  const t = useI18n()

  useEffect(() => {
    setComponentId(COMPONENT_IDS.setting, componentId)
  }, [componentId])

  return (
    <PageContent>
      <StatusBar />
      <SimpleHeader componentId={componentId} title={t('nav_setting')} />
      <Setting />
      <PlayerBar />
    </PageContent>
  )
}
