import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, FlatList, RefreshControl, TouchableOpacity, View } from 'react-native'
import Text from '@/components/common/Text'
import { Icon } from '@/components/common/Icon'
import QQMusicLoginModal, { type QQMusicLoginModalType } from '@/components/QQMusicLoginModal'
import QQMusicCookieModal, { type QQMusicCookieModalType } from '@/components/QQMusicCookieModal'
import { useTheme } from '@/store/theme/hook'
import { createStyle, toast } from '@/utils/tools'
import { clearQQMusicSession, filterVisiblePlaylists, getQQMusicDailyRecommendations, getQQMusicPlaylistSongs, getQQMusicPlaylists, getQQMusicSession, isLikedPlaylist } from '@/core/qqMusic'
import { initQQMusicRecommendAutoRefresh } from '@/core/qqMusicRecommend'
import { createList, setTempList } from '@/core/list'
import { playList } from '@/core/player/player'
import { LIST_IDS } from '@/config/constant'
import { navigations } from '@/navigation'
import commonState from '@/store/common/state'
import { getQQMusicDailyRecommendCache, getQQMusicPlaylistsCache, saveQQMusicDailyRecommendCache, saveQQMusicPlaylistsCache } from '@/utils/data'
import { useI18n } from '@/lang'

const DAILY_RECOMMEND_LIST_ID = 'qq_daily_recommend'

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
  const [refreshing, setRefreshing] = useState(false)
  const [playing, setPlaying] = useState(false)
  const refreshingRef = useRef(false)

  const loggedIn = !!cookie && !!user

  useEffect(() => {
    void getQQMusicSession().then(session => {
      setCookie(session.cookie)
      setUser(session.user)
      // 歌单与推荐都直接读本地缓存，进页面不发任何网络请求
      if (!session.cookie) return
      void Promise.all([getQQMusicPlaylistsCache(), getQQMusicDailyRecommendCache()]).then(([cachedPlaylists, cachedRecommendations]) => {
        // 旧版本可能把服务端的虚拟歌单(QZone背景音乐、本地上传等)写进了缓存，读出来时再挡一次
        setPlaylists(filterVisiblePlaylists(cachedPlaylists))
        setRecommendations(cachedRecommendations)
      })
    })
    const handleAccountUpdate = (nextUser: LX.QQMusic.UserInfo | null) => {
      setUser(nextUser)
      // 退出登录（含票据失效被自动清理）时，把上一个账号的歌单和推荐从界面上撤掉，
      // 否则页面会挂着已经失效的账号数据
      if (!nextUser) {
        setPlaylists([])
        setRecommendations([])
      }
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

  // 唯一的联网入口，由「刷新」按钮和下拉刷新触发
  const refresh = useCallback(async() => {
    // setRefreshing 要到下次渲染才生效，光靠 disabled 挡不住这个窗口内的第二次触发
    if (refreshingRef.current) return
    if (!ensureLogin()) return
    refreshingRef.current = true
    setRefreshing(true)
    try {
      // 用 allSettled：每日推荐那边重试多次后失败是常事，不该把已经拿到的
      // 歌单结果一起丢掉，白白浪费一次成功请求
      const [playlistsResult, recommendResult] = await Promise.allSettled([
        getQQMusicPlaylists(cookie),
        getQQMusicDailyRecommendations(cookie),
      ])
      if (playlistsResult.status == 'fulfilled') {
        setPlaylists(playlistsResult.value)
        await saveQQMusicPlaylistsCache(playlistsResult.value)
      }
      if (recommendResult.status == 'fulfilled') {
        setRecommendations(recommendResult.value)
        await saveQQMusicDailyRecommendCache(recommendResult.value)
      }
      const failure = [playlistsResult, recommendResult].find(result => result.status == 'rejected')
      if (failure?.status == 'rejected') {
        toast(failure.reason instanceof Error ? failure.reason.message : t('qq_load_failed'), 'long')
      }
    } finally {
      refreshingRef.current = false
      setRefreshing(false)
    }
  }, [cookie, ensureLogin, t])

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

  // 点开歌单只查看，不产生副作用；想收进本地仍走右边的导入按钮
  const openPlaylist = (info: LX.QQMusic.PlaylistInfo) => {
    // 「我喜欢」是 dirid=201 的虚拟歌单，没有可用的 disstid。只有走 CgiGetDiss
    // 的取歌路径（即导入按钮）认它，通用歌单详情接口打不开，会连发几次注定失败的请求。
    if (isLikedPlaylist(info)) {
      toast(t('qq_liked_open_unsupported'), 'long')
      return
    }
    navigations.pushSonglistDetailScreen(commonState.componentIds.home!, {
      id: info.id,
      name: info.name,
      author: info.author ?? '',
      img: info.cover,
      desc: info.description,
      source: 'tx',
      total: info.trackCount ? String(info.trackCount) : undefined,
    })
  }

  const importPlaylist = async(info: LX.QQMusic.PlaylistInfo) => {
    if (!ensureLogin()) return
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
      // 界面的清理都交给 qqMusicAccountUpdated 的处理函数，和票据失效时的自动退出走同一条路
      { text: t('confirm'), style: 'destructive', onPress: () => { void clearQQMusicSession().then(() => { global.app_event.qqMusicAccountUpdated(null) }) } },
    ])
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
        <ActionButton icon="available_updates" label={t('qq_refresh')} onPress={() => { void refresh() }} disabled={!loggedIn || refreshing} />
        <ActionButton icon="album" label={t('qq_recommend_playlists')} onPress={() => { navigations.pushQQMusicRecommendScreen(commonState.componentIds.home!) }} />
      </View>
      <FlatList
        data={playlists}
        keyExtractor={item => item.id}
        style={styles.playlist}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void refresh() }} colors={[theme['c-primary']]} />}
        renderItem={({ item }) => <View style={{ ...styles.playlistItem, borderBottomColor: theme['c-border-background'] }}><TouchableOpacity style={styles.playlistInfo} onPress={() => { openPlaylist(item) }}><Text numberOfLines={1}>{item.name}</Text><Text size={12} color={theme['c-font-label']}>{`${t(item.subscribed ? 'qq_playlist_collected' : 'qq_playlist_created')} · ${item.trackCount ? `${item.trackCount} ${t('qq_songs')}` : t('qq_playlist')}`}</Text></TouchableOpacity><TouchableOpacity onPress={() => { void importPlaylist(item) }} style={styles.importButton}><Icon name="add-music" color={theme['c-primary-font']} size={18} /></TouchableOpacity></View>}
        ListEmptyComponent={<Text style={styles.empty} color={theme['c-font-label']}>{user ? t('qq_load_hint') : t('qq_login_hint')}</Text>}
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
  playlist: { flex: 1 },
  playlistItem: { flexDirection: 'row', alignItems: 'center', minHeight: 58, paddingHorizontal: 14, borderBottomWidth: 1 },
  playlistInfo: { flex: 1 },
  importButton: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center' },
  empty: { textAlign: 'center', padding: 28 },
})
