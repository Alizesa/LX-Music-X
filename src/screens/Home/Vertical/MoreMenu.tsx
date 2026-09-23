import { forwardRef, useImperativeHandle, useRef } from 'react'
import { TouchableOpacity } from 'react-native'
import Popup, { type PopupType } from '@/components/common/Popup'
import { Icon } from '@/components/common/Icon'
import Text from '@/components/common/Text'
import { createStyle } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { NAV_MENUS } from '@/config/constant'
import { useNavActiveId } from '@/store/common/hook'
import type { InitState as CommonState } from '@/store/common/state'

export interface MoreMenuType {
  show: () => void
}

// 侧边栏移除后，原来由抽屉承载的入口统一收进这个「更多」面板。
// 用 Popup 而不是 Alert：Android 的 Alert 最多只显示 3 个按钮，
// 多出来的会被静默丢掉（react-native/Libraries/Alert/Alert.js 里 slice(0, 3)），
// 之前首页那个 5 项的 Alert 菜单就是这么丢掉「设置」和「取消」的。
const MoreMenu = forwardRef<MoreMenuType, { onOpen: (id: CommonState['navActiveId']) => void }>(({ onOpen }, ref) => {
  const theme = useTheme()
  const t = useI18n()
  const activeId = useNavActiveId()
  const popupRef = useRef<PopupType>(null)

  useImperativeHandle(ref, () => ({
    show() {
      popupRef.current?.setVisible(true)
    },
  }))

  const handlePress = (id: CommonState['navActiveId']) => {
    popupRef.current?.setVisible(false)
    onOpen(id)
  }

  return (
    <Popup ref={popupRef} title={t('home_more')}>
      {NAV_MENUS.map(({ id, icon }) => {
        const color = activeId === id ? theme['c-primary'] : theme['c-font-label']
        return (
          <TouchableOpacity key={id} style={styles.item} onPress={() => { handlePress(id) }}>
            <Icon name={icon} size={20} color={color} />
            <Text style={styles.label} color={color}>{t(id)}</Text>
          </TouchableOpacity>
        )
      })}
    </Popup>
  )
})

export default MoreMenu

const styles = createStyle({
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 14,
    paddingBottom: 14,
    paddingLeft: 25,
    paddingRight: 25,
  },
  label: {
    paddingLeft: 20,
  },
})
