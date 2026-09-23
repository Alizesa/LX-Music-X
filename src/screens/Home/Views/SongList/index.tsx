import { useEffect, useRef } from 'react'
import { View } from 'react-native'
import Content from './Content'
import TagList from './TagList'
import Popup, { type PopupType } from '@/components/common/Popup'
import { useI18n } from '@/lang'

export default () => {
  const t = useI18n()
  const popupRef = useRef<PopupType>(null)

  useEffect(() => {
    // 标签清单原来挂在左侧抽屉里，现在换成底部面板（和「更多」面板同一套）。
    // 事件接口没变，HeaderBar 上那个标签按钮不用改。
    const handleShow = () => { popupRef.current?.setVisible(true) }
    const handleHide = () => { popupRef.current?.setVisible(false) }

    global.app_event.on('showSonglistTagList', handleShow)
    global.app_event.on('hideSonglistTagList', handleHide)

    return () => {
      global.app_event.off('showSonglistTagList', handleShow)
      global.app_event.off('hideSonglistTagList', handleHide)
    }
  }, [])

  return (
    <View style={{ flex: 1 }}>
      <Content />
      <Popup ref={popupRef} title={t('home_songlist_tags')} position="bottom">
        <TagList />
      </Popup>
    </View>
  )
}
