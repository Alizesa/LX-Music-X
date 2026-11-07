import { useMemo } from 'react'
import useWindowSize from './useWindowSize'
import { isWideLayout, TABLET_RAIL_WIDTH } from '@/utils/layout'

export interface TabletLayout {
  width: number
  height: number
  /** 宽屏平板：左侧导航条已经占掉一列，内容区要按剩余宽度算 */
  isWide: boolean
  contentWidth: number
}

export default (): TabletLayout => {
  const size = useWindowSize()

  return useMemo(() => {
    const isWide = isWideLayout(size.width, size.height)
    return {
      width: size.width,
      height: size.height,
      isWide,
      contentWidth: size.width - (isWide ? TABLET_RAIL_WIDTH : 0),
    }
  }, [size.width, size.height])
}
