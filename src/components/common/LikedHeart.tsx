import { View, type StyleProp, type TextStyle } from 'react-native'
import { Icon, IconIonicons } from '@/components/common/Icon'
import { useTheme } from '@/store/theme/hook'
import { scaleSizeW } from '@/utils/pixelRatio'

/**
 * 收藏的心形。没收藏就是普通描边色，收藏了换主题色 + 右下角叠一个小勾。
 *
 * 勾比心小一半、并且贴着心的右瓣（只往左挪一点、不探到图标框外），同色叠上去
 * 看着像连在一起的一个标识 —— 光靠心形颜色区分太不明显。
 * 列表行菜单和播放详情页那颗红心都用这个，两处保持一致。
 */
export default ({ liked, size = 18, color, style }: {
  liked: boolean
  size?: number
  /** 未收藏时的图标颜色，不给就用主题字色 */
  color?: string
  /** 透传给心形字形（播放详情页要用它加描边阴影） */
  style?: StyleProp<TextStyle>
}) => {
  const theme = useTheme()
  const markSize = scaleSizeW(size * 0.5)

  return (
    <View style={{ justifyContent: 'center', alignItems: 'center' }}>
      <Icon name="love" size={size} color={liked ? theme['c-primary-font'] : color ?? theme['c-font']} style={style} />
      {
        liked
          ? <View
              style={{
                position: 'absolute',
                // 往左、往上各收一点，让勾压在心形的右瓣上（不探到图标框外面）
                right: scaleSizeW(2),
                bottom: scaleSizeW(1),
                width: markSize,
                height: markSize,
                borderRadius: markSize / 2,
                backgroundColor: theme['c-primary-font'],
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <IconIonicons name="checkmark" size={markSize * 0.74} color={theme['c-content-background']} />
            </View>
          : null
      }
    </View>
  )
}
