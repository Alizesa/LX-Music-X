import Btn from './Btn'
import { useSettingValue } from '@/store/setting/hook'
import DesktopLyricEnable, { type DesktopLyricEnableType } from '@/components/DesktopLyricEnable'
import { memo, useRef } from 'react'
import { toggleDesktopLyricLock } from '@/core/desktopLyric'
import { updateSetting } from '@/core/common'
import { toast } from '@/utils/tools'
import settingState from '@/store/setting/state'
import { useTheme } from '@/store/theme/hook'
import { strongIconShadow } from '@/screens/PlayDetail/components/iconStyle'


export default memo(() => {
  const theme = useTheme()
  const enabledLyric = useSettingValue('desktopLyric.enable')
  const desktopLyricEnableRef = useRef<DesktopLyricEnableType>(null)
  const update = () => {
    desktopLyricEnableRef.current?.setEnabled(!enabledLyric)
  }
  const updateLock = () => {
    const isLock = !settingState.setting['desktopLyric.isLock']
    void toggleDesktopLyricLock(isLock).then(() => {
      updateSetting({ 'desktopLyric.isLock': isLock })
      // 长按切换锁定原来没有任何反馈，很难发现，这里补个提示
      toast(global.i18n.t(isLock ? 'setting_lyric_desktop_lock_tip' : 'setting_lyric_desktop_unlock_tip'), 'long')
    })
  }

  return (
    <>
      <Btn icon={enabledLyric ? 'lyric-on' : 'lyric-off'} color={theme['c-font']} iconStyle={strongIconShadow} onPress={update} onLongPress={updateLock} />
      <DesktopLyricEnable ref={desktopLyricEnableRef} />
    </>
  )
})
