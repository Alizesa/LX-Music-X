import { createStyle } from '@/utils/tools'
import { View } from 'react-native'
import PlayModeBtn from './PlayModeBtn'
import CollectBtn from './CollectBtn'
import DesktopLyricBtn from './DesktopLyricBtn'
import CommentBtn from './CommentBtn'
import PlaylistBtn from './PlaylistBtn'

export default () => {
  return (
    <View style={styles.container}>
      <DesktopLyricBtn />
      <CollectBtn />
      <PlayModeBtn />
      <CommentBtn />
      <PlaylistBtn />
    </View>
  )
}


const styles = createStyle({
  container: {
    // flexShrink: 0,
    // flexGrow: 0,
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    // backgroundColor: 'rgba(0,0,0,0.1)',
  },
})
