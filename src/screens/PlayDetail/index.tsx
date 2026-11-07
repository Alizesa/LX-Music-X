import { useEffect } from 'react'
// import { View, StyleSheet } from 'react-native'
import { useHorizontalMode, useTabletLayout } from '@/utils/hooks'

import Vertical from './Vertical'
import Horizontal from './Horizontal'
import Tablet from './Tablet'
import PageContent from '@/components/PageContent'
import StatusBar from '@/components/common/StatusBar'
import { setComponentId } from '@/core/common'
import { COMPONENT_IDS } from '@/config/constant'

export default ({ componentId }: { componentId: string }) => {
  const isHorizontalMode = useHorizontalMode()
  const { isWide } = useTabletLayout()

  useEffect(() => {
    setComponentId(COMPONENT_IDS.playDetail, componentId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <PageContent>
      <StatusBar />
      {
        isWide
          ? <Tablet componentId={componentId} />
          : isHorizontalMode
            ? <Horizontal componentId={componentId} />
            : <Vertical componentId={componentId} />
      }
    </PageContent>
  )
}
