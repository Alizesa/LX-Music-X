import { memo, useCallback, useRef, useEffect } from 'react'
import { type LayoutChangeEvent, StyleSheet, View, StatusBar } from 'react-native'
import commonState from '@/store/common/state'
import settingState from '@/store/setting/state'
import { setStatusbarHeight } from '@/core/common'
import { windowSizeTools, getWindowSize } from '@/utils/windowSizeTools'
import { useScreenVisible } from '@/utils/hooks/useScreenVisible'

const getStatusbarHeight = (winHeight: number, layoutHeight: number) => {
  const height = (!settingState.setting['common.alwaysKeepStatusbarHeight'] &&
          parseFloat(winHeight.toFixed(2)) >= parseFloat(layoutHeight.toFixed(2)))
    ? 0
    : (StatusBar.currentHeight ?? 0)

  return height
}

export default memo(() => {
  const visible = useScreenVisible()
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const layoutRef = useRef<{ width: number, height: number } | null>(null)
  const requestVersion = useRef(0)
  const sizeRef = useRef([0, 0])
  const updateLayout = useCallback((layout: { width: number, height: number }) => {
    if (!visibleRef.current || layout.width <= 0 || layout.height <= 0) return
    // 布局事件就是当前窗口的 dp 尺寸，不等待异步的系统可见区域查询。
    windowSizeTools.setWindowSize(layout.width, layout.height)
    const version = ++requestVersion.current
    void getWindowSize().then(size => {
      if (version !== requestVersion.current || !visibleRef.current || size.height <= 0) return
      sizeRef.current = [size.height, layout.height]
      const height = getStatusbarHeight(size.height, layout.height)
      if (commonState.statusbarHeight !== height) setStatusbarHeight(height)
    }).catch(() => {})
  }, [])
  const handleLayout = useCallback(({ nativeEvent: { layout } }: LayoutChangeEvent) => {
    layoutRef.current = { width: layout.width, height: layout.height }
    updateLayout(layoutRef.current)
  }, [updateLayout])

  useEffect(() => {
    if (visible && layoutRef.current) updateLayout(layoutRef.current)
    return () => { requestVersion.current += 1 }
  }, [visible, updateLayout])

  useEffect(() => {
    const handleSettingUpdate = (keys: Array<keyof LX.AppSetting>) => {
      if (!visibleRef.current || !keys.includes('common.alwaysKeepStatusbarHeight') || !sizeRef.current[1]) return
      const height = getStatusbarHeight(sizeRef.current[0], sizeRef.current[1])
      if (commonState.statusbarHeight !== height) setStatusbarHeight(height)
    }
    global.state_event.on('configUpdated', handleSettingUpdate)

    return () => {
      global.state_event.off('configUpdated', handleSettingUpdate)
    }
  }, [])
  return (<View style={StyleSheet.absoluteFill} onLayout={handleLayout} pointerEvents="none" />)
}, () => true)

