import { View } from 'react-native'
import { scaleSizeW } from '@/utils/pixelRatio'

/**
 * 歌单收藏的开关图标：没收藏是「＋」，收藏了只剩「－」（QQ 音乐那个）。
 *
 * 两根细条画出来：横条常在，竖条按状态显示。竖条套在横条里层居中，
 * 所以不用算绝对定位的偏移（同 AddToPlaylistIcon 的做法）。
 */
export default ({ saved, size = 17, color }: {
  saved: boolean
  size?: number
  color: string
}) => {
  const box = scaleSizeW(size)
  const stroke = Math.max(1.2, box * 0.11)
  const arm = box * 0.94

  return (
    <View style={{ width: box, height: box, justifyContent: 'center', alignItems: 'center' }}>
      <View
        style={{
          width: arm,
          height: stroke,
          borderRadius: stroke / 2,
          backgroundColor: color,
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        {saved ? null : <View style={{ width: stroke, height: arm, borderRadius: stroke / 2, backgroundColor: color }} />}
      </View>
    </View>
  )
}
