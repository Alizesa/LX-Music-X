import { memo, useCallback } from 'react'
import { StyleSheet, TouchableOpacity, View } from 'react-native'
import { IconIonicons } from '@/components/common/Icon'
import Text from '@/components/common/Text'
import { NAV_MENUS, type NAV_ID_Type } from '@/config/constant'
import { setNavActiveId } from '@/core/common'
import { useI18n } from '@/lang'
import { useNavActiveId } from '@/store/common/hook'
import { useTheme } from '@/store/theme/hook'

type TabMenu = typeof NAV_MENUS[number]

const TabItem = ({ menu, active, onPress }: {
  menu: TabMenu
  active: boolean
  onPress: (id: NAV_ID_Type) => void
}) => {
  const theme = useTheme()
  const t = useI18n()
  const handlePress = useCallback(() => { onPress(menu.id) }, [menu.id, onPress])
  const color = active ? theme['c-primary-font'] : theme['c-font-label']

  return (
    <TouchableOpacity style={styles.item} activeOpacity={0.7} onPress={handlePress}>
      <IconIonicons
        name={active ? menu.icon : menu.outlineIcon}
        size={23 * global.lx.fontSize}
        color={color}
      />
      <Text style={styles.label} size={10} color={color} numberOfLines={1}>{t(menu.id)}</Text>
    </TouchableOpacity>
  )
}

export default memo(() => {
  const theme = useTheme()
  const activeId = useNavActiveId()

  const handlePress = useCallback((id: NAV_ID_Type) => {
    setNavActiveId(id)
  }, [])

  return (
    <View style={{ ...styles.container, backgroundColor: theme['c-content-background'], borderTopColor: theme['c-border-background'] }}>
      {
        NAV_MENUS.map(menu => (
          <TabItem key={menu.id} menu={menu} active={activeId == menu.id} onPress={handlePress} />
        ))
      }
    </View>
  )
})


// 导航控件使用 dp，只随应用字号缩放；分屏不能沿用全屏比例，更不能二次缩放高度。
const styles = StyleSheet.create({
  container: {
    width: '100%',
    height: 52 * global.lx.fontSize,
    flexGrow: 0,
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: 1,
  },
  item: {
    flex: 1,
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    marginTop: 2 * global.lx.fontSize,
  },
})
