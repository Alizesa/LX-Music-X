import { View } from 'react-native'
import PlayerBar from '@/components/player/PlayerBar'
import BottomTabBar from '@/components/BottomTabBar'
import StatusBar from '@/components/common/StatusBar'
import { useTabletLayout } from '@/utils/hooks'
import Header from './Header'
import Main from './Main'
import { createStyle } from '@/utils/tools'

const styles = createStyle({
  content: {
    flex: 1,
    overflow: 'hidden',
  },
})

// 平板横屏：左侧导航条（PageContent 里渲染）替换底部 tab；
// 手机横屏没有左侧导航条，仍然用底部 tab。
export default () => {
  const { isWide } = useTabletLayout()

  return (
    <>
      <StatusBar />
      <View style={styles.content}>
        <Header />
        <Main />
        <PlayerBar />
      </View>
      {isWide ? null : <BottomTabBar />}
    </>
  )
}
