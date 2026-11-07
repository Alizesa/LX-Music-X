import { memo, useState, useRef, useMemo, useEffect } from 'react'
import { View } from 'react-native'

import Header from './components/Header'
// import Aside from './components/Aside'
// import Main from './components/Main'
import Player from './Player'
import PagerView, { type PagerViewOnPageSelectedEvent } from 'react-native-pager-view'
import Pic from './Pic'
import Lyric from './Lyric'
import Singer from './Singer'
import { screenkeepAwake, screenUnkeepAwake } from '@/utils/nativeModules/utils'
import { createStyle } from '@/utils/tools'
import { useScreenVisible, VisibilityBoundary } from '@/utils/hooks/useScreenVisible'
import { PLAY_DETAIL_PAGES, type PlayDetailPagerProps } from '../page'
// import { useTheme } from '@/store/theme/hook'

// 三页的顺序就是 PagerView 里子节点的顺序：歌手那页在封面左边（往右划才划得到），
// 封面仍然是打开播放详情页时停的那一页
const SINGER_PAGE = 0
const LYRIC_PAGE = 2

const LyricPage = ({ activeIndex }: { activeIndex: number }) => {
  const initedRef = useRef(false)
  const lyric = useMemo(() => <Lyric />, [])
  switch (activeIndex) {
    // case 3:
    case LYRIC_PAGE:
      if (!initedRef.current) initedRef.current = true
      return lyric
    default:
      return initedRef.current ? lyric : null
  }
  // return activeIndex == 0 || activeIndex == 1 ? setting : null
}

// global.iskeep = false
export default memo(({ componentId, initialPage, onPageChange }: PlayDetailPagerProps) => {
  // const theme = useTheme()
  const initialPageIndex = useRef(PLAY_DETAIL_PAGES.indexOf(initialPage)).current
  const [pageIndex, setPageIndex] = useState(initialPageIndex)
  const awaitingInitialPage = useRef(true)
  const visible = useScreenVisible()

  const onPageSelected = ({ nativeEvent }: PagerViewOnPageSelectedEvent) => {
    const page = PLAY_DETAIL_PAGES[nativeEvent.position]
    if (!page) return
    // 原生 pager 挂载时可能先报告第 0 页，等目标页就位后再更新记忆和订阅。
    if (awaitingInitialPage.current && nativeEvent.position !== initialPageIndex) return
    awaitingInitialPage.current = false
    setPageIndex(nativeEvent.position)
    onPageChange(page)
  }

  useEffect(() => {
    if (!visible || pageIndex !== LYRIC_PAGE) return
    screenkeepAwake()
    return () => { screenUnkeepAwake() }
  }, [visible, pageIndex])

  return (
    <>
      <Header />
      <View style={styles.container}>
        <PagerView
          onPageSelected={onPageSelected}
          onPageScrollStateChanged={event => {
            if (event.nativeEvent.pageScrollState === 'dragging') awaitingInitialPage.current = false
          }}
          initialPage={initialPageIndex}
          style={styles.pagerView}
        >
          <View key="singer" collapsable={false}>
            {/* 只有真翻到这一页才去搜（active）：PagerView 三页是一起挂上的，
                挂载就查等于每次打开播放详情页都白打一次接口 */}
            <Singer componentId={componentId} active={visible && pageIndex == SINGER_PAGE} />
          </View>
          <View key="pic" collapsable={false}>
            <Pic componentId={componentId} />
          </View>
          <View key="lyric" collapsable={false}>
            <VisibilityBoundary visible={pageIndex === LYRIC_PAGE}>
              <LyricPage activeIndex={pageIndex} />
            </VisibilityBoundary>
          </View>
        </PagerView>
        {/* <View style={styles.pageIndicator} nativeID={NAV_SHEAR_NATIVE_IDS.playDetail_pageIndicator}>
          <View style={{ ...styles.pageIndicatorItem, backgroundColor: pageIndex == 0 ? theme['c-primary-light-100-alpha-700'] : theme['c-primary-alpha-900'] }}></View>
          <View style={{ ...styles.pageIndicatorItem, backgroundColor: pageIndex == 1 ? theme['c-primary-light-100-alpha-700'] : theme['c-primary-alpha-900'] }}></View>
        </View> */}
        <Player />
      </View>
    </>
  )
})

const styles = createStyle({
  container: {
    flex: 1,
    flexDirection: 'column',
  },
  pagerView: {
    flex: 1,
  },
  // pageIndicator: {
  //   flex: 0,
  //   flexDirection: 'row',
  //   justifyContent: 'center',
  //   paddingTop: 10,
  //   // backgroundColor: 'rgba(0,0,0,0.1)',
  // },
  // pageIndicatorItem: {
  //   height: 3,
  //   width: '5%',
  //   marginLeft: 2,
  //   marginRight: 2,
  //   borderRadius: 2,
  // },
})
