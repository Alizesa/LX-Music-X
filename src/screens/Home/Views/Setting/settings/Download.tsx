import { memo, useMemo } from 'react'
import { StyleSheet, View } from 'react-native'

import Section from '../components/Section'
import SubTitle from '../components/SubTitle'
import CheckBox from '@/components/common/CheckBox'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
import { TRY_QUALITYS_LIST } from '@/core/music/utils'

const useActive = (id: LX.Quality) => {
  const q = useSettingValue('download.quality')
  return useMemo(() => q == id, [q, id])
}

const Item = ({ id }: { id: LX.Quality }) => {
  const isActive = useActive(id)
  return <CheckBox marginRight={8} check={isActive} label={id} onChange={() => { updateSetting({ 'download.quality': id }) }} need />
}

export default memo(() => {
  const t = useI18n()
  // 与播放音质分开：播放是当下的取舍（流量/WiFi 可随时改），
  // 下载是留档，不该被播放设置连带决定
  const qualityList = useMemo(() => [...TRY_QUALITYS_LIST, '128k'].reverse() as LX.Quality[], [])

  return (
    <Section title={t('setting_download')}>
      <SubTitle title={t('download_quality')}>
        <View style={styles.list}>
          {qualityList.map(q => <Item id={q} key={q} />)}
        </View>
      </SubTitle>
    </Section>
  )
})

const styles = StyleSheet.create({
  list: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
})
