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
import { getQQMusicRecentSongs, getQQMusicSession } from '@/core/qqMusic'
import { getPlayHistory } from '@/utils/data'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'

type Row =
  | { kind: 'header', key: string, title: string }
  | { kind: 'item', key: string, item: LX.Player.PlayHistoryItem }

const formatDate = (timestamp: number) => {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// 最近播放：本机记录 + QQ 云端记录两个来源。
// 云端只补本机没有的（按歌曲 id 去重），所以同一次播放不会出现两行。
export default ({ componentId }: { componentId: string }) => {
  const t = useI18n()
  const theme = useTheme()
  const [local, setLocal] = useState<LX.Player.PlayHistoryItem[]>([])
  const [cloud, setCloud] = useState<LX.Player.PlayHistoryItem[]>([])
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    setComponentId(COMPONENT_IDS.playHistory, componentId)
    const loadLocal = () => { void getPlayHistory().then(setLocal) }
    loadLocal()
    global.app_event.on('playHistoryUpdate', loadLocal)
    return () => { global.app_event.off('playHistoryUpdate', loadLocal) }
  }, [componentId])

  const loadCloud = useCallback(async() => {
    const { cookie } = await getQQMusicSession()
    // 没登录就没有云端记录，静默跳过（本机记录照常显示）
    if (!cookie) {
      setCloud([])
      return
    }
    try {
      setCloud(await getQQMusicRecentSongs(cookie))
    } catch {
      // 云端失败不该把本机记录一起废掉，保持上一次的结果
    }
  }, [])

  useEffect(() => { void loadCloud() }, [loadCloud])

  const refresh = useCallback(async() => {
    setRefreshing(true)
    try {
      setLocal(await getPlayHistory())
      await loadCloud()
    } finally {
      setRefreshing(false)
    }
  }, [loadCloud])

  const localIds = new Set(local.map(item => item.musicInfo.id))
  const cloudOnly = cloud.filter(item => !localIds.has(item.musicInfo.id))

  const rows: Row[] = [
    ...(local.length ? [{ kind: 'header' as const, key: 'h-local', title: t('setting_history') }] : []),
    ...local.map((item, index) => ({ kind: 'item' as const, key: `l-${item.musicInfo.id}-${item.playedAt}-${index}`, item })),
    ...(cloudOnly.length ? [{ kind: 'header' as const, key: 'h-cloud', title: t('mine_cloud_history') }] : []),
    ...cloudOnly.map((item, index) => ({ kind: 'item' as const, key: `c-${item.musicInfo.id}-${item.playedAt}-${index}`, item })),
  ]

  return (
    <PageContent>
      <StatusBar />
      <SimpleHeader componentId={componentId} title={t('nav_history')} />
      <FlatList
        style={styles.list}
        data={rows}
        keyExtractor={row => row.key}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void refresh() }} colors={[theme['c-primary']]} />}
        ListEmptyComponent={<Text style={styles.empty} color={theme['c-font-label']}>{t('setting_play_history_empty')}</Text>}
        renderItem={({ item: row }) => {
          if (row.kind == 'header') {
            return <Text style={styles.sectionTitle} size={13} color={theme['c-font-label']}>{row.title}</Text>
          }
          // 播放历史里的条目可能是「下载列表」那种旧结构，取真实歌曲信息时要拆一层
          const info = 'metadata' in row.item.musicInfo ? row.item.musicInfo.metadata.musicInfo : row.item.musicInfo
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
                <Text size={11} color={theme['c-font-label']}>{formatDate(row.item.playedAt)}</Text>
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
  sectionTitle: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6 },
  item: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: 1 },
  pic: { width: 48, height: 48, borderRadius: 3, marginRight: 10 },
  info: { flex: 1 },
  empty: { textAlign: 'center', paddingVertical: 40 },
})
