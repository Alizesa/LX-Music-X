import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { findNodeHandle, type FlatList, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import { type Line } from '@/plugins/lyric'
import playerState from '@/store/player/state'
import { useScreenVisible } from '@/utils/hooks/useScreenVisible'
import { stopScrollAnimation, supportsScrollAnimationCancellation } from '@/utils/nativeModules/utils'
import { type PlayLineType } from './PlayLine'
import { createLyricScroll } from './lyricScroll'

export const useLyricScroll = (lyricLines: Line[], line: number, showProgress: boolean) => {
  const visible = useScreenVisible()
  const flatListRef = useRef<FlatList<Line>>(null)
  const playLineRef = useRef<PlayLineType>(null)
  const scrollInfoRef = useRef<NativeScrollEvent | null>(null)
  const layoutRef = useRef({ spaceHeight: 0, lineHeights: [] as number[] })
  const linesRef = useRef(lyricLines)
  const [positionedLines, setPositionedLines] = useState<Line[] | null>(null)
  const controller = useMemo(() => createLyricScroll({
    getList: () => flatListRef.current,
    isPlaying: () => playerState.isPlay,
    onPositioned: setPositionedLines,
    onManualChange: manual => { playLineRef.current?.setVisible(manual) },
    // 旧 APK 缺少取消接口时只用即时定位，避免启动无法取消的原生动画。
    canAnimate: supportsScrollAnimationCancellation,
    stopScrollAnimation: async() => {
      const scrollView = flatListRef.current?.getNativeScrollRef()
      const viewTag = scrollView ? findNodeHandle(scrollView) : null
      if (viewTag != null) await stopScrollAnimation(viewTag)
    },
  }), [])

  useLayoutEffect(() => {
    if (linesRef.current !== lyricLines) {
      layoutRef.current.lineHeights = []
      linesRef.current = lyricLines
    }
    playLineRef.current?.updateLyricLines(lyricLines)
    controller.update({ lines: lyricLines, line, visible })
  }, [controller, line, lyricLines, visible])

  useLayoutEffect(() => () => { controller.dispose() }, [controller])

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      playLineRef.current?.updateLayoutInfo(layoutRef.current)
      playLineRef.current?.updateLyricLines(lyricLines)
      playLineRef.current?.updateScrollInfo(scrollInfoRef.current)
      if (controller.isManual()) playLineRef.current?.setVisible(true)
    })
    return () => { cancelAnimationFrame(frame) }
  }, [controller, lyricLines, showProgress])

  const handleScroll = useCallback(({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollInfoRef.current = nativeEvent
    controller.scrolled(nativeEvent.contentOffset.y)
    if (controller.isManual()) playLineRef.current?.updateScrollInfo(nativeEvent)
  }, [controller])

  const handleLineLayout = useCallback((lineNum: number, height: number) => {
    layoutRef.current.lineHeights[lineNum] = height
    playLineRef.current?.updateLayoutInfo(layoutRef.current)
    controller.lineMeasured(lineNum)
  }, [controller])

  const handleSpaceLayout = useCallback(({ nativeEvent }: LayoutChangeEvent) => {
    layoutRef.current.spaceHeight = nativeEvent.layout.height
    playLineRef.current?.updateLayoutInfo(layoutRef.current)
    controller.setHeaderHeight(nativeEvent.layout.height)
  }, [controller])

  const handleLayout = useCallback(({ nativeEvent }: LayoutChangeEvent) => {
    controller.setViewport(nativeEvent.layout.height, nativeEvent.layout.width)
  }, [controller])

  const handlePlayLine = useCallback((time: number) => {
    controller.seek()
    global.app_event.setProgress(time)
  }, [controller])

  return {
    flatListRef,
    playLineRef,
    ready: !lyricLines.length || positionedLines === lyricLines,
    handleScroll,
    handleLineLayout,
    handleSpaceLayout,
    handleLayout,
    handlePlayLine,
    handleScrollBeginDrag: controller.beginDrag,
    handleScrollEndDrag: controller.endDrag,
    handleMomentumScrollBegin: controller.beginMomentum,
    handleMomentumScrollEnd: controller.endMomentum,
    handleScrollToIndexFailed: controller.scrollToIndexFailed,
    handleContentSizeChange: controller.contentSizeChanged,
  }
}
