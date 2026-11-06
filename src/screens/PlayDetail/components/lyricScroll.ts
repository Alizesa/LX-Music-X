import { type Line } from '@/plugins/lyric'

interface ScrollList {
  scrollToIndex: (options: { index: number, animated: boolean, viewPosition: number }) => void
  scrollToOffset: (options: { offset: number, animated: boolean }) => void
}

interface Snapshot {
  lines: Line[]
  line: number
  visible: boolean
}

interface Request {
  lines: Line[]
  index: number
  animated: boolean
  stalledAttempts: number
  highestMeasuredIndex: number
  contentHeight: number
  furthestOffset: number
  waiting: boolean
  estimatedOffset: number | null
}

interface Options {
  getList: () => ScrollList | null
  isPlaying: () => boolean
  onPositioned: (lines: Line[]) => void
  onManualChange: (manual: boolean) => void
  canAnimate: boolean
  stopScrollAnimation: () => Promise<void>
}

const VIEW_POSITION = 0.42
const RETRY_DELAY = 80
const MAX_STALLED_ATTEMPTS = 8
const RESUME_DELAY = 3000

/** 横竖屏共用：只保留最新定位请求，首次定位完成前不显示从首行跳转的过程。 */
export const createLyricScroll = ({ getList, isPlaying, onPositioned, onManualChange, canAnimate, stopScrollAnimation }: Options) => {
  let snapshot: Snapshot = { lines: [], line: -1, visible: false }
  let positionedLines: Line[] | null = null
  let pending: Request | null = null
  let frame: number | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let resumeTimer: ReturnType<typeof setTimeout> | null = null
  let viewportHeight = 0
  let viewportWidth = 0
  let headerHeight = 0
  let contentHeight = 0
  let scrollOffset = 0
  let nativeAnimation = false
  let stoppingAnimation: Promise<boolean> | null = null
  let manual = false
  let disposed = false

  const targetIndex = () => Math.max(0, Math.min(snapshot.line, snapshot.lines.length - 1))
  const isCurrent = (request: Request) => !disposed && snapshot.visible && !manual &&
    pending === request && snapshot.lines === request.lines && targetIndex() === request.index

  const clearPositionTimer = () => {
    if (frame != null) cancelAnimationFrame(frame)
    if (retryTimer != null) clearTimeout(retryTimer)
    frame = null
    retryTimer = null
  }
  const cancelPosition = () => {
    clearPositionTimer()
    pending = null
    stopNativeAnimation()
  }
  const stopNativeAnimation = () => {
    if (!nativeAnimation || stoppingAnimation) return
    const stopping = stopScrollAnimation().then(() => {
      nativeAnimation = false
      return true
    }).catch((error: unknown) => {
      console.warn('[Lyric] stop scroll animation:', error)
      return false
    })
    stoppingAnimation = stopping
    void stopping.then(() => {
      if (stoppingAnimation === stopping) stoppingAnimation = null
    })
  }
  const clearResumeTimer = () => {
    if (resumeTimer != null) clearTimeout(resumeTimer)
    resumeTimer = null
  }
  const setManual = (value: boolean) => {
    if (manual === value) return
    manual = value
    onManualChange(value)
  }

  const finish = (request: Request) => {
    clearPositionTimer()
    request.waiting = false
    // 让原生先应用无动画的定位，再显示列表，避免露出估算位置。
    frame = requestAnimationFrame(() => {
      frame = null
      if (!isCurrent(request)) return
      pending = null
      positionedLines = request.lines
      onPositioned(request.lines)
    })
  }

  const retry = (request: Request) => {
    if (!isCurrent(request)) return
    request.waiting = true
    clearPositionTimer()
    if (++request.stalledAttempts >= MAX_STALLED_ATTEMPTS) {
      // 没有进展时停止轮询，但保留请求。后续布局/内容增长仍能恢复，暂停播放也一样。
      return
    }
    retryTimer = setTimeout(() => {
      retryTimer = null
      schedule(request)
    }, RETRY_DELAY)
  }

  const attempt = (request: Request) => {
    if (!isCurrent(request) || !viewportHeight) return
    const list = getList()
    if (!list) return
    request.waiting = false
    const animated = canAnimate && request.animated && request.estimatedOffset == null
    try {
      list.scrollToIndex({
        index: request.index,
        animated,
        viewPosition: VIEW_POSITION,
      })
      // onScrollToIndexFailed 由 FlatList 同步调用；失败后等待目标行布局。
      if (!request.waiting) {
        nativeAnimation = animated
        finish(request)
      }
    } catch {
      retry(request)
    }
  }

  const schedule = (request: Request) => {
    if (!isCurrent(request)) return
    clearPositionTimer()
    stopNativeAnimation()
    if (stoppingAnimation) {
      void stoppingAnimation.then(stopped => {
        if (!isCurrent(request)) return
        if (stopped) schedule(request)
        else request.waiting = true
      })
      return
    }
    frame = requestAnimationFrame(() => {
      frame = null
      attempt(request)
    })
  }

  const position = (animated: boolean) => {
    cancelPosition()
    if (disposed || !snapshot.visible || manual || !snapshot.lines.length) return
    const request: Request = {
      lines: snapshot.lines,
      index: targetIndex(),
      animated: animated && positionedLines === snapshot.lines,
      stalledAttempts: 0,
      highestMeasuredIndex: -1,
      contentHeight,
      furthestOffset: scrollOffset,
      waiting: false,
      estimatedOffset: null,
    }
    pending = request
    schedule(request)
  }

  const progress = (request: Request) => {
    request.stalledAttempts = 0
    if (request.waiting) schedule(request)
  }

  const endDrag = () => {
    if (!manual || !snapshot.visible || disposed) return
    clearResumeTimer()
    resumeTimer = setTimeout(() => {
      resumeTimer = null
      setManual(false)
      if (isPlaying()) position(true)
    }, RESUME_DELAY)
  }

  return {
    update(next: Snapshot) {
      const previous = snapshot
      if (!disposed && previous.lines === next.lines && previous.line === next.line && previous.visible === next.visible) return
      disposed = false
      snapshot = next
      cancelPosition()
      if (previous.lines !== next.lines || !next.visible) {
        clearResumeTimer()
        setManual(false)
      }
      // 首次进入、换歌词、切回页面及远距离跳转直接定位；正常换行用原生动画。
      const adjacent = previous.lines === next.lines && previous.visible && next.line === previous.line + 1
      position(adjacent)
    },
    setViewport(height: number, width: number) {
      if (height === viewportHeight && width === viewportWidth) return
      viewportHeight = height
      viewportWidth = width
      position(false)
    },
    setHeaderHeight(height: number) {
      if (headerHeight === height) return
      headerHeight = height
      position(false)
    },
    lineMeasured(index: number) {
      const request = pending
      if (!request || !isCurrent(request)) return
      if (index > request.highestMeasuredIndex) {
        request.highestMeasuredIndex = index
        progress(request)
      } else if (request.waiting && request.index === index) schedule(request)
    },
    contentSizeChanged: (_width: number, height: number) => {
      contentHeight = height
      const request = pending
      if (!request || !isCurrent(request) || height <= request.contentHeight + 1) return
      request.contentHeight = height
      progress(request)
    },
    scrolled(offset: number) {
      scrollOffset = offset
      const request = pending
      if (!request || !isCurrent(request) || offset <= request.furthestOffset + 1) return
      request.furthestOffset = offset
      progress(request)
    },
    scrollToIndexFailed: (info: { index: number, averageItemLength: number, highestMeasuredFrameIndex: number }) => {
      const request = pending
      if (!request || !isCurrent(request) || request.index !== info.index) return
      if (info.highestMeasuredFrameIndex > request.highestMeasuredIndex) {
        request.highestMeasuredIndex = info.highestMeasuredFrameIndex
        progress(request)
      }
      if (Number.isFinite(info.averageItemLength) && info.averageItemLength > 0) {
        // 把目标行直接带入渲染窗口，不再先跳到它前面 30 行再补一段动画。
        const offset = Math.max(0, headerHeight + info.averageItemLength * info.index -
          (viewportHeight - info.averageItemLength) * VIEW_POSITION)
        // Android 会把滚动截断到当前内容末尾；内容增长后即使估算值相同，也必须重发。
        request.estimatedOffset = offset
        getList()?.scrollToOffset({ offset, animated: false })
      }
      retry(request)
    },
    beginDrag: () => {
      clearResumeTimer()
      cancelPosition()
      setManual(true)
      // 用户接管滚动时立即展示当前位置，不再等待自动定位。
      positionedLines = snapshot.lines
      onPositioned(snapshot.lines)
    },
    endDrag,
    beginMomentum: () => {
      if (manual) clearResumeTimer()
    },
    endMomentum: endDrag,
    seek() {
      clearResumeTimer()
      cancelPosition()
      setManual(false)
    },
    isManual: () => manual,
    dispose() {
      disposed = true
      clearResumeTimer()
      cancelPosition()
    },
  }
}
