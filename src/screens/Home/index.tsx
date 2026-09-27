import { useCallback, useEffect, useRef } from 'react'
import { useHorizontalMode } from '@/utils/hooks'
import PageContent from '@/components/PageContent'
import { setComponentId, setNavActiveId } from '@/core/common'
import { COMPONENT_IDS, type NAV_ID_Type } from '@/config/constant'
import { useBackHandler } from '@/utils/hooks/useBackHandler'
import commonState from '@/store/common/state'
import Vertical from './Vertical'
import Horizontal from './Horizontal'
import { navigations } from '@/navigation'
import settingState from '@/store/setting/state'


interface Props {
  componentId: string
}

// 「我的列表」和「QQ音乐」相当于首页，其它标签按返回键都回到这两个页中的一个
const PRIMARY_NAV_IDS = new Set<NAV_ID_Type>(['nav_love', 'nav_qq'])


export default ({ componentId }: Props) => {
  const isHorizontalMode = useHorizontalMode()
  // 记住最近看的是这两个页里的哪一个，返回时回到它
  const lastPrimaryRef = useRef<NAV_ID_Type>('nav_love')

  useEffect(() => {
    setComponentId(COMPONENT_IDS.home, componentId)
    // eslint-disable-next-line react-hooks/exhaustive-deps

    if (settingState.setting['player.startupPushPlayDetailScreen']) {
      navigations.pushPlayDetailScreen(componentId, true)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const handleUpdate = (id: NAV_ID_Type) => {
      if (PRIMARY_NAV_IDS.has(id)) lastPrimaryRef.current = id
    }
    global.state_event.on('navActiveIdUpdated', handleUpdate)
    return () => {
      global.state_event.off('navActiveIdUpdated', handleUpdate)
    }
  }, [])

  useBackHandler(useCallback(() => {
    // 有详情页 / 评论页等推在上面时不能拦，返回键要留给它们退栈
    if (Object.keys(commonState.componentIds).length != 1) return false
    // 已经在这两个页上就交回默认行为（退出应用）
    if (PRIMARY_NAV_IDS.has(commonState.navActiveId)) return false
    setNavActiveId(lastPrimaryRef.current)
    return true
  }, []))

  return (
    <PageContent>
      {
        isHorizontalMode
          ? <Horizontal />
          : <Vertical />
      }
    </PageContent>
  )
}
