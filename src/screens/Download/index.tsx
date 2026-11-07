import { useEffect } from 'react'
import { View } from 'react-native'
import PageContent from '@/components/PageContent'
import StatusBar from '@/components/common/StatusBar'
import SimpleHeader from '@/components/SimpleHeader'
import PlayerBar from '@/components/player/PlayerBar'
import Download from '@/screens/Home/Views/Download'
import { setComponentId } from '@/core/common'
import { COMPONENT_IDS } from '@/config/constant'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'

// 下载管理从 pager 页改成了推入式页面：入口在「我的」页的「下载管理」。
export default ({ componentId }: { componentId: string }) => {
  const t = useI18n()

  useEffect(() => {
    setComponentId(COMPONENT_IDS.download, componentId)
  }, [componentId])

  return (
    <PageContent>
      <StatusBar />
      <SimpleHeader componentId={componentId} title={t('nav_download')} />
      <View style={styles.content}>
        <Download />
      </View>
      <PlayerBar />
    </PageContent>
  )
}

const styles = createStyle({
  content: {
    flex: 1,
  },
})
