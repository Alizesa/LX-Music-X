import { useEffect, useRef } from 'react'
import { View } from 'react-native'
import MusicList from './MusicList'
import MyList from './MyList'
import Popup, { type PopupType } from '@/components/common/Popup'
import { useI18n } from '@/lang'

export default () => {
  const t = useI18n()
  const popupRef = useRef<PopupType>(null)

  useEffect(() => {
    // 列表清单原来挂在左侧抽屉里，现在换成底部面板（和「更多」面板同一套）。
    // 事件接口没变，所以 ActiveList 上那个「当前列表」按钮、以及 MyList 里
    // 选中列表后的关闭回调，一行都不用改。
    const changeVisible = (visible: boolean) => {
      popupRef.current?.setVisible(visible)
    }

    global.app_event.on('changeLoveListVisible', changeVisible)

    return () => {
      global.app_event.off('changeLoveListVisible', changeVisible)
    }
  }, [])

  return (
    <View style={{ flex: 1 }}>
      <MusicList />
      <Popup ref={popupRef} title={t('nav_love')} position="bottom">
        <MyList />
      </Popup>
    </View>
  )
}
