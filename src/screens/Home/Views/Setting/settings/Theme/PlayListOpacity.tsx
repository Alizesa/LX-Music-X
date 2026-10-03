import { memo, useCallback } from 'react'
import { View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import Slider, { type SliderProps } from '../../components/Slider'
import Text from '@/components/common/Text'
import { createStyle } from '@/utils/tools'
import { useI18n } from '@/lang'
import { useSettingValue } from '@/store/setting/hook'
import { useTheme } from '@/store/theme/hook'
import { updateSetting } from '@/core/common'

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const playListOpacity = useSettingValue('theme.playListOpacity')

  // 实时写设置：只有松手才生效的话，调的时候看不到播放列表的变化，全靠猜（同背景不透明度）
  const handleValueChange = useCallback<NonNullable<SliderProps['onValueChange']>>(value => {
    updateSetting({ 'theme.playListOpacity': value })
  }, [])

  return (
    <SubTitle title={t('setting_basic_theme_play_list_opacity')}>
      <View style={styles.content}>
        <Text style={{ color: theme['c-primary-font'] }}>{Math.round(playListOpacity * 100)}%</Text>
        <Slider
          minimumValue={0.2}
          maximumValue={1}
          onValueChange={handleValueChange}
          step={0.05}
          value={playListOpacity}
        />
      </View>
    </SubTitle>
  )
})

const styles = createStyle({
  content: {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
})
