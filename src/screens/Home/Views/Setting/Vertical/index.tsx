import { useRef } from 'react'
import { ScrollView, View } from 'react-native'
import NavList from './NavList'
import Main, { type MainType } from '../Main'
import { createStyle } from '@/utils/tools'
import { BorderWidths } from '@/theme'
import { useTheme } from '@/store/theme/hook'

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
    <ScrollView style={styles.main} keyboardShouldPersistTaps="always"><Main ref={mainRef} /></ScrollView>
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
