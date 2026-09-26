import { Children, forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { Animated, Easing, PanResponder, View } from 'react-native'
import { useLayout } from '@/utils/hooks'
import { createStyle } from '@/utils/tools'

// 手指移动超过这个距离才算横向滑动，免得和页面里的纵向列表抢手势
const SLOP = 8
// 松手时超过页面宽度的这个比例才翻页
const SWITCH_RATIO = 0.2
// 翻页动画时长
const DURATION = 250
// 到头了往回弹的时长。系统 PagerView 是原生动画，回弹几乎是一瞬间，
// 看着像“跳了一下”，这里故意放慢并且用缓出，弹回来是顺的
const REBOUND_DURATION = 380
// 滑到头之后手指还能带动页面的比例（0 = 完全不动）
const EDGE_RESISTANCE = 0.3
// 到头之后最多能被带动多少页宽
const EDGE_MAX_RATIO = 0.25
const EASING = Easing.out(Easing.cubic)

export interface SwipePagerType {
  /** 切到第 index 页 */
  setPage: (index: number, animated?: boolean) => void
}

export interface SwipePagerProps {
  /** 页数，children 按顺序对应每一页 */
  pageCount: number
  /** 切到某一页时回调（点标签和滑动都会触发） */
  onPageChange?: (index: number) => void
  /** 横滑过程中某一页开始露出来时回调，方便提前把该页挂载出来 */
  onReveal?: (index: number) => void
  children: React.ReactNode
}

/**
 * 左右滑动容器，替代系统 PagerView（Android 是 ViewPager2）。
 * 主要是为了能控制两头的回弹：滑到第一页/最后一页时手指还能带一点点，
 * 松手后用 380ms 缓出弹回去；ViewPager2 那个原生回弹极快，像跳了一下。
 */
export default forwardRef<SwipePagerType, SwipePagerProps>(({ pageCount, onPageChange, onReveal, children }, ref) => {
  const { onLayout, width } = useLayout()
  const translateX = useRef(new Animated.Value(0)).current
  const widthRef = useRef(0)
  const indexRef = useRef(0)
  const revealedRef = useRef(0)
  const prevWidthRef = useRef(0)
  // useLayout 的 onLayout 会带着新宽度触发重渲，取最新的宽度给手势用
  widthRef.current = width

  // 宽度真的变了（例如字号设置改变）时把偏移重新对上当前页，
  // 只有高度变化（播放条出现之类）就不用管
  useEffect(() => {
    if (width == 0 || width == prevWidthRef.current) return
    prevWidthRef.current = width
    translateX.setValue(-width * indexRef.current)
  }, [width, translateX])

  /**
   * 手指位移换算成页面偏移。超出第一页/最后一页的部分按比例衰减，
   * 再用 EDGE_MAX_RATIO 限幅，这样两头是“能拉动一点但拉不走”，
   * 既不会误翻页，也不是硬邦邦完全不动。
   */
  const toOffset = useCallback((dx: number) => {
    const width = widthRef.current
    const base = -width * indexRef.current
    const raw = base + dx
    const max = -width * (pageCount - 1)
    const maxEdge = width * EDGE_MAX_RATIO
    if (raw > 0) return Math.min(raw * EDGE_RESISTANCE, maxEdge)
    if (raw < max) return Math.max(max - (max - raw) * EDGE_RESISTANCE, max - maxEdge)
    return raw
  }, [pageCount])

  const animateTo = useCallback((index: number, animated = true, duration = DURATION) => {
    indexRef.current = index
    onPageChange?.(index)
    const toValue = -widthRef.current * index
    if (!animated || widthRef.current == 0) {
      translateX.setValue(toValue)
      return
    }
    Animated.timing(translateX, {
      toValue,
      duration,
      easing: EASING,
      useNativeDriver: false,
    }).start()
  }, [onPageChange, translateX])

  useImperativeHandle(ref, () => ({ setPage: animateTo }), [animateTo])

  const responder = useMemo(() => PanResponder.create({
    // 用 capture：横向手势要在页面里的列表之前拿到，纵向的留给列表自己滚
    onMoveShouldSetPanResponderCapture: (_, gesture) => {
      if (widthRef.current == 0) return false
      return Math.abs(gesture.dx) > SLOP && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5
    },
    onPanResponderMove: (_, gesture) => {
      const offset = toOffset(gesture.dx)
      translateX.setValue(offset)
      // 现在露得最多的是哪一页
      const revealed = Math.min(pageCount - 1, Math.max(0, Math.round(-offset / widthRef.current)))
      if (revealed != revealedRef.current) {
        revealedRef.current = revealed
        onReveal?.(revealed)
      }
    },
    onPanResponderRelease: (_, gesture) => {
      const current = indexRef.current
      const threshold = widthRef.current * SWITCH_RATIO
      let target = current
      if (gesture.dx < -threshold) target = Math.min(current + 1, pageCount - 1)
      else if (gesture.dx > threshold) target = Math.max(current - 1, 0)
      // 页没变（没到翻页的距离，或者在两头被衰减掉了）就慢慢弹回去
      animateTo(target, true, target == current ? REBOUND_DURATION : DURATION)
    },
    onPanResponderTerminate: () => { animateTo(indexRef.current, true, REBOUND_DURATION) },
  }), [animateTo, onReveal, pageCount, toOffset, translateX])

  return (
    <View style={styles.container} onLayout={onLayout} {...responder.panHandlers}>
      {
        width == 0
          ? null
          : (
            <Animated.View style={{ ...styles.pager, width: width * pageCount, transform: [{ translateX }] }}>
              {
                Children.map(children, (child, index) => (
                  <View key={index} style={{ width }}>
                    {child}
                  </View>
                ))
              }
            </Animated.View>
            )
      }
    </View>
  )
})

const styles = createStyle({
  container: {
    flex: 1,
    overflow: 'hidden',
  },
  pager: {
    flex: 1,
    flexDirection: 'row',
  },
})
