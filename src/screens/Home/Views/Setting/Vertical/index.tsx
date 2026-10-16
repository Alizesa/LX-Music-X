import { useRef } from 'react'
import { ScrollView, View } from 'react-native'
import NavList from './NavList'
import Main, { type MainType } from '../Main'
import { createStyle } from '@/utils/tools'
import { scaleSizeH } from '@/utils/pixelRatio'
import { BorderWidths } from '@/theme'
import { useTheme } from '@/store/theme/hook'

// 播放条是浮在页面底上的（封面 46 + 上下内边距和外边距 ≈ 62），
// 设置内容底部留出这一段，最后一项才能滑到它上面
const PLAY_BAR_CLEARANCE = scaleSizeH(64)

const styles = createStyle({
  container: { flex: 1, flexDirection: 'row', borderTopWidth: BorderWidths.normal },
  nav: { height: '100%', width: '30%', borderRightWidth: BorderWidths.normal },
  main: { padding: 15, flex: 1 },
})

export default () => {
  const theme = useTheme()
  const mainRef = useRef<MainType>(null)
  return <View style={{ ...styles.container, borderTopColor: theme['c-border-background'] }}>
    <View style={{ ...styles.nav, borderRightColor: theme['c-border-background'] }}><NavList onChangeId={id => mainRef.current?.setActiveId(id)} /></View>
    {/* 底部留出播放条那一段（悬浮条：46 的封面 + 上下内边距 + 外边距），
        否则最后一两项贴着底边、滑不上来 */}
    <ScrollView style={styles.main} contentContainerStyle={{ paddingBottom: PLAY_BAR_CLEARANCE }} keyboardShouldPersistTaps="always"><Main ref={mainRef} /></ScrollView>
  </View>
}
// // import { View } from 'react-native'
// import Main from './Main'
// import { createStyle } from '@/utils/tools'


// const Content = () => {
//   return (
//     <View style={styles.container}>
//       <Main />
//     </View>
//   )
// }

// const styles = createStyle({
//   container: {
//     flex: 1,
//     flexDirection: 'column',
//   },
//   // main: {
//   //   paddingLeft: 15,
//   //   paddingRight: 15,
//   //   paddingTop: 15,
//   //   paddingBottom: 15,
//   // },
// })

// export default Content
