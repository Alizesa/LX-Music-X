import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, RefreshControl, ScrollView, TouchableOpacity, View } from 'react-native'
import Text from '@/components/common/Text'
import Image from '@/components/common/Image'
import { Icon } from '@/components/common/Icon'
import Loading from '@/components/common/Loading'
import StatusBar from '@/components/common/StatusBar'
import { createStyle, toast } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { useStatusbarHeight } from '@/store/common/hook'
import { getQQMusicDailyRecommendCache, getQQMusicRecommendPlaylistsCache, saveQQMusicDailyRecommendCache, saveQQMusicRecommendPlaylistsCache, saveLeaderboardSetting } from '@/utils/data'
import { getQQMusicDailyRecommendations, getQQMusicRecommendedPlaylists, getQQMusicSession } from '@/core/qqMusic'
import { RECOMMEND_TEMP_LIST_ID, initQQMusicRecommendAutoRefresh, markQQMusicViewDataRefreshed, shouldRefreshQQMusicViewData } from '@/core/qqMusicRecommend'
import { setTempList } from '@/core/list'
import { playList } from '@/core/player/player'
import { LIST_IDS } from '@/config/constant'
import { openQQPlaylist } from './openQQPlaylist'
import { navigations } from '@/navigation'
import commonState from '@/store/common/state'
import type { InitState as CommonState } from '@/store/common/state'

interface Props {
  /** 只用来跳转旧功能页；回仪表盘是底部 Tab 的事 */
  onModeChange: (id: CommonState['navActiveId']) => void
  onOpenMenu: () => void
}

// 四个入口各自去向不同。参考图上的“猜你喜欢”没有对应接口（我们那份推荐数据
// 本身就是猜你喜欢电台），已经去掉；“新歌新碟”接到 tx 新歌榜，不再和
// “分类歌单”落到同一个页面却点了没区别。
const shortcuts = [
  { icon: 'music_time', label: 'qq_daily_recommend', target: 'daily_rec' },
  { icon: 'available_updates', label: 'home_shortcut_new', target: 'new_songs' },
  { icon: 'leaderboard', label: 'nav_top', target: 'nav_top' },
  { icon: 'album', label: 'nav_songlist', target: 'nav_songlist' },
] as const

// 新歌榜在 tx 榜单里是固定 id。排行榜页是进页面时从本地设置读榜单的，
// 所以先写设置再进页面就能落到新歌榜上，不需要新接口。
// 代价：会把排行榜的音源固定成 QQ。
const TX_NEW_SONG_BOARD_ID = 'tx__27'

// 请求闸门的键。切 Tab、从旧功能页返回都会重新挂载这个页面，
// 闸门保证同一次启动内不会因此重复回源。
const VIEW_KEY = 'home'

