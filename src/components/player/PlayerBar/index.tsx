import { memo, useMemo } from 'react'
import { StyleSheet, View } from 'react-native'
import { useKeyboard, useTabletLayout } from '@/utils/hooks'

import Pic from './components/Pic'
import Title from './components/Title'
import PlayInfo from './components/PlayInfo'
import ControlBtn from './components/ControlBtn'
import { createStyle, setColorAlpha } from '@/utils/tools'
// import { useSettingValue } from '@/store/setting/hook'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'

const TABLET_BAR_HEIGHT = 60 * global.lx.fontSize
const TABLET_BAR_BOTTOM_GAP = 10
export const TABLET_PLAYER_BAR_INSET = TABLET_BAR_HEIGHT + TABLET_BAR_BOTTOM_GAP


export default memo(() => {
  // const { onLayout, ...layout } = useLayout()
  const { keyboardShown } = useKeyboard()
  const { isWide } = useTabletLayout()
  const theme = useTheme()
  const autoHidePlayBar = useSettingValue('common.autoHidePlayBar')
  // 背景单独调透明度（只作用在底色上，文字图标照旧不透明），调小就能透出后面的背景图
  const playBarOpacity = useSettingValue('theme.playBarOpacity')

  const playerComponent = useMemo(() => (
    <View style={[styles.container, isWide && tabletStyles.container, { backgroundColor: setColorAlpha(theme['c-content-background'], playBarOpacity) }]}>
      <Pic compact={isWide} />
      <View style={styles.center}>
        <Title />
        {/* <View style={{ ...styles.row, justifyContent: 'space-between' }}>
          <PlayTime />
        </View> */}
        <PlayInfo />
      </View>
      <View style={styles.right}>
        <ControlBtn compact={isWide} />
      </View>
    </View>
  ), [theme, playBarOpacity, isWide])

  // console.log('render pb')

  return autoHidePlayBar && keyboardShown ? null : playerComponent
})

// 平板只按字号缩放高度，避免整个播放条随屏幕比例一起变大。
const tabletStyles = StyleSheet.create({
  container: {
    alignSelf: 'center',
    width: '60%',
    maxWidth: 640,
    height: TABLET_BAR_HEIGHT,
    flexShrink: 0,
    marginHorizontal: 0,
    marginBottom: TABLET_BAR_BOTTOM_GAP,
    paddingVertical: 4 * global.lx.fontSize,
    paddingLeft: 4 * global.lx.fontSize,
  },
})


const styles = createStyle({
  container: {
    // 悬浮样式：左右和底部留出边距，四角都收圆，靠 elevation 浮在背景之上
    marginHorizontal: 8,
    marginBottom: 6,
    borderRadius: 10,
    paddingVertical: 5,
    paddingLeft: 5,
    flexDirection: 'row',
    alignItems: 'center',
    elevation: 10,
  },
  left: {
    // borderRadius: 3,
    flexGrow: 0,
    flexShrink: 0,
  },
  center: {
    flexDirection: 'column',
    flexGrow: 1,
    flexShrink: 1,
    paddingLeft: 5,
    height: '100%',
    // justifyContent: 'space-evenly',
    // height: 48,
    // backgroundColor: 'rgba(0, 0, 0, .1)',
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    flexGrow: 0,
    flexShrink: 0,
    paddingLeft: 5,
    paddingRight: 5,
  },
  // row: {
  //   flexDirection: 'row',
  //   flexGrow: 0,
  //   flexShrink: 0,
  // },
})
