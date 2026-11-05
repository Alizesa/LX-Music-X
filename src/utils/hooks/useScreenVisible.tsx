import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { AppState } from 'react-native'
import { Navigation } from 'react-native-navigation'

const ScreenVisible = createContext(true)

/** Navigation.push 会保留下面的 React 页面；UI 订阅要跟随显示状态，而非只等卸载。 */
export const ScreenVisibilityProvider = ({ componentId, children }: { componentId: string, children: ReactNode }) => {
  const [appeared, setAppeared] = useState(true)
  const [active, setActive] = useState(AppState.currentState === 'active')
  useEffect(() => {
    const navigation = Navigation.events().registerComponentListener({
      componentDidAppear: () => { setAppeared(true) },
      componentDidDisappear: () => { setAppeared(false) },
    }, componentId)
    const appState = AppState.addEventListener('change', state => { setActive(state === 'active') })
    return () => {
      navigation.remove()
      appState.remove()
    }
  }, [componentId])
  return <ScreenVisible.Provider value={appeared && active}>{children}</ScreenVisible.Provider>
}

/** 同一原生页面里的 pager tab 也可以暂停自己的 UI 订阅。 */
export const VisibilityBoundary = ({ visible, children }: { visible: boolean, children: ReactNode }) => {
  const parentVisible = useContext(ScreenVisible)
  return <ScreenVisible.Provider value={parentVisible && visible}>{children}</ScreenVisible.Provider>
}

export const useScreenVisible = () => useContext(ScreenVisible)