export default ({ onModeChange, onOpenMenu }: Props) => {
  const theme = useTheme()
  const t = useI18n()
  const statusbarHeight = useStatusbarHeight()
  const [cookie, setCookie] = useState('')
  const [songs, setSongs] = useState<LX.Music.MusicInfoOnline[]>([])
  const [playlists, setPlaylists] = useState<LX.QQMusic.PlaylistInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  // 供 load 判断「是否已经有内容可显示」，用 ref 是为了不把 songs/playlists 塞进依赖
  const hasDataRef = useRef(false)

  const load = useCallback(async(refresh = false) => {
    if (refresh) setRefreshing(true)
    // 下拉刷新是一次明确的手势，直接回源；其余情况交给闸门
    const needFetch = refresh || shouldRefreshQQMusicViewData(VIEW_KEY)
    try {
      const session = await getQQMusicSession()
      setCookie(session.cookie)
      // 缓存先展示，避免网络慢时白屏
      const [cachedSongs, cachedPlaylists] = await Promise.all([
        getQQMusicDailyRecommendCache(),
        getQQMusicRecommendPlaylistsCache(),
      ])
      if (cachedSongs.length) {
        setSongs(cachedSongs)
        hasDataRef.current = true
      }
      if (cachedPlaylists?.list?.length) {
        setPlaylists(cachedPlaylists.list)
        hasDataRef.current = true
      }
      if (!needFetch) return

      // 两个请求互不依赖，并发发出，不要串行等两次往返
      try {
        const [playlistResult, recommendation] = await Promise.all([
          getQQMusicRecommendedPlaylists(session.cookie),
          session.cookie ? getQQMusicDailyRecommendations(session.cookie) : Promise.resolve([]),
        ])
        if (playlistResult.list.length) {
          setPlaylists(playlistResult.list)
          await saveQQMusicRecommendPlaylistsCache({ list: playlistResult.list, nextFrom: playlistResult.nextFrom })
        }
        if (recommendation.length) {
          setSongs(recommendation)
          await saveQQMusicDailyRecommendCache(recommendation)
        }
        markQQMusicViewDataRefreshed(VIEW_KEY)
      } catch (error) {
        // 有缓存就静默降级；什么都没有才提示，并且不记时间，下次进页面还能重试
        if (!hasDataRef.current) {
          setFailed(true)
          toast(error instanceof Error ? error.message : t('qq_load_failed'), 'long')
        }
      }
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [t])

  // 只在挂载时取一次；load 的身份会随语言变化，不能进依赖
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load() }, [])

  const playFrom = useCallback((index: number) => {
    // 首页和 QQ 音乐页播的是同一批每日推荐，必须共用 RECOMMEND_TEMP_LIST_ID，
    // 否则 qqMusicRecommend 的自动续播认不出来（它只认这个 id），播完就不再补歌
    void setTempList(RECOMMEND_TEMP_LIST_ID, songs).then(() => {
      initQQMusicRecommendAutoRefresh()
      void playList(LIST_IDS.TEMP, index)
    })
  }, [songs])

  const playRecommendations = useCallback(() => {
    if (!songs.length) {
      if (!cookie) {
        Alert.alert(t('qq_login_title'), t('home_login_message'), [
          { text: t('cancel'), style: 'cancel' },
          { text: t('qq_login'), onPress: () => { onModeChange('nav_qq') } },
        ])
        return
      }
      toast(t('home_empty_recommend'), 'long')
      return
    }
    playFrom(0)
  }, [cookie, onModeChange, playFrom, songs.length, t])

  // 每日推荐有自己的列表页，不再把人丢进 QQ 音乐页里再点一次
  const openDailyRec = () => {
    const componentId = commonState.componentIds.home
    if (componentId) navigations.pushQQMusicDailyRecScreen(componentId)
  }

  const handleShortcut = (target: typeof shortcuts[number]['target']) => {
    switch (target) {
      case 'daily_rec':
        openDailyRec()
        return
      // 必须等设置写完再进页面：排行榜是挂载时读设置的，早一步就还是旧榜单
      case 'new_songs':
        void saveLeaderboardSetting({ source: 'tx', boardId: TX_NEW_SONG_BOARD_ID }).then(() => { onModeChange('nav_top') })
        return
      default:
        onModeChange(target)
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme['c-content-background'] }}>
      <StatusBar />
      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void load(true) }} colors={[theme['c-primary']]} />}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ ...styles.header, paddingTop: statusbarHeight + 12 }}>
          <Text size={28} style={styles.title}>{t('home_title_recommend')}</Text>
          <TouchableOpacity style={styles.menuButton} onPress={onOpenMenu}>
            <Icon name="menu" size={24} color={theme['c-font']} />
          </TouchableOpacity>
        </View>
        <TouchableOpacity style={{ ...styles.search, backgroundColor: theme['c-primary-light-900-alpha-500'] }} onPress={() => { onModeChange('nav_search') }}>
          <Icon name="search-2" size={19} color={theme['c-font-label']} />
          <Text size={16} color={theme['c-font-label']} style={styles.searchText}>{t('home_search_placeholder')}</Text>
        </TouchableOpacity>
        <View style={styles.shortcuts}>
          {shortcuts.map(({ icon, label, target }) => (
            <TouchableOpacity key={label} style={styles.shortcut} onPress={() => { handleShortcut(target) }}>
              <View style={{ ...styles.shortcutIcon, backgroundColor: theme['c-primary'] }}><Icon name={icon} size={21} color="#fff" /></View>
              <Text size={12} style={styles.shortcutLabel}>{t(label)}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <SectionTitle title={t('home_section_hot_songs')} action={songs.length ? t('play') : undefined} onPress={playRecommendations} onMore={openDailyRec} />
        {songs.length
          ? songs.slice(0, 5).map((song, index) => (
              <TouchableOpacity key={`${song.id}-${index}`} style={styles.songRow} onPress={() => { playFrom(index) }}>
                <Image url={song.meta.picUrl} style={styles.cover} />
                <View style={styles.songInfo}>
                  <Text numberOfLines={1} size={15}>{song.name}</Text>
                  <Text numberOfLines={1} size={12} color={theme['c-font-label']}>{song.singer} - {song.meta.albumName}</Text>
                </View>
              </TouchableOpacity>
          ))
          : <StatusLine loading={loading} text={failed ? t('qq_load_failed') : cookie ? t('home_empty_recommend') : t('qq_login_hint')} />}
        <SectionTitle title={t('home_section_playlists')} />
        {playlists.length
          ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.playlistRow}>
                {playlists.slice(0, 8).map(item => (
                  <TouchableOpacity key={item.id} style={styles.playlistCard} onPress={() => { openQQPlaylist(item) }}>
                    <Image url={item.cover} style={styles.playlistCover} />
                    <Text numberOfLines={2} size={12} style={styles.playlistName}>{item.name}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )
          : <StatusLine loading={loading} text={t('home_empty_playlists')} />}
      </ScrollView>
    </View>
  )
}

const StatusLine = ({ loading, text }: { loading: boolean, text: string }) => {
  const theme = useTheme()
  const t = useI18n()
  return (
    <View style={styles.statusLine}>
      {loading ? <Loading size={16} label={t('qq_loading')} /> : <Text size={13} color={theme['c-font-label']}>{text}</Text>}
    </View>
  )
}

const SectionTitle = ({ title, action, onPress, onMore }: { title: string, action?: string, onPress?: () => void, onMore?: () => void }) => {
  const theme = useTheme()
  return (
    <View style={styles.sectionTitle}>
      <Text size={20} style={styles.sectionText}>{title}</Text>
      {action ? <TouchableOpacity onPress={onPress} style={{ ...styles.playAction, backgroundColor: theme['c-primary-light-900-alpha-500'] }}><Icon name="play-outline" size={14} color={theme['c-primary']} /><Text size={12} color={theme['c-primary']}>{action}</Text></TouchableOpacity> : null}
      {onMore ? <TouchableOpacity onPress={onMore} style={styles.moreButton}><Icon name="chevron-right" size={18} color={theme['c-font-label']} /></TouchableOpacity> : null}
    </View>
  )
}

const styles = createStyle({
  content: { paddingHorizontal: 16, paddingBottom: 24 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 14 },
  title: { fontWeight: '700' },
  menuButton: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center' },
  search: { height: 46, borderRadius: 24, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, marginBottom: 16 },
  searchText: { marginLeft: 10 },
  shortcuts: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 22 },
  shortcut: { alignItems: 'center', width: '23%' },
  shortcutIcon: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  shortcutLabel: { marginTop: 7, textAlign: 'center' },
  sectionTitle: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  sectionText: { fontWeight: '700', flex: 1 },
  playAction: { borderRadius: 16, paddingHorizontal: 10, paddingVertical: 6, flexDirection: 'row', alignItems: 'center', gap: 4 },
  moreButton: { paddingLeft: 8, paddingVertical: 4 },
  songRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  cover: { width: 54, height: 54, borderRadius: 8 },
  songInfo: { flex: 1, marginLeft: 12 },
  statusLine: { paddingVertical: 20, alignItems: 'center', justifyContent: 'center' },
  playlistRow: { gap: 12, paddingBottom: 20 },
  playlistCard: { width: 116 },
  playlistCover: { width: 116, height: 116, borderRadius: 10 },
  playlistName: { marginTop: 7 },
})
