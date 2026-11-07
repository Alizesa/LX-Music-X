import { useHorizontalMode, useTabletLayout } from '@/utils/hooks'
import Vertical from './Vertical'
import Horizontal from './Horizontal'

export type { SettingScreenIds } from './Main'

export default () => {
  const isHorizontalMode = useHorizontalMode()
  const { isWide } = useTabletLayout()

  // 平板横屏的设置页按手机竖屏结构走，只有手机横屏才用左右分栏
  return isHorizontalMode && !isWide
    ? <Horizontal />
    : <Vertical />
}
