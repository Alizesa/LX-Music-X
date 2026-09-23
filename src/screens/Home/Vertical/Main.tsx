import { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import Search from '../Views/Search'
import SongList from '../Views/SongList'
import Mylist from '../Views/Mylist'
import Leaderboard from '../Views/Leaderboard'
import Setting from '../Views/Setting'
import Download from '../Views/Download'
import QQMusic from '../Views/QQMusic'
import { type InitState as CommonState } from '@/store/common/state'
import { setNavActiveId } from '@/core/common'
import Header from './Header'
import HomeDashboard from './HomeDashboard'
import MineDashboard from './MineDashboard'
import MoreMenu, { type MoreMenuType } from './MoreMenu'
import type { HomeTab } from './BottomTabs'

export type MainMode = 'dashboard' | CommonState['navActiveId']

interface Props {
  tab: HomeTab
  /**
   * 每次点底部 Tab 都会 +1。不能只用 tab 值判断：在旧功能页里点的可能正是
   * 当前选中的那个 Tab，tab 不变也要退回仪表盘。
   */
  tabPressCount: number
}

const LegacyPage = ({ mode }: { mode: Exclude<MainMode, 'dashboard'> }) => {
  switch (mode) {
    case 'nav_songlist': return <SongList />
    case 'nav_top': return <Leaderboard />
    case 'nav_love': return <Mylist />
    case 'nav_qq': return <QQMusic />
    case 'nav_download': return <Download />
    case 'nav_setting': return <Setting />
    case 'nav_search':
    default: return <Search />
  }
}

export default ({ tab, tabPressCount }: Props) => {
  const [mode, setMode] = useState<MainMode>('dashboard')
  const moreMenuRef = useRef<MoreMenuType>(null)

  useEffect(() => {
    const handleNavUpdate = (id: CommonState['navActiveId']) => { setMode(id) }
    global.state_event.on('navActiveIdUpdated', handleNavUpdate)
    return () => { global.state_event.off('navActiveIdUpdated', handleNavUpdate) }
  }, [])

  useEffect(() => { setMode('dashboard') }, [tabPressCount])

  // 打开旧功能页要同时更新 navActiveId（标题、列表选中态都读它）
  const openLegacy = (id: CommonState['navActiveId']) => {
    setNavActiveId(id)
    setMode(id)
  }
  const openMoreMenu = () => { moreMenuRef.current?.show() }

  return (
    <View style={{ flex: 1 }}>
      {mode === 'dashboard'
        ? (
            tab === 'home'
              ? <HomeDashboard onModeChange={openLegacy} onOpenMenu={openMoreMenu} />
              : <MineDashboard onModeChange={openLegacy} onOpenMenu={openMoreMenu} />
          )
        : (
            <>
              <Header onMenuPress={openMoreMenu} />
              <LegacyPage mode={mode} />
            </>
          )}
      <MoreMenu ref={moreMenuRef} onOpen={openLegacy} />
    </View>
  )
}
