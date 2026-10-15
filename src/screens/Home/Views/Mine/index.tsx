import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, RefreshControl, ScrollView, TouchableOpacity, View } from 'react-native'
import Text from '@/components/common/Text'
import { Icon } from '@/components/common/Icon'
import Image from '@/components/common/Image'
import QQMusicLoginModal, { type QQMusicLoginModalType } from '@/components/QQMusicLoginModal'
import QQMusicCookieModal, { type QQMusicCookieModalType } from '@/components/QQMusicCookieModal'
import { useTheme } from '@/store/theme/hook'
import { useDownloadTasks } from '@/store/download/hook'
import { createStyle, toast } from '@/utils/tools'
import { clearQQMusicSession, filterVisiblePlaylists, getQQMusicPlaylists, getQQMusicSession } from '@/core/qqMusic'
import { refreshQQMusicLikedSongs } from '@/core/qqMusicFavorite'
import { getListMusics } from '@/core/list'
import { LIST_IDS } from '@/config/constant'
import { navigations } from '@/navigation'
import commonState from '@/store/common/state'
import { getPlayHistory, getQQMusicPlaylistsCache, saveQQMusicPlaylistsCache } from '@/utils/data'
import { useI18n } from '@/lang'

const AVATAR_SIZE = 56

const Entry = ({ icon, label, count, onPress }: {
  icon: string
  label: string
  count?: number
  onPress: () => void
}) => {
  const theme = useTheme()
  return (
    <TouchableOpacity style={styles.entry} activeOpacity={0.7} onPress={onPress}>
      <Icon name={icon} size={24} color={theme['c-primary-font']} />
      <Text style={styles.entryLabel} size={13} numberOfLines={1}>{label}</Text>
      {count == null ? null : <Text size={11} color={theme['c-font-label']}>{count}</Text>}
    </TouchableOpacity>
  )
}

const PlaylistRow = ({ item, onPress }: {
  item: LX.QQMusic.PlaylistInfo
  onPress: () => void
}) => {
  const theme = useTheme()
  const t = useI18n()
  return (
    <TouchableOpacity style={{ ...styles.row, borderBottomColor: theme['c-border-background'] }} activeOpacity={0.7} onPress={onPress}>
      {item.cover
        ? <Image url={item.cover} style={styles.cover} />
        : <View style={{ ...styles.cover, backgroundColor: theme['c-primary-background'] }} />}
      <View style={styles.rowInfo}>
        <Text numberOfLines={1}>{item.name}</Text>
        <Text size={12} color={theme['c-font-label']} numberOfLines={1}>
          {t('mine_song_count', { num: item.trackCount ?? 0 })}
        </Text>
      </View>
    </TouchableOpacity>
  )
}

