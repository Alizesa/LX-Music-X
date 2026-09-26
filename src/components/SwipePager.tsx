import { Children, forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { Animated, PanResponder, View } from 'react-native'
import { useLayout } from '@/utils/hooks'
import { createStyle } from '@/utils/tools'

// 手指移动超过这个距离才算横向滑动，免得和页面里的纵向列表抢手势
const SLOP = 8
// 松手时超过页面宽度的这个比例才翻页
const SWITCH_RATIO = 0.2
const DURATION = 200

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
 * 左右滑动容器。和系统 PagerView（Android 的 ViewPager2）的区别在边界：
 * 这里滑到第一页/最后一页就是硬边界，手指再往外推页面也不动，
 * 而 ViewPager2 到头会有一段原生的回弹（Android 12 起是整页拉伸再弹回），
 * 那个是原生行为，overScrollMode 之类的 prop 在不少机型上关不掉。
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

  /** 把偏移卡在 [第一页, 最后一页] 之间，这就是“到底就滑不动”的地方 */
  const clamp = useCallback((value: number) => {
    const max = -widthRef.current * (pageCount - 1)
    if (value > 0) return 0
    if (value < max) return max
    return value
  }, [pageCount])

  const animateTo = useCallback((index: number, animated = true) => {
    indexRef.current = index
    onPageChange?.(index)
    if (!animated || widthRef.current == 0) {
      translateX.setValue(-widthRef.current * index)
      return
    }
    Animated.timing(translateX, {
      toValue: -widthRef.current * index,
      duration: DURATION,
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
      const offset = clamp(-widthRef.current * indexRef.current + gesture.dx)
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
      if (gesture.dx < -threshold) animateTo(Math.min(current + 1, pageCount - 1))
      else if (gesture.dx > threshold) animateTo(Math.max(current - 1, 0))
      else animateTo(current)
    },
    onPanResponderTerminate: () => { animateTo(indexRef.current) },
  }), [animateTo, clamp, onReveal, pageCount, translateX])

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
