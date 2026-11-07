import { TouchableOpacity, View } from 'react-native'
import { IconIonicons } from '@/components/common/Icon'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { useNavActiveId, useStatusbarHeight } from '@/store/common/hook'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'
import { scaleSizeW } from '@/utils/pixelRatio'
import { TABLET_RAIL_WIDTH } from '@/utils/layout'
import { setNavActiveId } from '@/core/common'
import { type NAV_ID_Type } from '@/config/constant'

/**
 * 平板横屏首页/我的两页的左侧导航条，替代底部 tab。
 * 只挂在首页这一层；搜索、设置、歌单详情这些推入页保持手机竖屏的结构，不带导航条。
 */
const RailItem = ({ icon, outlineIcon, label, active, onPress }: {
  icon: 'home' | 'person'
  outlineIcon: 'home-outline' | 'person-outline'
  label: string
  active: boolean
  onPress: () => void
}) => {
  const theme = useTheme()
  const color = active ? theme['c-primary-font'] : theme['c-font-label']

  return (
    <TouchableOpacity style={styles.item} activeOpacity={0.7} onPress={onPress}>
      <IconIonicons name={active ? icon : outlineIcon} size={scaleSizeW(23)} color={color} />
      <Text style={styles.label} size={10} color={color} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  )
}

export default () => {
  const theme = useTheme()
  const t = useI18n()
  const statusBarHeight = useStatusbarHeight()
  const activeId = useNavActiveId()

  const switchTab = (id: NAV_ID_Type) => {
    if (id != activeId) setNavActiveId(id)
  }

  return (
    <View style={{
      ...styles.container,
      width: TABLET_RAIL_WIDTH,
      paddingTop: statusBarHeight + 10,
      backgroundColor: theme['c-content-background'],
      borderRightColor: theme['c-border-background'],
    }}>
      <RailItem
        icon="home"
        outlineIcon="home-outline"
        label={t('nav_home')}
        active={activeId == 'nav_home'}
        onPress={() => { switchTab('nav_home') }}
      />
      <View style={styles.spacer} />
      <RailItem
        icon="person"
        outlineIcon="person-outline"
        label={t('nav_mine')}
        active={activeId == 'nav_mine'}
        onPress={() => { switchTab('nav_mine') }}
      />
    </View>
  )
}

const styles = createStyle({
  container: {
    height: '100%',
    paddingBottom: 20,
    alignItems: 'center',
    borderRightWidth: 1,
  },
  item: {
    width: '100%',
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    marginTop: 3,
  },
  spacer: {
    flex: 1,
  },
})