// 「我的」页。结构参考 QQ 音乐的版式（账号卡片 / 入口宫格 / 歌单列表），
// 但不做像素级复刻，也没有会员中心。
export default () => {
  const theme = useTheme()
  const t = useI18n()
  const loginRef = useRef<QQMusicLoginModalType>(null)
  const cookieLoginRef = useRef<QQMusicCookieModalType>(null)
  const [cookie, setCookie] = useState('')
  const [user, setUser] = useState<LX.QQMusic.UserInfo | null>(null)
  const [playlists, setPlaylists] = useState<LX.QQMusic.PlaylistInfo[]>([])
  const [historyCount, setHistoryCount] = useState(0)
  const [localCount, setLocalCount] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const refreshingRef = useRef(false)
  const tasks = useDownloadTasks()

  const loggedIn = !!cookie && !!user

  useEffect(() => {
    void getQQMusicSession().then(session => {
      setCookie(session.cookie)
      setUser(session.user)
      // 歌单直接读本地缓存，进页面不发网络请求
      if (!session.cookie) return
      void getQQMusicPlaylistsCache().then(cached => {
        setPlaylists(filterVisiblePlaylists(cached))
      })
    })
    const handleAccountUpdate = (nextUser: LX.QQMusic.UserInfo | null) => {
      setUser(nextUser)
      // 退出登录（含票据失效被自动清理）时把上一个账号的歌单撤掉
      if (!nextUser) setPlaylists([])
      void getQQMusicSession().then(session => { setCookie(session.cookie) })
    }
    global.app_event.on('qqMusicAccountUpdated', handleAccountUpdate)
    return () => { global.app_event.off('qqMusicAccountUpdated', handleAccountUpdate) }
  }, [])

  useEffect(() => {
    const load = () => { void getPlayHistory().then(list => { setHistoryCount(list.length) }) }
    load()
    global.app_event.on('playHistoryUpdate', load)
    return () => { global.app_event.off('playHistoryUpdate', load) }
  }, [])

  // 本地歌曲就是 LIST_IDS.LOCAL 那个列表（下载完成的歌也写在这里）。
  // 导入/删除会走列表事件，跟着更新一下数量
  useEffect(() => {
    // 用 async 声明：列表事件的监听签名要求返回 Promise<void>
    const load = async() => { setLocalCount((await getListMusics(LIST_IDS.LOCAL)).length) }
    void load()
    global.list_event.on('list_music_add', load)
    global.list_event.on('list_music_remove', load)
    return () => {
      global.list_event.off('list_music_add', load)
      global.list_event.off('list_music_remove', load)
    }
  }, [])

  const refresh = useCallback(async() => {
    // setRefreshing 要到下次渲染才生效，光靠 disabled 挡不住这个窗口内的第二次触发
    if (refreshingRef.current) return
    if (!loggedIn) {
      loginRef.current?.show()
      return
    }
    refreshingRef.current = true
    setRefreshing(true)
    try {
      const list = await getQQMusicPlaylists(cookie)
      setPlaylists(list)
      await saveQQMusicPlaylistsCache(list)
      // 顺手把「我喜欢」也刷一遍：它平时只读本地缓存（拉全量要翻好几页），
      // 下拉刷新是唯一的重拉时机
      void refreshQQMusicLikedSongs()
    } catch (error: unknown) {
      toast(error instanceof Error ? error.message : t('qq_load_failed'), 'long')
    } finally {
      refreshingRef.current = false
      setRefreshing(false)
    }
  }, [cookie, loggedIn, t])

  const logout = () => {
    Alert.alert(t('qq_logout_title'), t('qq_logout_message'), [
      { text: t('cancel'), style: 'cancel' },
      // 界面清理都交给 qqMusicAccountUpdated 的处理函数，和票据失效时的自动退出走同一条路
      { text: t('confirm'), style: 'destructive', onPress: () => { void clearQQMusicSession().then(() => { global.app_event.qqMusicAccountUpdated(null) }) } },
    ])
  }

  const openPlaylist = (info: LX.QQMusic.PlaylistInfo) => {
    navigations.pushQQPlaylistScreen(commonState.componentIds.home!, { id: info.id, name: info.name, liked: info.liked })
  }

  // 头像兜底：存下来的 user 可能是更早的版本写进去的（那时还没有地址归一化），
  // 拿到空值就退回 QQ 头像服务，别让头像位开天窗
  const avatarUrl = user?.avatar
    ? user.avatar
    : (user?.uin ? `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(user.uin)}&s=100` : '')

  const liked = playlists.find(item => item.liked)
  const created = playlists.filter(item => !item.liked && !item.subscribed)
  const collected = playlists.filter(item => item.subscribed)

  const renderSection = (title: string, list: LX.QQMusic.PlaylistInfo[]) => (
    <>
      <Text style={styles.sectionTitle} size={15}>{`${title} ${list.length}`}</Text>
      {
        list.length
          ? list.map(item => <PlaylistRow key={item.id} item={item} onPress={() => { openPlaylist(item) }} />)
          : <Text style={styles.empty} size={13} color={theme['c-font-label']}>{loggedIn ? t('qq_load_hint') : t('qq_login_hint')}</Text>
      }
    </>
  )

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void refresh() }} colors={[theme['c-primary']]} />}
      >
        <View style={styles.userCard}>
          <TouchableOpacity style={styles.userMain} activeOpacity={0.7} onPress={() => { if (!loggedIn) loginRef.current?.show() }}>
            {
              avatarUrl
                ? <Image url={avatarUrl} style={styles.avatar} />
                : <View style={{ ...styles.avatar, backgroundColor: theme['c-primary-background'] }} />
            }
            <View style={styles.userInfo}>
              <Text size={18} numberOfLines={1}>{user ? user.nickname : t('qq_not_logged_in')}</Text>
              <Text size={12} color={theme['c-font-label']} numberOfLines={1}>
                {loggedIn ? (user.uin ? `QQ ${user.uin}` : t('qq_logged_in')) : t('qq_login_hint')}
              </Text>
            </View>
          </TouchableOpacity>
          {
            loggedIn
              ? <TouchableOpacity style={styles.userAction} onPress={logout}><Icon name="exit" size={20} color={theme['c-font-label']} /></TouchableOpacity>
              : <TouchableOpacity style={styles.userAction} onPress={() => cookieLoginRef.current?.show()}><Text size={13} color={theme['c-primary-font']}>{t('qq_cookie_login')}</Text></TouchableOpacity>
          }
        </View>

        <View style={styles.entries}>
          <Entry icon="love" label={t('mine_liked')} count={liked?.trackCount} onPress={() => { if (liked) openPlaylist(liked) }} />
          <Entry icon="music_time" label={t('nav_history')} count={historyCount} onPress={() => { navigations.pushPlayHistoryScreen(commonState.componentIds.home!) }} />
          <Entry icon="download-2" label={t('nav_download')} count={tasks.length} onPress={() => { navigations.pushDownloadScreen(commonState.componentIds.home!) }} />
          <Entry icon="sd-card" label={t('mine_local_songs')} count={localCount} onPress={() => { navigations.pushLocalSongsScreen(commonState.componentIds.home!) }} />
        </View>

        {renderSection(t('mine_created_playlists'), created)}
        {renderSection(t('mine_collected_playlists'), collected)}
      </ScrollView>

      <QQMusicLoginModal ref={loginRef} onLoggedIn={nextUser => { setUser(nextUser); void getQQMusicSession().then(session => { setCookie(session.cookie) }) }} />
      <QQMusicCookieModal ref={cookieLoginRef} onLoggedIn={nextUser => { setUser(nextUser); void getQQMusicSession().then(session => { setCookie(session.cookie) }) }} />
    </View>
  )
}

const styles = createStyle({
  container: { flex: 1 },
  scroll: { flex: 1 },
  userCard: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 16 },
  userMain: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  avatar: { width: AVATAR_SIZE, height: AVATAR_SIZE, borderRadius: AVATAR_SIZE / 2 },
  userInfo: { flex: 1, paddingLeft: 12 },
  userAction: { paddingHorizontal: 8, paddingVertical: 8 },
  entries: { flexDirection: 'row', paddingVertical: 8 },
  entry: { flex: 1, alignItems: 'center', paddingVertical: 8 },
  entryLabel: { marginTop: 6 },
  sectionTitle: { paddingHorizontal: 16, paddingTop: 18, paddingBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: 1 },
  cover: { width: 48, height: 48, borderRadius: 4 },
  rowInfo: { flex: 1, paddingLeft: 12 },
  empty: { paddingHorizontal: 16, paddingVertical: 14 },
})
