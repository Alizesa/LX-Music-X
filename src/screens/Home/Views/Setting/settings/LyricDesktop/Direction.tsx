import { memo, useMemo } from 'react'

import { View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import CheckBox from '@/components/common/CheckBox'
import { useSettingValue } from '@/store/setting/hook'
import { useI18n } from '@/lang'
import { setDesktopLyricVertical } from '@/core/desktopLyric'
import { createStyle } from '@/utils/tools'
import { updateSetting } from '@/core/common'

// 只存一个 isVertical 布尔值，方向用两个单选项表示
const DIRECTION_LIST = ['horizontal', 'vertical'] as const
type DIRECTION_TYPE = typeof DIRECTION_LIST[number]

const useActive = (id: DIRECTION_TYPE) => {
  const isVertical = useSettingValue('desktopLyric.isVertical')
  return useMemo(() => (id == 'vertical') == isVertical, [isVertical, id])
}

const Item = ({ id, name, change }: {
  id: DIRECTION_TYPE
  name: string
  change: (id: DIRECTION_TYPE) => void
}) => {
  const isActive = useActive(id)
  return <CheckBox marginBottom={3} check={isActive} label={name} onChange={() => { change(id) }} need />
}

export default memo(() => {
  const t = useI18n()
  const list = useMemo(() => {
    return DIRECTION_LIST.map(id => ({ id, name: t(`setting_lyric_desktop_direction_${id}`) }))
  }, [t])

  const setDirection = (id: DIRECTION_TYPE) => {
    const isVertical = id == 'vertical'
    void setDesktopLyricVertical(isVertical).then(() => {
      updateSetting({ 'desktopLyric.isVertical': isVertical })
    })
  }

  return (
    <SubTitle title={t('setting_lyric_desktop_direction')}>
      <View style={styles.list}>
        {
          list.map(({ id, name }) => <Item name={name} id={id} key={id} change={setDirection} />)
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
