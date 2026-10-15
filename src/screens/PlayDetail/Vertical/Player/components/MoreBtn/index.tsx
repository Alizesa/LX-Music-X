import { createStyle } from '@/utils/tools'
import { View } from 'react-native'
import CollectBtn from './CollectBtn'
import DesktopLyricBtn from './DesktopLyricBtn'
import CommentBtn from './CommentBtn'
import MoreMenuBtn from './MoreMenuBtn'

/**
 * 上层操作行：歌词 / 红心 / 评论 / 三点。
 * 循环模式、播放控件、播放列表在下面的 PlayRow 里 —— 参考图是上下两层。
 */
export default () => {
  return (
    <View style={styles.container}>
      <DesktopLyricBtn />
      <CollectBtn />
      <CommentBtn />
      <MoreMenuBtn />
    </View>
  )
}


const styles = createStyle({
  container: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
  },
})
