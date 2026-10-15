import { createStyle } from '@/utils/tools'
import { View } from 'react-native'
import ControlBtn from './ControlBtn'
import PlayModeBtn from './MoreBtn/PlayModeBtn'
import PlaylistBtn from './MoreBtn/PlaylistBtn'

/**
 * 下层播放行：循环模式 / 上一首·播放·下一首 / 播放列表。
 * 两侧按钮同宽（都用 MoreBtn 的 BTN_WIDTH），所以中间的播放控件仍然在正中。
 */
export default () => {
  return (
    <View style={styles.container}>
      <PlayModeBtn />
      <ControlBtn />
      <PlaylistBtn />
    </View>
  )
}

const styles = createStyle({
  container: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
  },
})
