import { memo } from 'react'
import { FlatList, type FlatListProps } from 'react-native'

import { createStyle } from '@/utils/tools'
import { SETTING_COMPONENTS, SETTING_SCREENS, type SettingScreenIds } from '../Main'

type FlatListType = FlatListProps<SettingScreenIds>


const styles = createStyle({
  content: {
    paddingLeft: 15,
    paddingRight: 15,
    paddingTop: 15,
    paddingBottom: 15,
    flex: 0,
  },
})

// 组件从 SETTING_COMPONENTS 取，不再本地维护一份 switch：
// 两份列表曾经不同步，导致新增的分区在竖屏下不显示
const ListItem = memo(({
  id,
}: { id: SettingScreenIds }) => {
  const SectionComponent = SETTING_COMPONENTS[id]
  return <SectionComponent />
}, () => true)

export default () => {
  const renderItem: FlatListType['renderItem'] = ({ item }) => <ListItem id={item} />
  const getkey: FlatListType['keyExtractor'] = item => item

  return (
    <FlatList
      data={SETTING_SCREENS}
      keyboardShouldPersistTaps={'always'}
      renderItem={renderItem}
      keyExtractor={getkey}
      contentContainerStyle={styles.content}
      maxToRenderPerBatch={2}
      // updateCellsBatchingPeriod={80}
      windowSize={2}
      // removeClippedSubviews={true}
      initialNumToRender={1}
    />
  )
}
