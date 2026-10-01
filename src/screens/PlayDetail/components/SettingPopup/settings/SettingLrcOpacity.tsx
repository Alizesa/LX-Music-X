import { useState } from 'react'

import { View } from 'react-native'
import { useTheme } from '@/store/theme/hook'
import Text from '@/components/common/Text'
import { useSettingValue } from '@/store/setting/hook'
import Slider, { type SliderProps } from '@/components/common/Slider'
import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
import styles from './style'

// 只作用于未播放的行：当前播放那行始终是不透明的，不然整块歌词就没主次了
const LrcOpacity = () => {
  const theme = useTheme()
  const opacity = useSettingValue('playDetail.style.lyricOpacity')
  const [sliderSize, setSliderSize] = useState(opacity)
  const [isSliding, setSliding] = useState(false)
  const t = useI18n()

  const handleSlidingStart: SliderProps['onSlidingStart'] = () => {
    setSliding(true)
  }
  const handleValueChange: SliderProps['onValueChange'] = value => {
    setSliderSize(value)
  }
  const handleSlidingComplete: SliderProps['onSlidingComplete'] = value => {
    setSliding(false)
    if (opacity == value) return
    updateSetting({ 'playDetail.style.lyricOpacity': value })
  }

  return (
    <View style={styles.container}>
      <Text>{t('play_detail_setting_lrc_opacity')}</Text>
      <View style={styles.content}>
        <Text style={styles.label} color={theme['c-font-label']}>{isSliding ? sliderSize : opacity}</Text>
        <Slider
          minimumValue={10}
          maximumValue={100}
          onSlidingComplete={handleSlidingComplete}
          onValueChange={handleValueChange}
          onSlidingStart={handleSlidingStart}
          step={5}
          value={opacity}
        />
      </View>
    </View>
  )
}

export default LrcOpacity
