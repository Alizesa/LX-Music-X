import { memo } from 'react'
import { View } from 'react-native'
import { useSettingValue } from '@/store/setting/hook'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'


import CheckBoxItem from '../../components/CheckBoxItem'
import { setDesktopLyricVerticalRotateLatin } from '@/core/desktopLyric'
import { updateSetting } from '@/core/common'

// 竖排时英文逐字母正着堆叠，一个词被拆成一列互不相连的字母，不好看也不好读。
// 打开这项就把一串拉丁字母整体横倒 90°（歪头看是连续的），中文照旧逐字竖排
export default memo(() => {
  const t = useI18n()
  const rotateLatin = useSettingValue('desktopLyric.verticalRotateLatin')
  const update = (rotateLatin: boolean) => {
    void setDesktopLyricVerticalRotateLatin(rotateLatin).then(() => {
      updateSetting({ 'desktopLyric.verticalRotateLatin': rotateLatin })
    })
  }

  return (
    <View style={styles.content}>
      <CheckBoxItem check={rotateLatin} onChange={update} label={t('setting_lyric_desktop_vertical_rotate_latin')} />
    </View>
  )
})


const styles = createStyle({
  content: {
    // 上面是「显示方向」那块（SubTitle）自带 18 的下边距，这里不能再加 marginTop：
    // 加了就比别处多出一截空白（兄弟项 IsSingleLine 的 marginTop 是因为它上面那个
    // setting 是光秃秃的 CheckBoxItem，没有下边距）
    marginBottom: 15,
  },
})
