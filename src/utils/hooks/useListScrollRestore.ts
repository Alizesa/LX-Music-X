import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { type FlatList, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'

/** 列表隐藏后可以释放数据；这里只保留滚动位置，重新读入后再定位。 */
export const useListScrollRestore = <T>(list: RefObject<FlatList<T>>, visible: boolean, ready: boolean) => {
  const offset = useRef(0)
  const restoring = useRef(false)
  const contentHeight = useRef(0)
  const height = useRef(0)

  const restore = useCallback(() => {
    if (!visible || !ready || !restoring.current || !contentHeight.current || !height.current) return
    // 虚拟列表可能尚未量完全部高度。保留目标，后续布局再重试，不能用临时高度把它截成 0。
    list.current?.scrollToOffset({ offset: offset.current, animated: false })
  }, [list, visible, ready])

  useEffect(() => {
    if (!visible) {
      restoring.current = true
      contentHeight.current = 0
      return
    }
    const frame = requestAnimationFrame(restore)
    return () => { cancelAnimationFrame(frame) }
  }, [visible, restore])

  const onScroll = useCallback(({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!visible || !ready) return
    const next = nativeEvent.contentOffset.y
    if (restoring.current) {
      if (Math.abs(next - offset.current) < 1) restoring.current = false
    } else offset.current = next
  }, [visible, ready])
  const onScrollBeginDrag = useCallback(({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!visible) return
    restoring.current = false
    offset.current = nativeEvent.contentOffset.y
  }, [visible])
  const onContentSizeChange = useCallback((_width: number, nextHeight: number) => {
    if (!visible || !ready) {
      contentHeight.current = 0
      return
    }
    contentHeight.current = nextHeight
    restore()
  }, [restore, visible, ready])
  const onLayout = useCallback(({ nativeEvent }: LayoutChangeEvent) => {
    height.current = nativeEvent.layout.height
    restore()
  }, [restore])

  return { onScroll, onScrollBeginDrag, onContentSizeChange, onLayout, scrollEventThrottle: 100 }
}
