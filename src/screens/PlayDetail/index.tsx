import { useCallback, useEffect, useRef } from 'react'
// import { View, StyleSheet } from 'react-native'
import { useHorizontalMode, useTabletLayout } from '@/utils/hooks'

import Vertical from './Vertical'
import Horizontal from './Horizontal'
import Tablet from './Tablet'
import PageContent from '@/components/PageContent'
import StatusBar from '@/components/common/StatusBar'
import { setComponentId } from '@/core/common'
import { COMPONENT_IDS } from '@/config/constant'
import { type PlayDetailPage } from './page'

export default ({ componentId }: { componentId: string }) => {
  const isHorizontalMode = useHorizontalMode()
  const { isWide } = useTabletLayout()
  // 布局会随旋转/分屏卸载重建，具体页保留在仍然挂载的播放详情中。
  const pageRef = useRef<PlayDetailPage>('cover')
  const handlePageChange = useCallback((page: PlayDetailPage) => { pageRef.current = page }, [])

  useEffect(() => {
    setComponentId(COMPONENT_IDS.playDetail, componentId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <PageContent>
      <StatusBar />
      {
        isWide
          ? <Tablet componentId={componentId} initialPage={pageRef.current} onPageChange={handlePageChange} />
          : isHorizontalMode
            ? <Horizontal componentId={componentId} />
            : <Vertical componentId={componentId} initialPage={pageRef.current} onPageChange={handlePageChange} />
      }
    </PageContent>
  )
}
