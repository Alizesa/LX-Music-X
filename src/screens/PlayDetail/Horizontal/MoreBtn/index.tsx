import { createStyle } from '@/utils/tools'
import { View } from 'react-native'
import PlayModeBtn from './PlayModeBtn'
import CollectBtn from './CollectBtn'
import TimeoutExitBtn from './TimeoutExitBtn'

export default () => {
  return (
    <View style={styles.container}>
      <TimeoutExitBtn />
      <CollectBtn />
      <PlayModeBtn />
    </View>
  )
}


const styles = createStyle({
  container: {
    flexShrink: 0,
    flexGrow: 0,
    flexDirection: 'column',
    alignItems: 'center',
    // backgroundColor: 'rgba(0,0,0,0.1)',
    justifyContent: 'center',
    position: 'absolute',
    height: '100%',
    left: 0,
    gap: 16,
    zIndex: 1,
  },
})
