import { View } from 'react-native'
import PlayerBar from '@/components/player/PlayerBar'
import BottomTabBar from '@/components/BottomTabBar'
import StatusBar from '@/components/common/StatusBar'
import Header from './Header'
import Main from './Main'
import { createStyle } from '@/utils/tools'

const styles = createStyle({
  content: {
    flex: 1,
    overflow: 'hidden',
  },
})

// 横屏原来用左侧图标导航条（Aside），现在和竖屏统一：底部 tab bar。
export default () => {
  return (
    <>
      <StatusBar />
      <View style={styles.content}>
        <Header />
        <Main />
        <PlayerBar isHome />
      </View>
      <BottomTabBar />
    </>
  )
}
