import { useCallback } from 'react'
import { TouchableOpacity, View } from 'react-native'
import { useTheme } from '@/store/theme/hook'
import { useNavActiveId, useStatusbarHeight } from '@/store/common/hook'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'
import { Icon } from '@/components/common/Icon'
import Text from '@/components/common/Text'
import StatusBar from '@/components/common/StatusBar'
import { scaleSizeH } from '@/utils/pixelRatio'
import { HEADER_HEIGHT } from '@/config/constant'
import commonState from '@/store/common/state'
import { navigations } from '@/navigation'

// 抽屉拆掉后顶栏只剩标题 + 右侧一个动作：
// 「首页」是搜索（推入搜索页），「我的」是设置（推入设置页）。
// 原来的搜索类型切换器跟着搜索页一起走了，不再挂在顶栏上。
const Header = () => {
  const theme = useTheme()
  const t = useI18n()
  const id = useNavActiveId()
  const statusBarHeight = useStatusbarHeight()

  const openSearch = useCallback(() => {
    navigations.pushSearchScreen(commonState.componentIds.home!)
  }, [])
  const openSetting = useCallback(() => {
    navigations.pushSettingScreen(commonState.componentIds.home!)
  }, [])

  const isHome = id != 'nav_mine'

  return (
    <>
      <StatusBar />
      <View style={{
        ...styles.container,
        height: scaleSizeH(HEADER_HEIGHT) + statusBarHeight,
        paddingTop: statusBarHeight,
      }}>
        <View style={styles.left}>
          <Text style={styles.title} size={19}>{t(id)}</Text>
        </View>
        <TouchableOpacity style={styles.btn} onPress={isHome ? openSearch : openSetting}>
          <Icon name={isHome ? 'search-2' : 'menu'} color={theme['c-font']} size={20} />
        </TouchableOpacity>
      </View>
    </>
  )
}


const styles = createStyle({
  container: {
    paddingRight: 5,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  left: {
    flex: 1,
    flexDirection: 'row',
    paddingLeft: 5,
    alignItems: 'center',
    height: '100%',
  },
  btn: {
    width: HEADER_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
  },
  title: {
    paddingLeft: 14,
    paddingRight: 16,
  },
})

export default Header
