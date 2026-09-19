import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, FlatList, RefreshControl, TouchableOpacity, View } from 'react-native'
import Text from '@/components/common/Text'
import { Icon } from '@/components/common/Icon'
import QQMusicLoginModal, { type QQMusicLoginModalType } from '@/components/QQMusicLoginModal'
import QQMusicCookieModal, { type QQMusicCookieModalType } from '@/components/QQMusicCookieModal'
import { useTheme } from '@/store/theme/hook'
import { createStyle, toast } from '@/utils/tools'
import {
  clearQQMusicSession,
  getQQMusicDailyRecommendations,
  getQQMusicPlaylistSongs,
  getQQMusicPlaylists,
  getQQMusicRecommendedPlaylists,
  getQQMusicSession,
} from '@/core/qqMusic'
import { initQQMusicRecommendAutoRefresh } from '@/core/qqMusicRecommend'
import { createList, setTempList } from '@/core/list'
import { playList } from '@/core/player/player'
import { LIST_IDS } from '@/config/constant'
import {
  getQQMusicDailyRecommendCache,
  getQQMusicPlaylistsCache,
  getQQMusicRecommendPlaylistsCache,
  saveQQMusicDailyRecommendCache,
  saveQQMusicPlaylistsCache,
  saveQQMusicRecommendPlaylistsCache,
} from '@/utils/data'
import { useI18n } from '@/lang'

const DAILY_RECOMMEND_LIST_ID = 'qq_daily_recommend'

type Row =
  | { kind: 'header', key: string, title: string }
  | { kind: 'playlist', key: string, playlist: LX.QQMusic.PlaylistInfo, origin: 'recommend' | 'mine' }
  | { kind: 'loadMore', key: string }
  | { kind: 'hint', key: string, text: string }

const ActionButton = ({ icon, label, onPress, disabled = false }: { icon: string, label: string, onPress: () => void, disabled?: boolean }) => {
  const theme = useTheme()
  return (
    <TouchableOpacity disabled={disabled} style={{ ...styles.actionButton, backgroundColor: theme['c-button-background'], opacity: disabled ? 0.45 : 1 }} onPress={onPress}>
      <Icon name={icon} color={theme['c-button-font']} size={16} />
      <Text color={theme['c-button-font']} style={styles.actionLabel}>{label}</Text>
    </TouchableOpacity>
  )
}

