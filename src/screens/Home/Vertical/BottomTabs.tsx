import { TouchableOpacity, View } from 'react-native'
import Text from '@/components/common/Text'
import { Icon } from '@/components/common/Icon'
import { createStyle } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'

export type HomeTab = 'home' | 'mine'

// 图标字体里没有人物字形（全字体只有 52 个字形，也没有 user/account），
// 「我的」这一栏暂时用 logo 顶着；要更贴近参考图需要往 src/resources/fonts 里补字形。
const tabs = [
  { id: 'home', icon: 'home', label: 'home_tab_home' },
  { id: 'mine', icon: 'logo', label: 'home_tab_mine' },
] as const

export default ({ active, onTabChange }: { active: HomeTab, onTabChange: (tab: HomeTab) => void }) => {
  const theme = useTheme()
  const t = useI18n()

  return (
    <View style={{ ...styles.tabs, backgroundColor: theme['c-content-background'] }}>
      {tabs.map(({ id, icon, label }) => {
        const color = active === id ? theme['c-primary'] : theme['c-font-label']
        return (
          <TouchableOpacity key={id} style={styles.tab} onPress={() => { onTabChange(id) }}>
            <Icon name={icon} color={color} size={22} />
            <Text size={12} color={color}>{t(label)}</Text>
          </TouchableOpacity>
        )
      })}
    </View>
  )
}

const styles = createStyle({
  tabs: { height: 56, flexDirection: 'row', borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,.06)' },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2 },
})
