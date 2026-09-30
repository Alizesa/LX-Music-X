import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { DrawerLayoutAndroid, type DrawerLayoutAndroidProps, View, type LayoutChangeEvent } from 'react-native'
// import { getWindowSise } from '@/utils/tools'
import { usePageVisible } from '@/store/common/hook'
import { type COMPONENT_IDS } from '@/config/constant'
import { useSettingValue } from '@/store/setting/hook'

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

type DrawerSlideEvent = Parameters<NonNullable<DrawerLayoutAndroidProps['onDrawerSlide']>>[0]

// native 的回弹动画正常两三百毫秒就结束了，超过这么久还没回到 idle 就当它卡住
const SETTLE_STUCK_TIMEOUT = 1200
// native 报的偏移是浮点，1px 的误差不当异常
const OFFSET_EPSILON = 0.001
// 一轮里最多复位两次（先关，再开兜底）
const MAX_REPAIR_ATTEMPTS = 2

const DrawerLayoutFixed = forwardRef<DrawerLayoutFixedType, Props>(({
  visibleNavNames,
  widthPercentage,
  widthPercentageMax,
  onDrawerOpen,
  onDrawerClose,
  onDrawerStateChanged,
  onDrawerSlide,
  children,
  ...props
}, ref) => {
  const drawerLayoutRef = useRef<DrawerLayoutAndroid>(null)
  const [w, setW] = useState<number | `${number}%`>('100%')
  const [drawerWidth, setDrawerWidth] = useState(0)
  const changedRef = useRef({ width: 0, changed: false })
  const customBgImage = useSettingValue('theme.customBgImage')
  // 面板该有的宽度（px）。native 那边可能没收到（见 handleLayout 里的说明），修正时用它重推
  const drawerWidthRef = useRef(0)
  // native 抽屉的状态。open 对的是 native 的「已打开」标记，来自 onDrawerOpen/onDrawerClose
  const drawerRef = useRef<{ open: boolean, state: 'Idle' | 'Dragging' | 'Settling' }>({ open: false, state: 'Idle' })
  // 抽屉没关好时，把「重新设置面板宽度」这件事记下来，等它彻底关上了再做
  const pendingFixRef = useRef(false)
  const stuckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // native 报回来的面板偏移：0 是全关、1 是全开（onDrawerSlide 每次变化都会回调）
  const offsetRef = useRef(0)
  // 收到过滑动回调没有。收不到 offset 就判断不了状态，那就什么都不做
  const hasSlideRef = useRef(false)
  // 这一轮已经复位几次了
  const repairAttemptRef = useRef(0)

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

  useEffect(() => {
    fixDrawerWidth()
  }, [customBgImage, fixDrawerWidth])

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

  /**
   * 把 native 抽屉从「卡住」的状态里拉回来。
   *
   * native 的 DrawerLayout 只在 offset 正好走到 1 时才给面板打上「已打开」标记
   * （dispatchOnDrawerOpened），正好走到 0 时才取消（dispatchOnDrawerClosed）。动画要是在半路
   * 停住（没走完又碰了一下、或者被别的布局/重排插了一脚），面板就停在半开的位置：
   * 标记没打上，而遮罩的不透明度取的就是这个 offset（mScrimOpacity），于是遮罩一直盖着。
   * 这时候 findOpenDrawer() 找不到抽屉 —— 点遮罩关不掉、back 键也关不掉；更糟的是
   * mScrimOpacity > 0 时 DrawerLayout 会把内容区的点按全部吞掉（interceptForTap），
   * 连左上角的菜单按钮都点不动，只能重启应用。
   *
   * 复位先走 close：只要面板不是正正好在关闭位置，close 的目标（-宽度）就一定和当前位置差着
   * 一段，动画能重新起来，把 offset 精确地走回 0，顺带把遮罩和吞点按一起清掉。
   * 万一 offset 小到换算不出 1px、close 成了空操作（原地不动不会起动画），第二次改用 open：
   * 只要 offset 不是 1 它同样动得起来，而且走完会把「已打开」标记补上。
   */
  const repairDrawer = useCallback((reason: string) => {
    const attempt = repairAttemptRef.current
    if (attempt >= MAX_REPAIR_ATTEMPTS) return
    repairAttemptRef.current = attempt + 1
    console.warn(`[Drawer] ${reason}, reset #${attempt + 1}`)
    if (attempt == 0) drawerLayoutRef.current?.closeDrawer()
    else drawerLayoutRef.current?.openDrawer()
  }, [])

  const handleDrawerStateChanged = useCallback((state: 'Idle' | 'Dragging' | 'Settling') => {
    drawerRef.current.state = state
    clearStuckTimer()
    if (state == 'Settling') {
      // 兜底：回弹动画一旦卡住不结束，native 的状态就停在 settling，遮罩会一直盖着并拦掉所有点击
      stuckTimerRef.current = setTimeout(() => {
        stuckTimerRef.current = null
        repairDrawer('settle stuck')
      }, SETTLE_STUCK_TIMEOUT)
    } else if (state == 'Idle') {
      // 停下来的时候，偏移和「已打开」标记必须对得上：offset 到 1 且标记在，或者 offset 到 0
      // 且标记不在（native 就是拿这两个值做判断的）。对不上说明面板卡在半路了。
      const offset = offsetRef.current
      const open = drawerRef.current.open
      // 没收到过滑动回调时判断不了，当它是正常的
      const consistent = !hasSlideRef.current ||
        ((offset <= OFFSET_EPSILON && !open) || (offset >= 1 - OFFSET_EPSILON && open))
      if (consistent) {
        repairAttemptRef.current = 0
        if (pendingFixRef.current && !open) {
          // 抽屉关干净了，把之前忍住没做的宽度修正补上
          pendingFixRef.current = false
          applyFixDrawerWidth()
        }
      } else {
        repairDrawer(offset > OFFSET_EPSILON ? 'drawer stopped short of open' : 'drawer open but not marked')
      }
    }
    onDrawerStateChanged?.(state)
  }, [applyFixDrawerWidth, clearStuckTimer, onDrawerStateChanged, repairDrawer])

  const handleDrawerSlide = useCallback((e: DrawerSlideEvent) => {
    hasSlideRef.current = true
    // native 发过来的就是偏移（ReactDrawerLayoutManager.DrawerSlideEvent），
    // RN 的 d.ts 把它标成了 NativeTouchEvent，这里自己取
    offsetRef.current = (e.nativeEvent as unknown as { offset: number }).offset
    onDrawerSlide?.(e)
  }, [onDrawerSlide])

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
        onDrawerSlide={handleDrawerSlide}
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
