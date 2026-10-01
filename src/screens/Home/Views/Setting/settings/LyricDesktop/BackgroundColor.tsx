import { memo } from 'react'

import { View, TouchableOpacity, StyleSheet } from 'react-native'

import SubTitle from '../../components/SubTitle'
import { useSettingValue } from '@/store/setting/hook'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { setDesktopLyricBackgroundColor } from '@/core/desktopLyric'
import { updateSetting } from '@/core/common'

const COLORS = [
  'rgba(0, 0, 0, 1)',
  'rgba(51, 51, 51, 1)',
  'rgba(255, 255, 255, 1)',
  'rgba(1, 156, 228, 1)',
  'rgba(8, 230, 100, 1)',
  'rgba(200, 81, 212, 1)',
] as const

const ColorItem = ({ color, active, borderColor, change }: {
  color: string
  active: boolean
  borderColor: string
  change: (color: string) => void
}) => {
  return (
    <TouchableOpacity style={styles.item} activeOpacity={0.5} onPress={() => { change(color) }}>
      <View style={{ ...styles.image, backgroundColor: color, borderWidth: active ? 2 : 0, borderColor }}>
      </View>
    </TouchableOpacity>
  )
}

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const background = useSettingValue('desktopLyric.background')
  const color = useSettingValue('desktopLyric.background.color')

  const setColor = (color: string) => {
    void setDesktopLyricBackgroundColor(color).then(() => {
      updateSetting({ 'desktopLyric.background.color': color })
    })
  }

  // 背景框整个不显示时，颜色没有意义
  if (background == 'none') return null

  return (
    <SubTitle title={t('setting_lyric_desktop_background_color')}>
      <View style={styles.list}>
        {
          COLORS.map(c => <ColorItem key={c} color={c} active={c == color} borderColor={theme['c-primary']} change={setColor} />)
        }
      </View>
    </SubTitle>
  )
})

const styles = StyleSheet.create({
  list: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  item: {
    marginRight: 15,
    marginTop: 5,
    alignItems: 'center',
    width: 26,
  },
  image: {
    width: 22,
    height: 22,
    borderRadius: 4,
    elevation: 1,
  },
})
