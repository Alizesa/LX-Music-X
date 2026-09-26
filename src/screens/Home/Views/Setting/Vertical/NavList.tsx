import { memo, useCallback, useState } from 'react'
import { View, TouchableOpacity } from 'react-native'

import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'
import Text from '@/components/common/Text'
import { SETTING_GROUPS, type SettingGroupIds, type SettingScreenIds } from '../Main'
import { useI18n } from '@/lang'
import { BorderRadius, BorderWidths } from '@/theme'


const ListItem = memo(({ id, activeId, onPress }: {
  onPress: (item: SettingScreenIds) => void
  activeId: string
  id: SettingScreenIds
}) => {
  const theme = useTheme()
  const t = useI18n()

  const active = activeId == id

  const handlePress = () => {
    onPress(id)
  }

  return (
    <View style={{ ...styles.listItem, backgroundColor: active ? theme['c-primary-background-active'] : 'transparent' }}>
      <TouchableOpacity style={styles.listName} onPress={handlePress}>
        <Text numberOfLines={1} color={active ? theme['c-primary-font'] : theme['c-font']}>{t(`setting_${id}`)}</Text>
      </TouchableOpacity>
    </View>
  )
}, (prevProps, nextProps) => {
  return !!(prevProps.id === nextProps.id &&
    prevProps.activeId != nextProps.id &&
    nextProps.activeId != nextProps.id
  )
})


export default ({ onChangeId }: {
  onChangeId: (id: SettingScreenIds) => void
}) => {
  const t = useI18n()
  const initialGroup = (Object.keys(SETTING_GROUPS) as SettingGroupIds[]).find(group => (SETTING_GROUPS[group] as readonly SettingScreenIds[]).includes(global.lx.settingActiveId)) ?? 'basic'
  const [activeId, setActiveId] = useState<SettingScreenIds>(global.lx.settingActiveId)
  const [activeGroup, setActiveGroup] = useState<SettingGroupIds>(initialGroup)
  const theme = useTheme()

  const handleGroupChange = (group: SettingGroupIds) => {
    setActiveGroup(group)
    const nextId = (SETTING_GROUPS[group] as readonly SettingScreenIds[]).includes(activeId) ? activeId : SETTING_GROUPS[group][0]
    handleChangeId(nextId)
  }

  const handleChangeId = useCallback((id: SettingScreenIds) => {
    onChangeId(id)
    setActiveId(id)
    global.lx.settingActiveId = id
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <View style={styles.groupNav}>
      {(Object.keys(SETTING_GROUPS) as SettingGroupIds[]).map(group => <TouchableOpacity key={group} onPress={() => { handleGroupChange(group) }} style={{ ...styles.groupItem, backgroundColor: group == activeGroup ? theme['c-primary-background-active'] : 'transparent' }}>
        <Text numberOfLines={1} color={group == activeGroup ? theme['c-primary-font'] : theme['c-font']}>{t(`setting_group_${group}`)}</Text>
      </TouchableOpacity>)}
      <View style={{ ...styles.subNav, borderTopColor: theme['c-border-background'] }}>
        {(SETTING_GROUPS[activeGroup] as readonly SettingScreenIds[]).map(id => <ListItem key={id} id={id} activeId={activeId} onPress={handleChangeId} />)}
      </View>
    </View>
  )
}


const styles = createStyle({
  container: {
    height: 50,
    flexGrow: 0,
    flexShrink: 0,
    borderBottomWidth: BorderWidths.normal,
    opacity: 0.7,
  },
  groupNav: { paddingTop: 5 },
  groupItem: { minHeight: 42, justifyContent: 'center', paddingHorizontal: 12, marginHorizontal: 5, borderRadius: BorderRadius.normal },
  subNav: { borderTopWidth: BorderWidths.normal, marginTop: 8, paddingTop: 8 },
  contentContainer: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    padding: 5,
    // backgroundColor: 'rgba(0, 0, 0, 0.1)',
  },
  // listContainer: {
  //   // borderBottomWidth: BorderWidths.normal2,
  // },

  listItem: {
    // width: '33.33%',
    height: 40,
    paddingLeft: 15,
    paddingRight: 15,
    // height: 'auto',
    // flexDirection: 'row',
    // alignItems: 'center',
    paddingHorizontal: 5,
    // paddingVertical: 10,
    borderRadius: BorderRadius.normal,
    marginBottom: 5,
    // backgroundColor: 'rgba(0,0,0,0.1)',
  },
  listName: {
    justifyContent: 'center',
    alignItems: 'center',
    flex: 1,
    // paddingLeft: 5,
    // backgroundColor: 'rgba(0,0,0,0.1)',
  },
})
