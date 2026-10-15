import { useRef } from 'react'
import { TouchableOpacity } from 'react-native'
import { IconIonicons } from '@/components/common/Icon'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'
import { scaleSizeW } from '@/utils/pixelRatio'
import { strongIconShadow } from '@/screens/PlayDetail/components/iconStyle'
import { BTN_WIDTH } from './Btn'
import MoreMenu, { type MoreMenuType } from '@/screens/PlayDetail/components/MoreMenu'

/**
 * 三点（点开从下方弹出功能页，内容见 PlayDetail/components/MoreMenu）。
 *
 * 图标用 Ionicons 的横向省略号：icomoon 里只有竖版的 dots-vertical，
 * 而参考图上是横的。按钮尺寸和阴影跟左右邻居保持一致。
 */
export default () => {
  const theme = useTheme()
  const moreMenuRef = useRef<MoreMenuType>(null)

  return (
    <>
      <TouchableOpacity
        style={{ ...styles.button, width: BTN_WIDTH, height: BTN_WIDTH }}
        activeOpacity={0.5}
        onPress={() => { moreMenuRef.current?.show() }}
      >
        <IconIonicons
          name="ellipsis-horizontal"
          size={scaleSizeW(20)}
          color={theme['c-font']}
          // @ts-expect-error 图标库自带一份 @types/react-native，和主工程的 TextStyle 对不上（Icon.tsx 里同样处理）
          style={strongIconShadow}
        />
      </TouchableOpacity>
      <MoreMenu ref={moreMenuRef} />
    </>
  )
}

const styles = createStyle({
  button: {
    marginLeft: 5,
    justifyContent: 'center',
    alignItems: 'center',
    shadowOpacity: 1,
    textShadowRadius: 1,
  },
})