export default () => {
  const theme = useTheme()
  const t = useI18n()
  const loginRef = useRef<QQMusicLoginModalType>(null)
  const cookieLoginRef = useRef<QQMusicCookieModalType>(null)
  const [cookie, setCookie] = useState('')
  const [user, setUser] = useState<LX.QQMusic.UserInfo | null>(null)
  const [playlists, setPlaylists] = useState<LX.QQMusic.PlaylistInfo[]>([])
  const [recommendations, setRecommendations] = useState<LX.Music.MusicInfoOnline[]>([])
  const [recommended, setRecommended] = useState<LX.QQMusic.PlaylistInfo[]>([])
  const [recommendHasMore, setRecommendHasMore] = useState(false)
  const [recommendNextFrom, setRecommendNextFrom] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [playing, setPlaying] = useState(false)

  const loggedIn = !!cookie && !!user

  useEffect(() => {
    void getQQMusicSession().then(session => {
      setCookie(session.cookie)
      setUser(session.user)
      // 全部从本地缓存读，进页面不发任何网络请求。
      // 推荐歌单匿名也能看，所以不依赖登录状态。
      void Promise.all([
        session.cookie ? getQQMusicPlaylistsCache() : Promise.resolve([]),
        session.cookie ? getQQMusicDailyRecommendCache() : Promise.resolve([]),
        getQQMusicRecommendPlaylistsCache(),
      ]).then(([cachedPlaylists, cachedRecommendations, cachedRecommended]) => {
        setPlaylists(cachedPlaylists)
        setRecommendations(cachedRecommendations)
        if (cachedRecommended) {
          setRecommended(cachedRecommended.list)
          setRecommendHasMore(cachedRecommended.hasMore)
          setRecommendNextFrom(cachedRecommended.nextFrom)
        }
      })
    })
    const handleAccountUpdate = (nextUser: LX.QQMusic.UserInfo | null) => {
      setUser(nextUser)
      void getQQMusicSession().then(session => { setCookie(session.cookie) })
    }
    global.app_event.on('qqMusicAccountUpdated', handleAccountUpdate)
    return () => { global.app_event.off('qqMusicAccountUpdated', handleAccountUpdate) }
  }, [])

  const ensureLogin = useCallback(() => {
    if (loggedIn) return true
    loginRef.current?.show()
    return false
  }, [loggedIn])

  // 唯一的联网入口，由「刷新」按钮和下拉刷新触发。
  // 推荐歌单登录时带票据、未登录走匿名，两条路都能用。
  const refresh = useCallback(async() => {
    setRefreshing(true)
    try {
      const [recommendResult] = await Promise.all([
        getQQMusicRecommendedPlaylists(cookie, 0),
        // 未登录时跳过需要账号的两个接口，避免无谓的失败请求
        loggedIn
          ? Promise.all([getQQMusicPlaylists(cookie), getQQMusicDailyRecommendations(cookie)]).then(async([nextPlaylists, nextRecommendations]) => {
            setPlaylists(nextPlaylists)
            setRecommendations(nextRecommendations)
            await Promise.all([
              saveQQMusicPlaylistsCache(nextPlaylists),
              saveQQMusicDailyRecommendCache(nextRecommendations),
            ])
          })
          : Promise.resolve(),
      ])
      // 刷新是替换而不是追加，所以游标从这一批的末尾重新算
      setRecommended(recommendResult.list)
      setRecommendHasMore(recommendResult.hasMore)
      setRecommendNextFrom(recommendResult.nextFrom)
      await saveQQMusicRecommendPlaylistsCache(recommendResult)
    } catch (error: unknown) {
      toast(error instanceof Error ? error.message : t('qq_load_failed'), 'long')
    } finally {
      setRefreshing(false)
    }
  }, [cookie, loggedIn, t])

  const loadMoreRecommended = useCallback(async() => {
    if (loadingMore || !recommendHasMore) return
    setLoadingMore(true)
    try {
      const result = await getQQMusicRecommendedPlaylists(cookie, recommendNextFrom)
      // 追加，并按 id 去重：推荐流在不同游标下可能给出重复项
      const merged = [...recommended, ...result.list].filter((item, index, all) =>
        all.findIndex(other => other.id === item.id) === index)
      setRecommended(merged)
      setRecommendHasMore(result.hasMore)
      setRecommendNextFrom(result.nextFrom)
      await saveQQMusicRecommendPlaylistsCache({ list: merged, hasMore: result.hasMore, nextFrom: result.nextFrom })
    } catch (error: unknown) {
      toast(error instanceof Error ? error.message : t('qq_load_failed'), 'long')
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, recommendHasMore, recommendNextFrom, recommended, cookie, t])

  const playRecommendations = useCallback(async() => {
    if (!ensureLogin()) return
    setPlaying(true)
    try {
      let songs = recommendations
      // 有缓存就直接播，零网络请求；只有从未拉取过才联网
      if (!songs.length) {
        songs = await getQQMusicDailyRecommendations(cookie)
        if (!songs.length) throw new Error(t('qq_load_failed'))
        setRecommendations(songs)
        await saveQQMusicDailyRecommendCache(songs)
      }
      await setTempList(DAILY_RECOMMEND_LIST_ID, songs)
      // 播放过程中接近播完时自动续下一批，不再只是循环这 20 首
      initQQMusicRecommendAutoRefresh()
      void playList(LIST_IDS.TEMP, 0)
    } catch (error: unknown) {
      toast(error instanceof Error ? error.message : t('qq_load_failed'), 'long')
    } finally {
      setPlaying(false)
    }
  }, [cookie, ensureLogin, recommendations, t])

  const importPlaylist = async(info: LX.QQMusic.PlaylistInfo) => {
    try {
      const songs = await getQQMusicPlaylistSongs(cookie, info.id)
      // 具体原因要透出来：早先统一吞成"导入失败"，排查时看不到是接口出错还是歌单为空
      if (!songs.length) throw new Error(t('qq_import_empty'))
      await createList({ name: `QQ · ${info.name}`, source: 'tx', sourceListId: info.id, list: songs })
      toast(t('qq_import_success'))
    } catch (error: unknown) {
      toast(error instanceof Error ? error.message : t('qq_import_failed'), 'long')
    }
  }

  const logout = () => {
    Alert.alert(t('qq_logout_title'), t('qq_logout_message'), [
      { text: t('cancel'), style: 'cancel' },
      { text: t('confirm'), style: 'destructive', onPress: () => { void clearQQMusicSession().then(() => { setCookie(''); setUser(null); setPlaylists([]); setRecommendations([]); setRecommended([]); setRecommendHasMore(false); setRecommendNextFrom(0); global.app_event.qqMusicAccountUpdated(null) }) } },
    ])
  }

  const rows = useMemo<Row[]>(() => {
    const result: Row[] = []
    result.push({ kind: 'header', key: 'h-recommend', title: t('qq_recommend_playlists') })
    if (recommended.length) {
      for (const playlist of recommended) result.push({ kind: 'playlist', key: `r-${playlist.id}`, playlist, origin: 'recommend' })
      if (recommendHasMore) result.push({ kind: 'loadMore', key: 'load-more' })
    } else {
      result.push({ kind: 'hint', key: 'h-recommend-empty', text: t('qq_recommend_empty') })
    }
    result.push({ kind: 'header', key: 'h-mine', title: t('qq_my_playlists') })
    if (!loggedIn) {
      result.push({ kind: 'hint', key: 'h-mine-login', text: t('qq_login_hint') })
    } else if (playlists.length) {
      for (const playlist of playlists) result.push({ kind: 'playlist', key: `m-${playlist.id}`, playlist, origin: 'mine' })
    } else {
      result.push({ kind: 'hint', key: 'h-mine-empty', text: t('qq_load_hint') })
    }
    return result
  }, [recommended, recommendHasMore, playlists, loggedIn, t])

  const renderRow = ({ item }: { item: Row }) => {
    switch (item.kind) {
      case 'header':
        return <View style={styles.sectionHeader}><Text size={15}>{item.title}</Text></View>
      case 'hint':
        return <Text style={styles.empty} color={theme['c-font-label']}>{item.text}</Text>
      case 'loadMore':
        return (
          <TouchableOpacity style={styles.loadMore} disabled={loadingMore} onPress={() => { void loadMoreRecommended() }}>
            <Text size={13} color={theme['c-primary-font']}>{loadingMore ? t('qq_loading') : t('qq_load_more')}</Text>
          </TouchableOpacity>
        )
      default: {
        const { playlist, origin } = item
        const count = playlist.trackCount ? `${playlist.trackCount} ${t('qq_songs')}` : t('qq_playlist')
        // 推荐歌单没有「自建/收藏」的概念，只显示歌曲数
        const meta = origin === 'recommend'
          ? count
          : `${t(playlist.subscribed ? 'qq_playlist_collected' : 'qq_playlist_created')} · ${count}`
        return (
          <View style={styles.playlistItem}>
            <View style={styles.playlistInfo}>
              <Text numberOfLines={1}>{playlist.name}</Text>
              <Text size={12} color={theme['c-font-label']}>{meta}</Text>
            </View>
            <TouchableOpacity onPress={() => { void importPlaylist(playlist) }} style={styles.importButton}>
              <Icon name="add-music" color={theme['c-primary-font']} size={18} />
            </TouchableOpacity>
          </View>
        )
      }
    }
  }

  return (
    <View style={{ ...styles.container, backgroundColor: theme['c-content-background'] }}>
      <View style={styles.header}>
        <View style={styles.accountInfo}>
          <Text size={17}>{user ? user.nickname : t('qq_not_logged_in')}</Text>
          {user ? <Text size={12} color={theme['c-font-label']}>{user.uin ? `QQ ${user.uin}` : t('qq_logged_in')}</Text> : null}
        </View>
        {!user ? <ActionButton icon="setting" label={t('qq_cookie_login')} onPress={() => cookieLoginRef.current?.show()} /> : null}
        <ActionButton icon={user ? 'exit' : 'play-outline'} label={user ? t('qq_logout') : t('qq_login')} onPress={user ? logout : () => loginRef.current?.show()} />
      </View>
      <View style={styles.toolbar}>
        <ActionButton icon="play-outline" label={t('qq_daily_recommend')} onPress={() => { void playRecommendations() }} disabled={!loggedIn || playing} />
        <ActionButton icon="available_updates" label={t('qq_refresh')} onPress={() => { void refresh() }} disabled={refreshing} />
      </View>
      <FlatList
        data={rows}
        keyExtractor={item => item.key}
        style={styles.list}
        renderItem={renderRow}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void refresh() }} colors={[theme['c-primary']]} />}
      />
      <QQMusicLoginModal ref={loginRef} onLoggedIn={nextUser => { setUser(nextUser); void getQQMusicSession().then(session => { setCookie(session.cookie) }) }} />
      <QQMusicCookieModal ref={cookieLoginRef} onLoggedIn={nextUser => { setUser(nextUser); void getQQMusicSession().then(session => { setCookie(session.cookie) }) }} />
    </View>
  )
}

const styles = createStyle({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12 },
  accountInfo: { flex: 1 },
  toolbar: { flexDirection: 'row', paddingHorizontal: 14, paddingBottom: 10 },
  actionButton: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 8, borderRadius: 4, marginRight: 8 },
  actionLabel: { marginLeft: 5 },
  list: { flex: 1 },
  sectionHeader: { paddingHorizontal: 14, paddingTop: 14, paddingBottom: 6 },
  playlistItem: { flexDirection: 'row', alignItems: 'center', minHeight: 58, paddingHorizontal: 14, borderBottomWidth: 1 },
  playlistInfo: { flex: 1 },
  importButton: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center' },
  loadMore: { height: 48, alignItems: 'center', justifyContent: 'center' },
  empty: { textAlign: 'center', paddingVertical: 20 },
})
