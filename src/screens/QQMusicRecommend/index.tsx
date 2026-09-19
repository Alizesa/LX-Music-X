import { useCallback, useEffect, useRef, useState } from 'react'
import { FlatList, RefreshControl, TouchableOpacity, View } from 'react-native'
import Text from '@/components/common/Text'
import { Icon } from '@/components/common/Icon'
import Image from '@/components/common/Image'
import PageContent from '@/components/PageContent'
import StatusBar from '@/components/common/StatusBar'
import PlayerBar from '@/components/player/PlayerBar'
import { navigations, pop } from '@/navigation'
import { setComponentId } from '@/core/common'
import { COMPONENT_IDS } from '@/config/constant'
import commonState from '@/store/common/state'
import { useTheme } from '@/store/theme/hook'
import { useStatusbarHeight } from '@/store/common/hook'
import { createStyle, toast } from '@/utils/tools'
import { getQQMusicRecommendedPlaylists, getQQMusicSession } from '@/core/qqMusic'
import { getQQMusicRecommendPlaylistsCache, saveQQMusicRecommendPlaylistsCache } from '@/utils/data'
import { useI18n } from '@/lang'

const HEADER_HEIGHT = 50

export default ({ componentId }: { componentId: string }) => {
  const theme = useTheme()
  const t = useI18n()
  const statusBarHeight = useStatusbarHeight()
  const [list, setList] = useState<LX.QQMusic.PlaylistInfo[]>([])
  const [loading, setLoading] = useState(false)
  // 下一批从哪取。刷新是换批而不是重取，所以要跨次记住游标
  const nextFromRef = useRef(0)
  const initedRef = useRef(false)

  const load = useCallback(async() => {
    setLoading(true)
    try {
      const { cookie } = await getQQMusicSession()
      const result = await getQQMusicRecommendedPlaylists(cookie, nextFromRef.current)
      setList(result.list)
      // 取尽后回到开头，这样能一直「一批批」换下去而不是停在最后一批
      nextFromRef.current = result.hasMore ? result.nextFrom : 0
      await saveQQMusicRecommendPlaylistsCache({ list: result.list, hasMore: result.hasMore, nextFrom: nextFromRef.current })
    } catch (error: unknown) {
      toast(error instanceof Error ? error.message : t('qq_load_failed'), 'long')
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    setComponentId(COMPONENT_IDS.qqMusicRecommend, componentId)
    void getQQMusicRecommendPlaylistsCache().then(cache => {
      if (initedRef.current) return
      initedRef.current = true
      if (cache) {
        // 有缓存就先显示，不联网
        setList(cache.list)
        nextFromRef.current = cache.nextFrom
        return
      }
      // 从没加载过，取一批；之后打开都直接用缓存
      void load()
    })
  }, [componentId, load])

  const back = () => {
    void pop(commonState.componentIds.qqMusicRecommend!)
  }

  const openPlaylist = (playlist: LX.QQMusic.PlaylistInfo) => {
    navigations.pushSonglistDetailScreen(componentId, {
      id: playlist.id,
      name: playlist.name,
      author: playlist.author ?? '',
      img: playlist.cover,
      desc: playlist.description,
      source: 'tx',
      total: playlist.trackCount ? String(playlist.trackCount) : undefined,
    })
  }

  const renderItem = ({ item }: { item: LX.QQMusic.PlaylistInfo }) => (
    <TouchableOpacity style={{ ...styles.item, borderBottomColor: theme['c-border-background'] }} onPress={() => { openPlaylist(item) }}>
      {item.cover ? <Image url={item.cover} style={styles.cover} /> : <View style={{ ...styles.cover, backgroundColor: theme['c-border-background'] }} />}
      <View style={styles.info}>
        <Text numberOfLines={2}>{item.name}</Text>
        <Text size={12} color={theme['c-font-label']} numberOfLines={1}>
          {[item.author, item.trackCount ? `${item.trackCount} ${t('qq_songs')}` : ''].filter(Boolean).join(' · ')}
        </Text>
      </View>
    </TouchableOpacity>
  )

  return (
    <PageContent>
      <StatusBar />
      <View style={{ height: HEADER_HEIGHT + statusBarHeight, paddingTop: statusBarHeight, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: theme['c-border-background'] }}>
        <TouchableOpacity onPress={back} style={styles.backButton}>
          <Icon name="chevron-left" size={24} color={theme['c-font']} />
        </TouchableOpacity>
        <Text style={styles.title} size={18}>{t('qq_recommend_playlists')}</Text>
        <TouchableOpacity onPress={() => { void load() }} disabled={loading} style={styles.refreshButton}>
          <Text color={loading ? theme['c-font-label'] : theme['c-primary-font']}>{t('qq_refresh')}</Text>
        </TouchableOpacity>
      </View>
      <FlatList
        data={list}
        keyExtractor={item => item.id}
        style={styles.list}
        renderItem={renderItem}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => { void load() }} colors={[theme['c-primary']]} />}
        ListEmptyComponent={<Text style={styles.empty} color={theme['c-font-label']}>{loading ? t('qq_loading') : t('qq_recommend_empty')}</Text>}
      />
      <PlayerBar />
    </PageContent>
  )
}

const styles = createStyle({
  backButton: { width: 50, alignItems: 'center' },
  title: { flex: 1 },
  refreshButton: { paddingHorizontal: 14, paddingVertical: 8 },
  list: { flex: 1 },
  item: { flexDirection: 'row', alignItems: 'center', minHeight: 72, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: 1 },
  cover: { width: 56, height: 56, borderRadius: 4 },
  info: { flex: 1, paddingLeft: 12 },
  empty: { textAlign: 'center', paddingVertical: 40 },
})
