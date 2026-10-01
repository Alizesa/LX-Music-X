import { memo, useMemo } from 'react'

import { View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import CheckBox from '@/components/common/CheckBox'
import { useSettingValue } from '@/store/setting/hook'
import { useI18n } from '@/lang'
import { setDesktopLyricBackground } from '@/core/desktopLyric'
import { createStyle } from '@/utils/tools'
import { updateSetting } from '@/core/common'

type BACKGROUND_TYPE = LX.AppSetting['desktopLyric.background']

const BACKGROUND_LIST = [
  'text',
  'window',
  'none',
] as const

const useActive = (id: BACKGROUND_TYPE) => {
  const background = useSettingValue('desktopLyric.background')
  return useMemo(() => background == id, [background, id])
}

const Item = ({ id, name, change }: {
  id: BACKGROUND_TYPE
  name: string
  change: (id: BACKGROUND_TYPE) => void
}) => {
  const isActive = useActive(id)
  return <CheckBox marginBottom={3} check={isActive} label={name} onChange={() => { change(id) }} need />
}

export default memo(() => {
  const t = useI18n()
  const opacity = useSettingValue('desktopLyric.backgroundOpacity')
  const list = useMemo(() => {
    return BACKGROUND_LIST.map(id => ({ id, name: t(`setting_lyric_desktop_background_${id}`) }))
  }, [t])

  const setBackground = (id: BACKGROUND_TYPE) => {
    void setDesktopLyricBackground(id, opacity).then(() => {
      updateSetting({ 'desktopLyric.background': id })
    })
  }

  return (
    <SubTitle title={t('setting_lyric_desktop_background')}>
      <View style={styles.list}>
        {
          list.map(({ id, name }) => <Item name={name} id={id} key={id} change={setBackground} />)
        }
      </View>
    </SubTitle>
  )
})

const styles = createStyle({
  list: {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
})
