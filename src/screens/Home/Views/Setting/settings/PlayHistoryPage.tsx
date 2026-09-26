import { memo, useCallback, useEffect, useState } from 'react'
import { Alert, FlatList, Image, TouchableOpacity, View } from 'react-native'
import Section from '../components/Section'
import Text from '@/components/common/Text'
import { useI18n } from '@/lang'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'
import { addTempPlayList } from '@/core/player/tempPlayList'
import { clearPlayHistory, getPlayHistory, savePlayHistory } from '@/utils/data'

const formatDate = (timestamp: number) => {
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const [list, setList] = useState<LX.Player.PlayHistoryItem[]>([])

  const load = useCallback(() => {
    void getPlayHistory().then(setList)
  }, [])
  useEffect(() => {
    load()
    const handleUpdate = (history: LX.Player.PlayHistoryItem[]) => { setList(history) }
    global.app_event.on('playHistoryUpdate', handleUpdate)
    return () => { global.app_event.off('playHistoryUpdate', handleUpdate) }
  }, [load])

  const remove = (index: number) => {
    const next = list.filter((_, itemIndex) => itemIndex !== index)
    setList(next)
    void savePlayHistory(next)
    global.app_event.playHistoryUpdate(next)
  }
  const clear = () => {
    Alert.alert(t('setting_play_history_clear_title'), t('setting_play_history_clear_tip'), [
      { text: t('cancel'), style: 'cancel' },
      { text: t('confirm'), style: 'destructive', onPress: () => { setList([]); void clearPlayHistory(); global.app_event.playHistoryUpdate([]) } },
    ])
  }

  return <Section title={t('setting_history')} right={
    <TouchableOpacity style={styles.clear} onPress={clear} disabled={!list.length}>
      <Text color={theme['c-primary']} size={13}>{t('setting_play_history_clear')}</Text>
    </TouchableOpacity>
  }>
    <FlatList
      style={styles.list}
      data={list}
      keyExtractor={item => `${item.musicInfo.id}-${item.playedAt}`}
      ListEmptyComponent={<Text style={styles.empty} color={theme['c-font-label']}>{t('setting_play_history_empty')}</Text>}
      renderItem={({ item, index }) => {
        const info = 'metadata' in item.musicInfo ? item.musicInfo.metadata.musicInfo : item.musicInfo
        return <View key={`${info.id}-${item.playedAt}`} style={{ ...styles.item, borderBottomColor: theme['c-border-background'] }}>
              <TouchableOpacity style={styles.main} onPress={() => { addTempPlayList([{ listId: null, musicInfo: info, isTop: true }]) }}>
                {info.meta.picUrl ? <Image source={{ uri: info.meta.picUrl }} style={styles.pic} /> : <View style={{ ...styles.pic, backgroundColor: theme['c-primary-background'] }} />}
                <View style={styles.info}>
                  <Text numberOfLines={1}>{info.name}</Text>
                  <Text numberOfLines={1} size={12} color={theme['c-font-label']}>{info.singer}</Text>
                  <Text size={11} color={theme['c-font-label']}>{formatDate(item.playedAt)}</Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity style={styles.remove} onPress={() => { remove(index) }}><Text color={theme['c-font-label']}>×</Text></TouchableOpacity>
            </View>
      }}
    />
  </Section>
})

const styles = createStyle({
  clear: { paddingHorizontal: 8, paddingVertical: 4, marginBottom: 10 },
  list: { maxHeight: 600 },
  item: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1 },
  main: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  pic: { width: 48, height: 48, borderRadius: 3, marginRight: 10 },
  info: { flex: 1 },
  remove: { padding: 10 },
  empty: { textAlign: 'center', paddingVertical: 25 },
})
