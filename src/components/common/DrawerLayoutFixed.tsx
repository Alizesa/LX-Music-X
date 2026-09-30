import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { DrawerLayoutAndroid, type DrawerLayoutAndroidProps, View, type LayoutChangeEvent } from 'react-native'
// import { getWindowSise } from '@/utils/tools'
import { usePageVisible } from '@/store/common/hook'
import { type COMPONENT_IDS } from '@/config/constant'

interface Props extends DrawerLayoutAndroidProps {
  visibleNavNames: COMPONENT_IDS[]
  widthPercentage: number
  widthPercentageMax?: number
}

export interface DrawerLayoutFixedType {
  openDrawer: () => void
  closeDrawer: () => void
  fixWidth: () => void
}

// native 的回弹动画正常两三百毫秒就结束了，超过这么久还没回到 idle 就当它卡住
const SETTLE_STUCK_TIMEOUT = 1200

const DrawerLayoutFixed = forwardRef<DrawerLayoutFixedType, Props>(({
  visibleNavNames,
  widthPercentage,
  widthPercentageMax,
  onDrawerOpen,
  onDrawerClose,
  onDrawerStateChanged,
  children,
  ...props
}, ref) => {
  const drawerLayoutRef = useRef<DrawerLayoutAndroid>(null)
  const [w, setW] = useState<number | `${number}%`>('100%')
  const [drawerWidth, setDrawerWidth] = useState(0)
  const changedRef = useRef({ width: 0, changed: false })
  // 面板该有的宽度（px）。native 那边可能没收到（见 handleLayout 里的说明），修正时用它重推
  const drawerWidthRef = useRef(0)
  // native 抽屉的状态。open 来自 onDrawerOpen/onDrawerClose（滑动手势和 openDrawer() 都会回调）
  const drawerRef = useRef<{ open: boolean, state: 'Idle' | 'Dragging' | 'Settling' }>({ open: false, state: 'Idle' })
  // 抽屉没关好时，把「重新设置面板宽度」这件事记下来，等它彻底关上了再做
  const pendingFixRef = useRef(false)
  const stuckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const applyFixDrawerWidth = useCallback(() => {
    if (!changedRef.current.width) return
    changedRef.current.changed = true
    // console.log('usePageVisible', visible, changedRef.current.width)
    setW(changedRef.current.width - 1)
  }, [])

  /**
   * 重新设置面板宽度（修复 DrawerLayoutAndroid 在导航到其他屏幕再返回后无法打开的问题）。
   *
   * 靠的还是「改一下容器宽度逼 native 重新量一遍」，但这个动作会改 DrawerLayout 的大小：
   * 抽屉开着、正在滑、或者回弹动画还没结束时做这件事，native 内部的拖拽位置和 offset 会对不上，
   * 屏幕会蒙上一层点不掉的遮罩，只能重启应用。所以这几种状态下先忍住，等它彻底关上了再补。
   */
  const fixDrawerWidth = useCallback(() => {
    const { open, state } = drawerRef.current
    if (open || state != 'Idle') {
      pendingFixRef.current = true
      return
    }
    applyFixDrawerWidth()
  }, [applyFixDrawerWidth])

  // 修复 DrawerLayoutAndroid 在导航到其他屏幕再返回后无法打开的问题
  usePageVisible(visibleNavNames, useCallback((visible) => {
    if (!visible || !changedRef.current.width) return
    fixDrawerWidth()
  }, [fixDrawerWidth]))

  const clearStuckTimer = useCallback(() => {
    if (stuckTimerRef.current) {
      clearTimeout(stuckTimerRef.current)
      stuckTimerRef.current = null
    }
  }, [])
  useEffect(() => clearStuckTimer, [clearStuckTimer])

  const handleDrawerStateChanged = useCallback((state: 'Idle' | 'Dragging' | 'Settling') => {
    drawerRef.current.state = state
    clearStuckTimer()
    if (state == 'Settling') {
      // 兜底：回弹动画一旦卡住不结束，native 的 scrim（遮罩）会一直盖着并拦掉所有点击，
      // 界面上什么都点不动，只能重启应用。这里主动关一次，强制它重新走一遍拖拽把状态复位。
      stuckTimerRef.current = setTimeout(() => {
        stuckTimerRef.current = null
        console.warn('[Drawer] settle stuck, force close')
        drawerLayoutRef.current?.closeDrawer()
      }, SETTLE_STUCK_TIMEOUT)
    } else if (state == 'Idle' && pendingFixRef.current && !drawerRef.current.open) {
      // 抽屉关干净了，把之前忍住没做的宽度修正补上
      pendingFixRef.current = false
      applyFixDrawerWidth()
    }
    onDrawerStateChanged?.(state)
  }, [applyFixDrawerWidth, clearStuckTimer, onDrawerStateChanged])

  const handleDrawerOpen = useCallback(() => {
    drawerRef.current.open = true
    onDrawerOpen?.()
  }, [onDrawerOpen])

  const handleDrawerClose = useCallback(() => {
    drawerRef.current.open = false
    onDrawerClose?.()
  }, [onDrawerClose])

  useImperativeHandle(ref, () => ({
    openDrawer() {
      drawerLayoutRef.current?.openDrawer()
    },
    closeDrawer() {
      drawerLayoutRef.current?.closeDrawer()
    },
    fixWidth() {
      fixDrawerWidth()
    },
  }), [fixDrawerWidth])


  const handleLayout = useCallback((e: LayoutChangeEvent) => {
    // console.log('handleLayout', e.nativeEvent.layout.width, changedRef.current.width)
    if (changedRef.current.changed) {
      // setW(e.nativeEvent.layout.width - 1)
      setW('100%')
      changedRef.current.changed = false
      // 一次修正走完，顺手把面板宽度重新推一次：宽度没变时 React 不会再往 native 发，
      // 而 native 的 setDrawerProperties() 在子 view 还没挂上（getChildCount() != 2）时会静默丢弃，
      // 面板宽度就可能一直停在初始的 0 —— 那时打开抽屉只有一层关不掉的遮罩，面板是空的，
      // 而且 0 宽的面板没有可移动的余地，连点击都推不动 offset，只能重启应用。
      // 让值差 0.1dp 重新发一次（换算成物理像素基本不变，看不出来；下次修正会换回来），
      // 顺便把 gravity 也一起补上。
      const target = drawerWidthRef.current
      if (target > 1) setDrawerWidth(prev => prev == target ? target - 0.1 : target)
      return
    }
    const width = e.nativeEvent.layout.width
    // 还没量出宽度（布局算出 0）时不能往下走：面板宽度会被算成 0，
    // native 侧就可能停在「已经打开了、但面板宽度是 0」的状态，同样是一层点不掉的遮罩
    if (width <= 0) return
    if (changedRef.current.width == width) return
    changedRef.current.width = width

    // 重新设置面板宽度
    const wp = Math.floor(width * widthPercentage)
    // console.log(wp, widthPercentageMax)
    const target = widthPercentageMax ? Math.min(wp, widthPercentageMax) : wp
    drawerWidthRef.current = target
    setDrawerWidth(target)

    // 强制触发渲染以应用更改
    changedRef.current.changed = true
    setW(width - 1)
  }, [widthPercentage, widthPercentageMax])

  return (
    <View
      onLayout={handleLayout}
      style={{ width: w, flex: 1 }}
    >
      <DrawerLayoutAndroid
        ref={drawerLayoutRef}
        keyboardDismissMode="on-drag"
        drawerWidth={drawerWidth}
        onDrawerOpen={handleDrawerOpen}
        onDrawerClose={handleDrawerClose}
        onDrawerStateChanged={handleDrawerStateChanged}
        {...props}
      >
        <View style={{ marginRight: w == '100%' ? 0 : -1, flex: 1 }}>
          {children}
        </View>
      </DrawerLayoutAndroid>
    </View>
  )
})

// const styles = createStyle({
//   container: {
//     flex: 1,
//   },
// })

export default DrawerLayoutFixed
