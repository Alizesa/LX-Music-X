import { memo, useMemo } from 'react'
import { StyleSheet, View } from 'react-native'

import Section from '../components/Section'
import SubTitle from '../components/SubTitle'
import CheckBox from '@/components/common/CheckBox'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
import { TRY_QUALITYS_LIST } from '@/core/music/utils'

const useActiveQuality = (id: LX.Quality) => {
  const q = useSettingValue('download.quality')
  return useMemo(() => q == id, [q, id])
}

const QualityItem = ({ id }: { id: LX.Quality }) => {
  const isActive = useActiveQuality(id)
  return <CheckBox marginRight={8} check={isActive} label={id} onChange={() => { updateSetting({ 'download.quality': id }) }} need />
}

type UrlSource = LX.AppSetting['download.urlSource']

const urlSourceList: UrlSource[] = ['source', 'account']

const UrlSourceItem = ({ id }: { id: UrlSource }) => {
  const t = useI18n()
  const current = useSettingValue('download.urlSource')
  const isActive = useMemo(() => current == id, [current, id])
  return <CheckBox
    marginRight={8}
    check={isActive}
    label={t(id == 'source' ? 'download_url_source_script' : 'download_url_source_account')}
    onChange={() => { updateSetting({ 'download.urlSource': id }) }}
    need
  />
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
          {qualityList.map(q => <QualityItem id={q} key={q} />)}
        </View>
      </SubTitle>
      <SubTitle title={t('download_url_source')}>
        <View style={styles.list}>
          {urlSourceList.map(id => <UrlSourceItem id={id} key={id} />)}
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
