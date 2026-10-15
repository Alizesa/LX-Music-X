import { useEffect } from 'react'
import { View } from 'react-native'
import PageContent from '@/components/PageContent'
import StatusBar from '@/components/common/StatusBar'
import SimpleHeader from '@/components/SimpleHeader'
import PlayerBar from '@/components/player/PlayerBar'
import Search from '@/screens/Home/Views/Search'
import SearchTypeSelector from '@/screens/Home/Views/Search/SearchTypeSelector'
import { setComponentId } from '@/core/common'
import { COMPONENT_IDS } from '@/config/constant'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'
import { scaleSizeH } from '@/utils/pixelRatio'

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
      {/* 歌曲/歌单/歌手/专辑 的类型切换。原来挂在首页顶栏上（搜索还是 pager 页的时候），
          搜索改成推入式页面后一并搬到这里。SearchTypeSelector 自身 height 是 100%，
          所以外面要给它一个有高度的容器 */}
      <View style={styles.typeBar}>
        <SearchTypeSelector />
      </View>
      <View style={styles.content}>
        <Search />
      </View>
      <PlayerBar />
    </PageContent>
  )
}

const styles = createStyle({
  typeBar: {
    height: scaleSizeH(40),
  },
  content: {
    flex: 1,
  },
})
