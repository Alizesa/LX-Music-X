import { useState } from 'react'
import Content from './Content'
import PlayerBar from '@/components/player/PlayerBar'
import BottomTabs, { type HomeTab } from './BottomTabs'

export default () => {
  // Tab 状态留在这一层：底部 Tab 要渲染在播放条下方（和参考图一致），
  // 播放条也由这里渲染，所以状态只能放在 Vertical。
  const [tab, setTab] = useState<HomeTab>('home')
  const [tabPressCount, setTabPressCount] = useState(0)

  return (
    <>
      <Content tab={tab} tabPressCount={tabPressCount} />
      <PlayerBar isHome />
      <BottomTabs
        active={tab}
        onTabChange={(next) => {
          setTab(next)
          setTabPressCount(count => count + 1)
        }}
      />
    </>
  )
}
