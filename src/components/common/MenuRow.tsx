import { type ReactNode } from 'react'
import { TouchableOpacity, View } from 'react-native'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'

/**
 * 底部弹出面板里的一行：图标 + 文案。
 *
 * 列表行的三点菜单和播放详情页的三点菜单共用这个，两处的行高、图标位、字号就不会走散。
 * icon 直接收节点而不是图标名 —— 有些行是自绘的（比如「添加到歌单」那个方框加号、
 * 收藏那颗带勾的心），传个 Icon / AddToPlaylistIcon / LikedHeart 进来就行。
 */
export default ({ icon, label, disabled, onPress }: {
  icon?: ReactNode
  label: string
  disabled?: boolean
  onPress: () => void
}) => {
  const theme = useTheme()
  return (
    <TouchableOpacity
      style={{ ...styles.row, borderBottomColor: theme['c-border-background'], opacity: disabled ? 0.4 : 1 }}
      activeOpacity={0.7}
      disabled={disabled}
      onPress={onPress}
    >
      {/* 图标位宽度固定：没有图标的行（「不喜欢」）也留着，各行文案才对得齐 */}
      <View style={styles.iconWrap}>{icon}</View>
      <Text size={15} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  )
}

const styles = createStyle({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  iconWrap: {
    width: 26,
    height: 20,
    justifyContent: 'center',
  },
})
