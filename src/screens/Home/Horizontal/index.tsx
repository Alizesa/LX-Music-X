import { View } from 'react-native'
import PlayerBar, { TABLET_PLAYER_BAR_INSET } from '@/components/player/PlayerBar'
import BottomTabBar from '@/components/BottomTabBar'
import TabletNavRail from '@/components/TabletNavRail'
import StatusBar from '@/components/common/StatusBar'
import { useTabletLayout } from '@/utils/hooks'
import Header from './Header'
import Main from './Main'
import { createStyle } from '@/utils/tools'

const styles = createStyle({
  root: {
    flex: 1,
    flexDirection: 'row',
  },
  content: {
    flex: 1,
    overflow: 'hidden',
  },
  playerDock: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 1,
  },
})

// 平板横屏：首页/我的这一层用左侧导航条替换底部 tab；
// 手机横屏没有左侧导航条，仍然用底部 tab。
export default () => {
  const { isWide } = useTabletLayout()

  return (
    <>
      <StatusBar />
      <View style={styles.root}>
        {isWide ? <TabletNavRail /> : null}
        <View style={[styles.content, isWide && { paddingBottom: TABLET_PLAYER_BAR_INSET }]}>
          <Header />
          <Main />
          {isWide ? null : <PlayerBar />}
        </View>
        {isWide ? <View style={styles.playerDock} pointerEvents="box-none"><PlayerBar /></View> : null}
      </View>
      {isWide ? null : <BottomTabBar />}
    </>
  )
}
