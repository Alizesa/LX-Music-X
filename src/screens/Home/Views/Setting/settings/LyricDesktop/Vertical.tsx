import { memo } from 'react'
import { View } from 'react-native'
import { useSettingValue } from '@/store/setting/hook'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'


import CheckBoxItem from '../../components/CheckBoxItem'
import { setDesktopLyricVertical } from '@/core/desktopLyric'
import { updateSetting } from '@/core/common'

export default memo(() => {
  const t = useI18n()
  const isVertical = useSettingValue('desktopLyric.isVertical')
  const update = (isVertical: boolean) => {
    void setDesktopLyricVertical(isVertical).then(() => {
      updateSetting({ 'desktopLyric.isVertical': isVertical })
    })
  }

  return (
    <View style={styles.content}>
      <CheckBoxItem check={isVertical} onChange={update} label={t('setting_lyric_desktop_vertical')} />
    </View>
  )
})


const styles = createStyle({
  content: {
    marginTop: 5,
  },
})
