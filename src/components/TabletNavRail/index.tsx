import { useCallback, type ComponentProps } from 'react'
import { TouchableOpacity, View } from 'react-native'
import { Icon, IconIonicons } from '@/components/common/Icon'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { useNavActiveId, useStatusbarHeight } from '@/store/common/hook'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'
import { scaleSizeW } from '@/utils/pixelRatio'
import { TABLET_RAIL_WIDTH } from '@/utils/layout'
import { setNavActiveId } from '@/core/common'
import commonState from '@/store/common/state'
import { navigations, popTo, popToRoot } from '@/navigation'
import { type NAV_ID_Type } from '@/config/constant'

/**
 * 平板横屏的左侧导航条，替代底部 tab。
 *
 * 推入页（搜索/歌单/设置……）盖在首页栈上面，点「首页/我的」时先 popToRoot
 * 再切 tab，否则只会改掉首页内部的状态，眼前还停在推入页。
 */
const RailItem = ({ icon, ionIcon, label, active, onPress }: {
  icon?: ComponentProps<typeof Icon>['name']
  ionIcon?: ComponentProps<typeof IconIonicons>['name']
  label: string
  active?: boolean
  onPress: () => void
}) => {
  const theme = useTheme()
  const color = active ? theme['c-primary-font'] : theme['c-font-label']

  return (
    <TouchableOpacity style={styles.item} activeOpacity={0.7} onPress={onPress}>
      {
        ionIcon
          ? <IconIonicons name={ionIcon} size={scaleSizeW(23)} color={color} />
          : icon ? <Icon name={icon} size={22} color={color} /> : null
      }
      <Text style={styles.label} size={10} color={color} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  )
}

export default ({ componentId }: { componentId?: string }) => {
  const theme = useTheme()
  const t = useI18n()
  const statusBarHeight = useStatusbarHeight()
  const activeId = useNavActiveId()

  const switchTab = useCallback((id: NAV_ID_Type) => {
    if (id != activeId) setNavActiveId(id)
    // 首页是栈底；在它上面压着推入页时，切 tab 要先把栈弹回首页。
    // 优先用当前页的 id 弹（RNN 会找到它所在的栈），拿不到再退回首页 id
    if (commonState.componentIds.home != componentId) {
      const target = componentId ?? commonState.componentIds.home
      if (target) void popToRoot(target)
    }
  }, [activeId, componentId])

  const openSearch = useCallback(() => {
    const searchId = commonState.componentIds.search
    // 搜索页可能还在详情页下面；返回原实例，保留搜索结果和滚动位置。
    if (searchId) {
      if (searchId != componentId) void popTo(searchId)
      return
    }
    const homeId = commonState.componentIds.home
    if (homeId) navigations.pushSearchScreen(homeId)
  }, [componentId])

  const openSetting = useCallback(() => {
    const settingId = commonState.componentIds.setting
    if (settingId) {
      if (settingId != componentId) void popTo(settingId)
      return
    }
    const homeId = commonState.componentIds.home
    if (homeId) navigations.pushSettingScreen(homeId)
  }, [componentId])

  return (
    <View style={{
      ...styles.container,
      width: TABLET_RAIL_WIDTH,
      paddingTop: statusBarHeight + 10,
      backgroundColor: theme['c-content-background'],
      borderRightColor: theme['c-border-background'],
    }}>
      <RailItem ionIcon={activeId == 'nav_home' ? 'home' : 'home-outline'} label={t('nav_home')} active={activeId == 'nav_home'} onPress={() => { switchTab('nav_home') }} />
      <RailItem icon="search-2" label={t('nav_search')} onPress={openSearch} />
      <View style={styles.spacer} />
      <RailItem ionIcon={activeId == 'nav_mine' ? 'person' : 'person-outline'} label={t('nav_mine')} active={activeId == 'nav_mine'} onPress={() => { switchTab('nav_mine') }} />
      <RailItem icon="menu" label={t('nav_setting')} onPress={openSetting} />
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
