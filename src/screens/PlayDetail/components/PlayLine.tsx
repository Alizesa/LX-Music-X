import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { type NativeScrollEvent, type NativeSyntheticEvent, View, TouchableOpacity, Animated } from 'react-native'
import Text from '@/components/common/Text'
import { createStyle } from '@/utils/tools'
import { type Lines } from 'lrc-file-parser'
import { useTheme } from '@/store/theme/hook'
import { BorderWidths } from '@/theme'
import { formatPlayTime2 } from '@/utils'
import { Icon } from '@/components/common/Icon'


export interface LyricLineFrame {
  y: number
  height: number
}
interface LyricLayoutInfo {
  lineFrames: ReadonlyMap<number, LyricLineFrame>
}
const validFrame = (frame: LyricLineFrame | undefined): frame is LyricLineFrame =>
  frame != null && Number.isFinite(frame.y) && Number.isFinite(frame.height) && frame.height > 0

const seekTime = (lines: Lines, layout: LyricLayoutInfo, scroll: NativeScrollEvent | null): number | null => {
  if (!scroll || !lines.length) return null
  const offset = scroll.contentOffset.y + scroll.layoutMeasurement.height * 0.4
  if (!Number.isFinite(offset)) return null
  let target: number | null = null
  for (const [index, frame] of layout.lineFrames) {
    if (!lines[index] || !validFrame(frame) || offset < frame.y || offset >= frame.y + frame.height) continue
    // 重排期间旧、新坐标重叠时先等待布局确认，不猜测跳转目标。
    if (target != null) return null
    target = index
  }
  if (target == null) {
    const first = layout.lineFrames.get(0)
    const last = layout.lineFrames.get(lines.length - 1)
    if (validFrame(first) && offset < first.y) target = 0
    else if (validFrame(last) && offset >= last.y + last.height) target = lines.length - 1
    else return null
  }
  const time = lines[target].time
  return Number.isFinite(time) && time >= 0 ? time : null
}

export interface PlayLineType {
  updateScrollInfo: (scrollInfo: NativeSyntheticEvent<NativeScrollEvent>['nativeEvent'] | null) => void
  updateLayoutInfo: (listLayoutInfo: LyricLayoutInfo) => void
  updateLyricLines: (lyricLines: Lines) => void
  setVisible: (visible: boolean) => void
}

export interface PlayLineProps {
  onPlayLine: (time: number) => void
}

const ANIMATION_DURATION = 300

export default forwardRef<PlayLineType, PlayLineProps>(({ onPlayLine }, ref) => {
  const theme = useTheme()
  const [scrollInfo, setScrollInfo] = useState<NativeSyntheticEvent<NativeScrollEvent>['nativeEvent'] | null>(null)
  const [listLayoutInfo, setListLayoutInfo] = useState<LyricLayoutInfo>(() => ({ lineFrames: new Map() }))
  const [lyricLines, setLyricLines] = useState<Lines>([])
  const [visible, setVisible] = useState(false)
  const latest = useRef({ scrollInfo, listLayoutInfo, lyricLines, visible })
  const visibilityVersion = useRef(0)
  const frame = useRef<number | null>(null)
  const animation = useRef<ReturnType<typeof Animated.timing> | null>(null)
  const opsAnim = useRef<Animated.Value>(
    new Animated.Value(0),
  ).current

  useEffect(() => () => {
    visibilityVersion.current++
    if (frame.current != null) cancelAnimationFrame(frame.current)
    animation.current?.stop()
    latest.current = { scrollInfo: null, listLayoutInfo: { lineFrames: new Map() }, lyricLines: [], visible: false }
  }, [])

  const setShow = (visible: boolean, version: number) => {
    animation.current = Animated.timing(opsAnim, {
      toValue: visible ? 1 : 0,
      duration: ANIMATION_DURATION,
      useNativeDriver: true,
    })
    animation.current.start(() => {
      if (!visible && version === visibilityVersion.current) setVisible(false)
    })
  }

  useImperativeHandle(ref, () => ({
    updateScrollInfo(scrollInfo) {
      latest.current.scrollInfo = scrollInfo
      setScrollInfo(scrollInfo)
    },
    updateLayoutInfo(listLayoutInfo) {
      // Map 随行布局增量更新；用小快照触发静止指示线重绘。
      const layout = { lineFrames: listLayoutInfo.lineFrames }
      latest.current.listLayoutInfo = layout
      if (latest.current.visible) setListLayoutInfo(layout)
    },
    updateLyricLines(lyricLines) {
      if (latest.current.lyricLines !== lyricLines) {
        latest.current.listLayoutInfo = { lineFrames: new Map() }
        setListLayoutInfo(latest.current.listLayoutInfo)
      }
      latest.current.lyricLines = lyricLines
      setLyricLines(lyricLines)
    },
    setVisible(visible) {
      latest.current.visible = visible
      const version = ++visibilityVersion.current
      if (frame.current != null) cancelAnimationFrame(frame.current)
      animation.current?.stop()
      if (visible) {
        setListLayoutInfo(latest.current.listLayoutInfo)
        setScrollInfo(latest.current.scrollInfo)
        setVisible(true)
      }
      frame.current = requestAnimationFrame(() => {
        frame.current = null
        if (version === visibilityVersion.current) setShow(visible, version)
      })
    },
  }))

  const handlePlayLine = () => {
    const current = latest.current
    if (!current.visible || current.lyricLines !== lyricLines) return
    const time = seekTime(current.lyricLines, current.listLayoutInfo, current.scrollInfo)
    if (time != null) onPlayLine(time / 1000)
  }

  if (!scrollInfo || !visible) return null
  const time = seekTime(lyricLines, listLayoutInfo, scrollInfo)
  const timeLabel = time == null ? '--:--' : formatPlayTime2(time / 1000)
  return (
    <Animated.View style={{ ...styles.playLine, opacity: opsAnim }}>
      <Text style={styles.label} color={theme['c-primary-font']} size={13}>{timeLabel}</Text>
      <View style={styles.lineContent}>
        <View style={{ ...styles.line, borderBottomColor: theme['c-primary-alpha-700'] }} />
        <TouchableOpacity style={[styles.button, { opacity: time == null ? 0.4 : 1 }]} disabled={time == null} onPress={handlePlayLine}>
          <Icon name="play" color={theme['c-button-font']} size={18} />
        </TouchableOpacity>
      </View>
    </Animated.View>
  )
})

const styles = createStyle({
  playLine: {
    position: 'absolute',
    width: '100%',
    top: '40%',
    left: 0,
    height: 2,
    // paddingTop: 5,
    // paddingBottom: 5,
    // backgroundColor: 'rgba(0,0,0,0.1)',
  },
  label: {
    position: 'absolute',
    right: 45,
    bottom: 3,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  lineContent: {
    // backgroundColor: 'rgba(0,0,0,0.1)',
    position: 'absolute',
    width: '100%',
    height: 20,
    top: -10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  line: {
    marginLeft: 30,
    borderBottomWidth: BorderWidths.normal2,
    borderStyle: 'dashed',
    flex: 1,
  },
  button: {
    flex: 0,
    paddingLeft: 5,
    paddingRight: 15,
  },
})
