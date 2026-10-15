import { useEffect } from 'react'
import { View } from 'react-native'
import PageContent from '@/components/PageContent'
import StatusBar from '@/components/common/StatusBar'
import SimpleHeader from '@/components/SimpleHeader'
import PlayerBar from '@/components/player/PlayerBar'
import Search from '@/screens/Home/Views/Search'
import { setComponentId } from '@/core/common'
import { COMPONENT_IDS } from '@/config/constant'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'

// 搜索从 pager 页改成了推入式页面：入口在「首页」右上角的放大镜。
export default ({ componentId }: { componentId: string }) => {
  const t = useI18n()

  useEffect(() => {
    setComponentId(COMPONENT_IDS.search, componentId)
  }, [componentId])

  return (
    <PageContent>
      <StatusBar />
      <SimpleHeader componentId={componentId} title={t('nav_search')} />
      <View style={styles.content}>
        <Search />
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
