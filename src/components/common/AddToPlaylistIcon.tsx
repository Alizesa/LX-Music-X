import { View } from 'react-native'
import { scaleSizeW } from '@/utils/pixelRatio'

// 自绘方框的视觉尺寸收一档：字体图标是在一个 em 框里带留白画的，实心方框按同一个名义
// 尺寸画会显得更大更重，跟旁边的字形对不齐。0.86 是照着 18 号那一档比出来的
const VISUAL_SCALE = 0.86
// 线宽（外框和十字一样粗）按方框边长取比例，并夹住上下限，避免小尺寸糊成一坨、大尺寸太细
const STROKE_RATIO = 0.11
const STROKE_MIN = 1.2
const STROKE_MAX = 2.2
// 十字臂长（占方框边长）。两端离外框还有 (1-0.42)/2 - 线宽 的留白，所以不粘连
const ARM_RATIO = 0.42

/**
 * 「添加到歌单」的图标：小圆角方框，里面一个不挨着边框的十字（QQ 音乐那个样子）。
 *
 * 没用字体里那个 add-music 字形 —— 那是「音符 + 加号」，跟这个不是一回事。
 * 全部按边长等比算，换尺寸不变形。
 */
export default ({ size = 18, color }: {
  size?: number
  color: string
}) => {
  const box = scaleSizeW(size * VISUAL_SCALE)
  const stroke = Math.min(STROKE_MAX, Math.max(STROKE_MIN, box * STROKE_RATIO))
  const arm = box * ARM_RATIO

  return (
    <View
      style={{
        width: box,
        height: box,
        borderWidth: stroke,
        borderColor: color,
        borderRadius: box * 0.26,
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      {/* 十字：横条套竖条、各自里层居中，省得算绝对定位的偏移（那还得考虑边框占的宽度） */}
      <View
        style={{
          width: arm,
          height: stroke,
          backgroundColor: color,
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <View style={{ width: stroke, height: arm, backgroundColor: color }} />
      </View>
    </View>
  )
}
