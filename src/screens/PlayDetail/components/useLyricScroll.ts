import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { findNodeHandle, type FlatList, type LayoutChangeEvent, type LayoutRectangle, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import { type Line } from '@/plugins/lyric'
import playerState from '@/store/player/state'
import { useScreenVisible } from '@/utils/hooks/useScreenVisible'
import { stopScrollAnimation, supportsScrollAnimationCancellation } from '@/utils/nativeModules/utils'
import { type LyricLineFrame, type PlayLineType } from './PlayLine'
import { createLyricScroll } from './lyricScroll'

const EMPTY_LINES: Line[] = []

// Controller 回调在独立作用域创建，不能保留首次 hook 调用的整份歌词参数。
const createScrollController = (
  flatList: { current: FlatList<Line> | null },
  playLine: { current: PlayLineType | null },
  onPositioned: (lines: Line[] | null) => void,
) => createLyricScroll({
  getList: () => flatList.current,
  isPlaying: () => playerState.isPlay,
  onPositioned,
  onManualChange: manual => { playLine.current?.setVisible(manual) },
  canAnimate: supportsScrollAnimationCancellation,
  stopScrollAnimation: async() => {
    const scrollView = flatList.current?.getNativeScrollRef()
    const viewTag = scrollView ? findNodeHandle(scrollView) : null
    if (viewTag != null) await stopScrollAnimation(viewTag)
  },
})

export const useLyricScroll = (lyricLines: Line[], line: number, showProgress: boolean) => {
  const visible = useScreenVisible()
  const flatListRef = useRef<FlatList<Line>>(null)
  const playLineRef = useRef<PlayLineType>(null)
  const scrollInfoRef = useRef<NativeScrollEvent | null>(null)
  const layoutRef = useRef({ lineFrames: new Map<number, LyricLineFrame>() })
  const linesRef = useRef(lyricLines)
  const layoutId = useMemo(() => Symbol(`lyric-layout:${visible}:${lyricLines.length}`), [lyricLines, visible])
  const activeLayout = useRef<symbol | null>(null)
  const [positionedLines, setPositionedLines] = useState<Line[] | null>(null)
  // 切换布局/显隐时替换事件回调所属作用域，释放首次渲染的歌词上下文。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const controller = useMemo(() => createScrollController(flatListRef, playLineRef, setPositionedLines), [lyricLines, visible])

  useLayoutEffect(() => () => {
    activeLayout.current = null
    linesRef.current = EMPTY_LINES
    layoutRef.current.lineFrames.clear()
    scrollInfoRef.current = null
    controller.dispose()
  }, [controller])

  useLayoutEffect(() => {
    activeLayout.current = visible ? layoutId : null
    const lines = visible ? lyricLines : EMPTY_LINES
    if (!visible || linesRef.current !== lines) {
      layoutRef.current.lineFrames.clear()
      scrollInfoRef.current = null
      playLineRef.current?.updateScrollInfo(null)
      setPositionedLines(null)
    }
    linesRef.current = lines
    playLineRef.current?.updateLyricLines(lines)
    playLineRef.current?.updateLayoutInfo(layoutRef.current)
    // 重新订阅时等待当前位置校准，避免先显示第 0 行再跳到当前句。
    controller.update({ lines, line, visible: visible && line >= 0 })
  }, [controller, line, lyricLines, visible, layoutId])

  useEffect(() => {
    if (!visible) return
    const frame = requestAnimationFrame(() => {
      playLineRef.current?.updateLyricLines(lyricLines)
      playLineRef.current?.updateLayoutInfo(layoutRef.current)
      playLineRef.current?.updateScrollInfo(scrollInfoRef.current)
      if (controller.isManual()) playLineRef.current?.setVisible(true)
    })
    return () => { cancelAnimationFrame(frame) }
  }, [controller, lyricLines, showProgress, visible])

  const handleScroll = useCallback(({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollInfoRef.current = nativeEvent
    controller.scrolled(nativeEvent.contentOffset.y)
    if (controller.isManual()) playLineRef.current?.updateScrollInfo(nativeEvent)
  }, [controller])

  const handleCellLayout = useCallback((lineNum: number, item: Line, layout: LayoutRectangle) => {
    if (activeLayout.current !== layoutId || linesRef.current[lineNum] !== item) return
    layoutRef.current.lineFrames.set(lineNum, { y: layout.y, height: layout.height })
    playLineRef.current?.updateLayoutInfo(layoutRef.current)
    controller.lineMeasured(lineNum)
  }, [controller, layoutId])

  const handleCellUnmount = useCallback((lineNum: number, item: Line) => {
    if (activeLayout.current !== layoutId || linesRef.current[lineNum] !== item) return
    layoutRef.current.lineFrames.delete(lineNum)
    playLineRef.current?.updateLayoutInfo(layoutRef.current)
  }, [layoutId])

  const handleSpaceLayout = useCallback(({ nativeEvent }: LayoutChangeEvent) => {
    controller.setHeaderHeight(nativeEvent.layout.height)
  }, [controller])

  const handleLayout = useCallback(({ nativeEvent }: LayoutChangeEvent) => {
    controller.setViewport(nativeEvent.layout.height, nativeEvent.layout.width)
    if (scrollInfoRef.current) {
      scrollInfoRef.current = {
        ...scrollInfoRef.current,
        layoutMeasurement: { height: nativeEvent.layout.height, width: nativeEvent.layout.width },
      }
      if (controller.isManual()) playLineRef.current?.updateScrollInfo(scrollInfoRef.current)
    }
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
    handleCellLayout,
    handleCellUnmount,
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
