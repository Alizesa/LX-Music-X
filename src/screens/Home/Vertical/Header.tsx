import { View, TouchableOpacity } from 'react-native'
import { useTheme } from '@/store/theme/hook'
import { useNavActiveId, useStatusbarHeight } from '@/store/common/hook'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'
import { Icon } from '@/components/common/Icon'
import Text from '@/components/common/Text'
import StatusBar from '@/components/common/StatusBar'
import { scaleSizeH } from '@/utils/pixelRatio'
import { HEADER_HEIGHT } from '@/config/constant'
import { type InitState as CommonState } from '@/store/common/state'
import SearchTypeSelector from '@/screens/Home/Views/Search/SearchTypeSelector'

const headerComponents: Partial<Record<CommonState['navActiveId'], React.ReactNode>> = {
  nav_search: <SearchTypeSelector />,
}

/**
 * 旧功能页的标题栏。侧边栏移除后它不再承担导航入口，只做三件事：
 * 返回仪表盘、显示当前页面名、以及右边的「更多」面板。
 * 抽屉时代那套按 common.drawerLayoutPosition 左右分栏的布局一并去掉了。
 */
export default ({ onBack, onMenuPress }: { onBack: () => void, onMenuPress: () => void }) => {
  const theme = useTheme()
  const t = useI18n()
  const id = useNavActiveId()
  const statusBarHeight = useStatusbarHeight()

  return (
    <>
      <StatusBar />
      <View style={{
        ...styles.container,
        height: scaleSizeH(HEADER_HEIGHT) + statusBarHeight,
        paddingTop: statusBarHeight,
      }}>
        <TouchableOpacity style={styles.btn} onPress={onBack}>
          <Icon color={theme['c-font']} name="chevron-left" size={24} />
        </TouchableOpacity>
        <Text style={styles.title} size={18} numberOfLines={1}>{t(id)}</Text>
        {headerComponents[id] ?? null}
        <TouchableOpacity style={styles.btn} onPress={onMenuPress}>
          <Icon color={theme['c-font']} name="menu" size={20} />
        </TouchableOpacity>
      </View>
    </>
  )
}

const styles = createStyle({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    zIndex: 10,
  },
  btn: {
    width: HEADER_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
  },
  title: {
    flex: 1,
    paddingLeft: 4,
    paddingRight: 8,
  },
})
