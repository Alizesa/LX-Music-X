import { memo, useCallback } from 'react'
import { TouchableOpacity, View } from 'react-native'
import { useTheme } from '@/store/theme/hook'
import Text from '@/components/common/Text'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'
import styles from './style'

// 自定义背景图会把歌词盖住，这里给几个「压在任何底图上都看得清」的颜色。
// 想要别的色就改主题，这一项不打算做成取色器。
const COLORS = [
  'rgba(255, 255, 255, 1)',
  'rgba(0, 0, 0, 1)',
  'rgba(255, 212, 0, 1)',
  'rgba(8, 230, 100, 1)',
  'rgba(1, 156, 228, 1)',
  'rgba(239, 105, 118, 1)',
] as const

/**
 * 歌词颜色。`active` 为 true 时改的是「当前播放那一行」的颜色，否则是其余未播放的行。
 * 两者的默认值都是 null = 跟随主题，所以不动它就跟以前完全一样。
 */
export default memo(({ active = false }: { active?: boolean }) => {
  const t = useI18n()
  const theme = useTheme()
  const settingKey = active ? 'playDetail.style.lyricActiveColor' : 'playDetail.style.lyricColor'
  const color = useSettingValue(settingKey)

  const setColor = useCallback((value: string | null) => {
    if (color == value) return
    updateSetting({ [settingKey]: value })
  }, [settingKey, color])

  return (
    <View style={styles.container}>
      <Text>{t(active ? 'play_detail_setting_lrc_active_color' : 'play_detail_setting_lrc_color')}</Text>
      <View style={stylesLocal.row}>
        <TouchableOpacity
          style={[stylesLocal.item, stylesLocal.themeItem, color == null && { borderColor: theme['c-primary'] }]}
          activeOpacity={0.6}
          onPress={() => { setColor(null) }}
        >
          <Text size={12} numberOfLines={1} color={theme['c-font-label']}>{t('play_detail_setting_lrc_color_theme')}</Text>
        </TouchableOpacity>
        {
          COLORS.map(c => (
            <TouchableOpacity
              key={c}
              style={[stylesLocal.item, { backgroundColor: c }, color == c && { borderColor: theme['c-primary'] }]}
              activeOpacity={0.6}
              onPress={() => { setColor(c) }}
            />
          ))
        }
      </View>
    </View>
  )
})

const stylesLocal = createStyle({
  // 单独写一行，不直接用 SettingPopup 的 styles.list：那边开着 flexShrink，
  // 「跟随主题」会被后面几个色块挤窄，字就折成两行了
  row: {
    width: '100%',
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    paddingTop: 8,
  },
  item: {
    width: 26,
    height: 26,
    marginRight: 8,
    marginBottom: 6,
    borderRadius: 6,
    // 选中时换成主题色描边。未选中也要有描边：白、黑两个色块跟弹窗底色太接近，
    // 不描一圈就看不见。边框宽度固定 2，选中时只换颜色，整排不会跟着挪
    borderWidth: 2,
    borderColor: 'rgba(128, 128, 128, 0.5)',
    flexShrink: 0,
  },
  themeItem: {
    paddingHorizontal: 10,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(128, 128, 128, 0.25)',
  },
})
