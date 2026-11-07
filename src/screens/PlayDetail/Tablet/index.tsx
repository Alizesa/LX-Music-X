import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { FlatList, StyleSheet, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import Image from '@/components/common/Image'
import Text from '@/components/common/Text'
import { NAV_SHEAR_NATIVE_IDS } from '@/config/constant'
import { pop } from '@/navigation'
import { useStatusbarHeight } from '@/store/common/hook'
import { usePlayerMusicInfo } from '@/store/player/hook'
import { useTheme } from '@/store/theme/hook'
import { useWindowSize } from '@/utils/hooks'
import { useScreenVisible, VisibilityBoundary } from '@/utils/hooks/useScreenVisible'
import { screenkeepAwake, screenUnkeepAwake } from '@/utils/nativeModules/utils'
import SettingPopup, { type SettingPopupType } from '../components/SettingPopup'
import Lyric from '../Horizontal/Lyric'
import Player from '../Vertical/Player'
import Singer from '../Vertical/Singer'
import Btn, { HEADER_HEIGHT } from '../Vertical/components/Btn'
import TimeoutExitBtn from '../Vertical/components/TimeoutExitBtn'
import { PLAY_DETAIL_PAGES as PAGES, type PlayDetailPage as Page, type PlayDetailPagerProps } from '../page'

const getPageKey = (page: Page) => page

const Artwork = memo(() => {
  const { pic } = usePlayerMusicInfo()
  const windowSize = useWindowSize()
  const [bounds, setBounds] = useState<{ width: number, height: number } | null>(null)
  const handleLayout = useCallback(({ nativeEvent: { layout } }: LayoutChangeEvent) => {
    setBounds(previous => previous?.width === layout.width && previous.height === layout.height
      ? previous
      : { width: layout.width, height: layout.height })
  }, [])
  // 按实际剩余空间缩放，让封面为标题和播放控件留出空间。
  const size = Math.max(0, Math.floor(Math.min(440,
    bounds?.width ?? windowSize.width * 0.32,
    bounds?.height ?? windowSize.height * 0.45,
  )))

  return (
    <View style={styles.artwork} onLayout={handleLayout}>
      <Image url={pic} nativeID={NAV_SHEAR_NATIVE_IDS.playDetail_pic} style={{ width: size, height: size, borderRadius: 8 }} />
    </View>
  )
})

/** 三页共用一个滑动容器，每页半屏：歌手＋封面 ⇄ 封面＋歌词。 */
export default memo(({ componentId, initialPage, onPageChange }: PlayDetailPagerProps) => {
  const theme = useTheme()
  const musicInfo = usePlayerMusicInfo()
  const statusBarHeight = useStatusbarHeight()
  const visible = useScreenVisible()
  const popupRef = useRef<SettingPopupType>(null)
  const pagerRef = useRef<FlatList<Page>>(null)
  const windowSize = useWindowSize()
  const [viewportWidth, setViewportWidth] = useState(windowSize.width * 0.92)
  const pageWidth = viewportWidth / 2
  const initialFirstPage = useRef(initialPage === 'singer' ? 0 : 1).current
  const [firstPage, setFirstPage] = useState(initialFirstPage)
  const firstPageRef = useRef(initialFirstPage)
  const initialOffset = useRef({ x: pageWidth * initialFirstPage, y: 0 })
  const aligning = useRef(true)
  const alignFrame = useRef<number | null>(null)
  const lyricVisible = firstPage === 1

  const cancelAlignment = useCallback(() => {
    if (alignFrame.current != null) cancelAnimationFrame(alignFrame.current)
    alignFrame.current = null
  }, [])
  const alignPager = useCallback(() => {
    if (!aligning.current || pageWidth <= 0) return
    cancelAlignment()
    alignFrame.current = requestAnimationFrame(() => {
      alignFrame.current = null
      pagerRef.current?.scrollToOffset({ offset: firstPageRef.current * pageWidth, animated: false })
    })
  }, [cancelAlignment, pageWidth])

  useLayoutEffect(() => {
    // 旋转或调整窗口尺寸时按页重新定位，保留当前显示的那一对页面。
    aligning.current = true
    alignPager()
    return cancelAlignment
  }, [alignPager, cancelAlignment])

  const handleViewportLayout = useCallback(({ nativeEvent: { layout } }: LayoutChangeEvent) => {
    if (layout.width <= 0 || layout.width === viewportWidth) return
    aligning.current = true
    setViewportWidth(layout.width)
  }, [viewportWidth])
  const handleScroll = useCallback(({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (pageWidth <= 0) return
    // 窗口变化时先忽略尚未匹配页宽的滚动事件，避免把原生的位置修正当成翻页。
    if (Math.abs(nativeEvent.layoutMeasurement.width - viewportWidth) > 1) return
    const offset = nativeEvent.contentOffset.x
    // 初次布局可能先报告 0；真正定位完成前不能把未展示的歌手页当成可见。
    if (aligning.current) {
      if (Math.abs(offset - firstPageRef.current * pageWidth) > 1) return
      aligning.current = false
    }
    const next = Math.max(0, Math.min(1, Math.round(offset / pageWidth)))
    if (next === firstPageRef.current) return
    firstPageRef.current = next
    setFirstPage(next)
    // 只在真正换到另一对页面时更新记忆，恢复“封面＋歌词”不能覆盖原来的歌词页。
    onPageChange(next === 0 ? 'singer' : 'cover')
  }, [onPageChange, pageWidth, viewportWidth])
  const beginDrag = useCallback(() => {
    cancelAlignment()
    aligning.current = false
  }, [cancelAlignment])
  const enableSwipe = useCallback((enabled: boolean) => {
    pagerRef.current?.setNativeProps({ scrollEnabled: enabled })
  }, [])
  const lockSwipe = useCallback(() => { enableSwipe(false) }, [enableSwipe])
  const unlockSwipe = useCallback(() => { enableSwipe(true) }, [enableSwipe])

  useEffect(() => {
    if (!visible) unlockSwipe()
  }, [visible, unlockSwipe])

  useEffect(() => {
    if (!visible || !lyricVisible) return
    screenkeepAwake()
    return () => { screenUnkeepAwake() }
  }, [visible, lyricVisible])

  const back = () => { void pop(componentId) }
  const showSetting = () => { popupRef.current?.show() }

  return (
    <View style={[styles.container, { paddingTop: statusBarHeight }]}>
      <View style={[styles.header, { height: HEADER_HEIGHT }]} nativeID={NAV_SHEAR_NATIVE_IDS.playDetail_header}>
        <Btn icon="chevron-left" onPress={back} />
        <View style={styles.headerSpace} />
        <TimeoutExitBtn />
        <Btn icon="slider" onPress={showSetting} />
      </View>
      <View style={styles.viewport} onLayout={handleViewportLayout}>
        <FlatList
          ref={pagerRef}
          data={PAGES}
          horizontal
          style={styles.pager}
          contentContainerStyle={styles.pages}
          keyExtractor={getPageKey}
          extraData={firstPage}
          contentOffset={initialOffset.current}
          getItemLayout={(_, index) => ({ index, length: pageWidth, offset: index * pageWidth })}
          snapToOffsets={[0, pageWidth]}
          snapToAlignment="start"
          decelerationRate="fast"
          disableIntervalMomentum
          showsHorizontalScrollIndicator={false}
          bounces={false}
          overScrollMode="never"
          nestedScrollEnabled
          removeClippedSubviews={false}
          initialNumToRender={PAGES.length}
          windowSize={3}
          onScroll={handleScroll}
          scrollEventThrottle={32}
          onScrollBeginDrag={beginDrag}
          onScrollEndDrag={handleScroll}
          onMomentumScrollEnd={handleScroll}
          onContentSizeChange={alignPager}
          renderItem={({ item }) => {
            switch (item) {
              case 'singer':
                return (
                  <View style={[styles.page, { width: pageWidth }]}>
                    <Singer componentId={componentId} active={visible && firstPage === 0} />
                  </View>
                )
              case 'cover':
                return (
                  <View style={[styles.page, styles.coverPage, { width: pageWidth }]}>
                    <View style={styles.coverContent}>
                      <Artwork />
                      <View style={styles.trackInfo}>
                        <Text style={styles.title} size={23} numberOfLines={2}>{musicInfo.name}</Text>
                        <Text style={styles.singer} size={14} color={theme['c-font-label']} numberOfLines={1}>{musicInfo.singer}</Text>
                      </View>
                      <View onTouchStart={lockSwipe} onTouchEnd={unlockSwipe} onTouchCancel={unlockSwipe}>
                        <Player />
                      </View>
                    </View>
                  </View>
                )
              case 'lyric':
                return (
                  <View style={[styles.page, styles.lyricPage, { width: pageWidth }]}>
                    <VisibilityBoundary visible={lyricVisible}>
                      <Lyric />
                    </VisibilityBoundary>
                  </View>
                )
            }
          }}
        />
      </View>
      <SettingPopup ref={popupRef} direction="horizontal" position="right" />
    </View>
  )
})

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerSpace: {
    flex: 1,
  },
  viewport: {
    flex: 1,
    marginHorizontal: '4%',
    marginVertical: 12,
    overflow: 'hidden',
  },
  pager: {
    flex: 1,
  },
  pages: {
    height: '100%',
  },
  page: {
    height: '100%',
    paddingHorizontal: 16,
  },
  coverPage: {
    alignItems: 'center',
  },
  coverContent: {
    flex: 1,
    width: '100%',
    maxWidth: 480,
  },
  artwork: {
    flex: 1,
    minHeight: 0,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
    overflow: 'hidden',
  },
  trackInfo: {
    flexShrink: 0,
    paddingHorizontal: 18,
    paddingBottom: 24,
  },
  title: {
    fontWeight: '600',
  },
  singer: {
    marginTop: 10,
  },
  lyricPage: {
    paddingLeft: 24,
    paddingRight: 12,
    position: 'relative',
  },
})
