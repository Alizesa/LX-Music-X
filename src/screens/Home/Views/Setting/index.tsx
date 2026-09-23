import { useHorizontalMode } from '@/utils/hooks'
import Vertical from './Vertical'
import Horizontal from './Horizontal'
import { useBackHandler } from '@/utils/hooks/useBackHandler'
import { useCallback } from 'react'
// import { AppColors } from '@/theme'
import commonState from '@/store/common/state'
import { setNavActiveId } from '@/core/common'

export type { SettingScreenIds } from './Main'

export default () => {
  const isHorizontalMode = useHorizontalMode()
  // 竖屏的返回由 Home/Vertical/Main 接管（回仪表盘）。这里原来把返回跳到
  // lastNavActiveId，在仪表盘模型下会落到"上一个功能页"而不是主界面，所以让位。
  // 横屏还是老结构，保留原行为。
  useBackHandler(useCallback(() => {
    if (!isHorizontalMode) return false
    if (Object.keys(commonState.componentIds).length == 1 && commonState.navActiveId == 'nav_setting') {
      setNavActiveId(commonState.lastNavActiveId)
      return true
    }
    return false
  }, [isHorizontalMode]))

  return isHorizontalMode
    ? <Horizontal />
    : <Vertical />
}
