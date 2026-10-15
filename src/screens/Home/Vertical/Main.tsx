import { useCallback, useEffect, useMemo, useRef, type ComponentRef } from 'react'
import { View } from 'react-native'
import Recommend from '../Views/Recommend'
import Mine from '../Views/Mine'
import commonState, { type InitState as CommonState } from '@/store/common/state'
import { createStyle } from '@/utils/tools'
import PagerView, { type PageScrollStateChangedNativeEvent, type PagerViewOnPageSelectedEvent } from 'react-native-pager-view'
import { setNavActiveId } from '@/core/common'
import settingState from '@/store/setting/state'
import { type NAV_ID_Type } from '@/config/constant'

// 只有「首页」和「我的」两个 tab。搜索/设置/下载/播放历史已经改成推入式页面，
// 不再占 pager 页，所以这里的映射也只管这两个。
const viewMap: Partial<Record<NAV_ID_Type, number>> = {
  nav_home: 0,
  nav_mine: 1,
}
const indexMap = ['nav_home', 'nav_mine'] as const

const Main = () => {
  const pagerViewRef = useRef<ComponentRef<typeof PagerView>>(null)
  const activeIndexRef = useRef(viewMap[commonState.navActiveId] ?? 0)

  // 竖屏这块 PagerView 被卸载时（例如切到横屏布局）可能还没收到 idle 事件，
  // 全局残留的 false 会让列表里点歌被当成滑动中而忽略掉
  useEffect(() => () => {
    global.lx.homePagerIdle = true
  }, [])

  const onPageSelected = useCallback(({ nativeEvent }: PagerViewOnPageSelectedEvent) => {
    const nextIndex = nativeEvent.position
    activeIndexRef.current = nextIndex
    const nextId = indexMap[nextIndex]
    if (nextId != null && nextId != commonState.navActiveId) setNavActiveId(nextId)
  }, [])

  const onPageScrollStateChanged = useCallback(({ nativeEvent }: PageScrollStateChangedNativeEvent) => {
    const idle = nativeEvent.pageScrollState == 'idle'
    if (global.lx.homePagerIdle != idle) global.lx.homePagerIdle = idle
  }, [])

  useEffect(() => {
    const handleUpdate = (id: CommonState['navActiveId']) => {
      const index = viewMap[id]
      if (index == null || activeIndexRef.current == index) return
      activeIndexRef.current = index
      pagerViewRef.current?.setPageWithoutAnimation(index)
    }
    const handleConfigUpdate = (keys: Array<keyof LX.AppSetting>, setting: Partial<LX.AppSetting>) => {
      if (!keys.includes('common.homePageScroll')) return
      pagerViewRef.current?.setScrollEnabled(setting['common.homePageScroll']!)
    }
    global.state_event.on('navActiveIdUpdated', handleUpdate)
    global.state_event.on('configUpdated', handleConfigUpdate)
    return () => {
      global.state_event.off('navActiveIdUpdated', handleUpdate)
      global.state_event.off('configUpdated', handleConfigUpdate)
    }
  }, [])

  const component = useMemo(() => (
    <PagerView ref={pagerViewRef}
      initialPage={activeIndexRef.current}
      offscreenPageLimit={1}
      onPageSelected={onPageSelected}
      onPageScrollStateChanged={onPageScrollStateChanged}
      scrollEnabled={settingState.setting['common.homePageScroll']}
      style={styles.pagerView}
    >
      <View collapsable={false} key="nav_home" style={styles.pageStyle}>
        <Recommend />
      </View>
      <View collapsable={false} key="nav_mine" style={styles.pageStyle}>
        <Mine />
      </View>
    </PagerView>
  ), [onPageScrollStateChanged, onPageSelected])

  return component
}

const styles = createStyle({
  pagerView: {
    flex: 1,
    overflow: 'hidden',
  },
  pageStyle: {
  },
})


export default Main
