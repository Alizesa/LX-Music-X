import Main from './Main'
import type { HomeTab } from './BottomTabs'

const Content = ({ tab, tabPressCount }: { tab: HomeTab, tabPressCount: number }) => {
  return <Main tab={tab} tabPressCount={tabPressCount} />
}

export default Content
