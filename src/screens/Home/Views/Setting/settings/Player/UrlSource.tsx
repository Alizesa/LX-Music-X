import { memo, useMemo } from 'react'
import { StyleSheet, View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import CheckBox from '@/components/common/CheckBox'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'

type UrlSource = LX.AppSetting['player.urlSource']

// 账号优先排前面：它是默认，也是没配自定义源时唯一能用的一条
const urlSourceList: UrlSource[] = ['account', 'source']

const Item = ({ id }: { id: UrlSource }) => {
  const t = useI18n()
  const current = useSettingValue('player.urlSource')
  const isActive = useMemo(() => current == id, [current, id])
  return <CheckBox
    marginRight={8}
    check={isActive}
    label={t(id == 'account' ? 'url_source_account' : 'url_source_script')}
    onChange={() => { updateSetting({ 'player.urlSource': id }) }}
    need
  />
}

/** 播放优先走哪条链。选中的那条拿不到时会回落到另一条，音质设置和各条链自己的降级照旧 */
export default memo(() => {
  const t = useI18n()

  return (
    <SubTitle title={t('player_url_source')}>
      <View style={styles.list}>
        {urlSourceList.map(id => <Item id={id} key={id} />)}
      </View>
    </SubTitle>
  )
})

const styles = StyleSheet.create({
  list: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
})
