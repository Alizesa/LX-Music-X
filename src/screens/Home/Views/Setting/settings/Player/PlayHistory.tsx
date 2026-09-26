import { memo, useMemo } from 'react'
import { View } from 'react-native'
import InputItem, { type InputItemProps } from '../../components/InputItem'
import CheckBoxItem from '../../components/CheckBoxItem'
import { updateSetting } from '@/core/common'
import { trimPlayHistory } from '@/core/player/playHistory'
import { useI18n } from '@/lang'
import { useSettingValue } from '@/store/setting/hook'
import { createStyle, toast } from '@/utils/tools'

export default memo(() => {
  const t = useI18n()
  const enabled = useSettingValue('player.isSavePlayHistory')
  const maxCount = useSettingValue('player.playHistoryMaxCount')
  const value = useMemo(() => String(maxCount), [maxCount])
  const setMaxCount: InputItemProps['onChanged'] = (text, callback) => {
    let count = parseInt(text)
    if (Number.isNaN(count) || count < 1) count = 1
    count = Math.min(count, 10000)
    const next = String(count)
    callback(next)
    updateSetting({ 'player.playHistoryMaxCount': count })
    void trimPlayHistory(count)
    toast(t('setting_play_history_limit_saved'))
  }

  return <View style={styles.content}>
    <CheckBoxItem check={enabled} onChange={value => { updateSetting({ 'player.isSavePlayHistory': value }) }} label={t('setting_play_history_enable')} />
    <InputItem value={value} label={t('setting_play_history_limit')} onChanged={setMaxCount} keyboardType="number-pad" />
  </View>
})

const styles = createStyle({ content: { marginTop: 5 } })
