import { memo, useMemo } from 'react'

import { View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import CheckBox from '@/components/common/CheckBox'
import { useSettingValue } from '@/store/setting/hook'
import { useI18n } from '@/lang'
import { setDesktopLyricVertical, setDesktopLyricVerticalRotateLatin } from '@/core/desktopLyric'
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
  const rotateLatin = useSettingValue('desktopLyric.verticalRotateLatin')
  const list = useMemo(() => {
    return DIRECTION_LIST.map(id => ({ id, name: t(`setting_lyric_desktop_direction_${id}`) }))
  }, [t])

  const setDirection = (id: DIRECTION_TYPE) => {
    const isVertical = id == 'vertical'
    void setDesktopLyricVertical(isVertical).then(() => {
      updateSetting({ 'desktopLyric.isVertical': isVertical })
    })
  }
  // 竖排时英文逐字母正着堆叠，一个词被拆成一列互不相连的字母，不好看也不好读。
  // 打开这项就把一串拉丁字母整体横倒 90°（歪头看是连续的），中文照旧逐字竖排
  const setRotateLatin = (rotate: boolean) => {
    void setDesktopLyricVerticalRotateLatin(rotate).then(() => {
      updateSetting({ 'desktopLyric.verticalRotateLatin': rotate })
    })
  }

  return (
    <SubTitle title={t('setting_lyric_desktop_direction')}>
      <View style={styles.list}>
        {
          list.map(({ id, name }) => <Item name={name} id={id} key={id} change={setDirection} />)
        }
      </View>
      {/* 竖排的附加项，跟上面两个方向选项挤在同一块里。以前它是独立的一项、排在「显示方向」
          下面，而这块 SubTitle 自带 18 的下边距，于是它跟上面之间平白空出一截 */}
      <View style={styles.rotateLatin}>
        <CheckBox marginBottom={3} check={rotateLatin} label={t('setting_lyric_desktop_vertical_rotate_latin')} onChange={setRotateLatin} />
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
  rotateLatin: {
    marginTop: 5,
  },
})
