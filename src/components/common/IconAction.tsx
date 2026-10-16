import { type ComponentProps, type ReactNode } from 'react'
import { TouchableOpacity } from 'react-native'
import { IconIonicons } from '@/components/common/Icon'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'
import { scaleSizeW } from '@/utils/pixelRatio'

/**
 * 小圆钮（卡片角上、板块标题右侧、头图角上都用它）。
 *
 * overlay：压在封面/头图上，用半透明黑底 + 白图标；不给就落在页面里，跟着主题色走、不加底色。
 * 图标可以直接给 Ionicons 的名字，也可以用 children 传自绘的（比如歌单收藏那个＋/－）。
 */
export default ({ icon, onPress, disabled, overlay, children }: {
  icon?: ComponentProps<typeof IconIonicons>['name']
  onPress: () => void
  disabled?: boolean
  overlay?: boolean
  children?: ReactNode
}) => {
  const theme = useTheme()
  return (
    <TouchableOpacity
      style={{
        ...styles.action,
        ...(overlay ? styles.actionOverlay : null),
        opacity: disabled ? 0.5 : 1,
      }}
      activeOpacity={0.7}
      disabled={disabled}
      onPress={onPress}
    >
      {
        children ?? (icon
          ? <IconIonicons
              name={icon}
              size={scaleSizeW(overlay ? 17 : 18)}
              color={overlay ? '#fff' : theme['c-font-label']}
            />
          : null)
      }
    </TouchableOpacity>
  )
}

const styles = createStyle({
  action: {
    width: scaleSizeW(30),
    height: scaleSizeW(30),
    borderRadius: scaleSizeW(15),
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionOverlay: {
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
})
