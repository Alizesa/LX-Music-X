import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'
import { memo } from 'react'
import { View } from 'react-native'
import { useSettingValue } from '@/store/setting/hook'

import CheckBoxItem from '../../components/CheckBoxItem'

/**
 * 「没有 VIP 的账号只用标准音质」。
 *
 * 这是个手动声明，不是探测出来的：非会员账号在 QQ 那边只有标准音质，
 * 但取链代码不试一遍不知道，于是每首歌都要把无损/320k 逐档试过去（每档一次请求）。
 * 声明之后取链直接按标准档走。
 */
export default memo(() => {
  const t = useI18n()
  const noVipStandardQuality = useSettingValue('player.noVipStandardQuality')
  const setNoVipStandardQuality = (noVipStandardQuality: boolean) => {
    updateSetting({ 'player.noVipStandardQuality': noVipStandardQuality })
  }

  return (
    <View style={styles.content}>
      <CheckBoxItem
        check={noVipStandardQuality}
        onChange={setNoVipStandardQuality}
        helpDesc={t('setting_play_no_vip_standard_tip')}
        label={t('setting_play_no_vip_standard')}
      />
    </View>
  )
})


const styles = createStyle({
  content: {
    marginTop: 5,
  },
})
