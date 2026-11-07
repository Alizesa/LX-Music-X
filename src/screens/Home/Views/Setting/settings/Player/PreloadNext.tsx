import { memo } from 'react'
import { View } from 'react-native'
import CheckBoxItem from '../../components/CheckBoxItem'
import Text from '@/components/common/Text'
import { useI18n } from '@/lang'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'

export default memo(() => {
  const t = useI18n()
  const enabled = useSettingValue('player.preloadNext')
  return <View style={{ marginTop: 10 }}>
    <CheckBoxItem check={enabled} label={t('setting_player_preload_next')}
      onChange={value => { updateSetting({ 'player.preloadNext': value }) }} />
    <Text size={12}>{t('setting_player_preload_next_tip')}</Text>
  </View>
})
