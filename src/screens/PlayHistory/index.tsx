import { useCallback, useEffect, useState } from 'react'
import { FlatList, RefreshControl, TouchableOpacity, View } from 'react-native'
import PageContent from '@/components/PageContent'
import StatusBar from '@/components/common/StatusBar'
import SimpleHeader from '@/components/SimpleHeader'
import PlayerBar from '@/components/player/PlayerBar'
import Text from '@/components/common/Text'
import Image from '@/components/common/Image'
import { setComponentId } from '@/core/common'
import { COMPONENT_IDS } from '@/config/constant'
import { addTempPlayList } from '@/core/player/tempPlayList'
import { getPlayHistory } from '@/utils/data'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'

const formatDate = (timestamp: number) => {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// 播放历史。这里只显示本机这份记录 —— 本机播放会一并上报到 QQ 的云端「最近播放」，
// 但那份不读回来（只写不读，见 core/qqMusicRecentPlay），要去 QQ 客户端那边看。
// 已播列表（随机模式的去重表）和这个没关系，见 core/player/playedList。
export default ({ componentId }: { componentId: string }) => {
  const t = useI18n()
  const theme = useTheme()
  const [local, setLocal] = useState<LX.Player.PlayHistoryItem[]>([])
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    setComponentId(COMPONENT_IDS.playHistory, componentId)
    void getPlayHistory().then(setLocal)
    // 事件里已经带着最新的整份历史，别再回头读一次存储
    const handleUpdate = (history: LX.Player.PlayHistoryItem[]) => { setLocal(history) }
    global.app_event.on('playHistoryUpdate', handleUpdate)
    return () => { global.app_event.off('playHistoryUpdate', handleUpdate) }
  }, [componentId])

  const refresh = useCallback(async() => {
    setRefreshing(true)
    try {
      setLocal(await getPlayHistory())
    } finally {
      setRefreshing(false)
    }
  }, [])

  return (
    <PageContent>
      <StatusBar />
      <SimpleHeader componentId={componentId} title={t('nav_history')} />
      <FlatList
        style={styles.list}
        data={local}
        keyExtractor={(item, index) => `${item.musicInfo.id}-${item.playedAt}-${index}`}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void refresh() }} colors={[theme['c-primary']]} />}
        ListEmptyComponent={<Text style={styles.empty} color={theme['c-font-label']}>{t('setting_play_history_empty')}</Text>}
        renderItem={({ item }) => {
          // 播放历史里的条目可能是「下载列表」那种旧结构，取真实歌曲信息时要拆一层
          const info = 'metadata' in item.musicInfo ? item.musicInfo.metadata.musicInfo : item.musicInfo
          return (
            <TouchableOpacity
              style={{ ...styles.item, borderBottomColor: theme['c-border-background'] }}
              activeOpacity={0.7}
              onPress={() => { addTempPlayList([{ listId: null, musicInfo: info, isTop: true }]) }}
            >
              {info.meta.picUrl
                ? <Image url={info.meta.picUrl} style={styles.pic} />
                : <View style={{ ...styles.pic, backgroundColor: theme['c-primary-background'] }} />}
              <View style={styles.info}>
                <Text numberOfLines={1}>{info.name}</Text>
                <Text numberOfLines={1} size={12} color={theme['c-font-label']}>{info.singer}</Text>
                <Text size={11} color={theme['c-font-label']}>{formatDate(item.playedAt)}</Text>
              </View>
            </TouchableOpacity>
          )
        }}
      />
      <PlayerBar />
    </PageContent>
  )
}

const styles = createStyle({
  list: { flex: 1 },
  item: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: 1 },
  pic: { width: 48, height: 48, borderRadius: 3, marginRight: 10 },
  info: { flex: 1 },
  empty: { textAlign: 'center', paddingVertical: 40 },
})
