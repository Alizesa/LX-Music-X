import Header from './Header'
import Main from './Main'

// 抽屉(功能页侧边栏)已经拆掉，这里只剩顶栏 + 两页 pager。
// 页面切换改由 BottomTabBar 驱动 navActiveId，抽屉相关的 changeMenuVisible 事件一并废弃。
const Content = () => {
  return (
    <>
      <Header />
      <Main />
    </>
  )
}

export default Content
