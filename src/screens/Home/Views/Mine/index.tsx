import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import { Alert, RefreshControl, ScrollView, TouchableOpacity, View } from 'react-native'
import Text from '@/components/common/Text'
import { Icon, IconIonicons } from '@/components/common/Icon'
import Image from '@/components/common/Image'
import QQMusicLoginModal, { type QQMusicLoginModalType } from '@/components/QQMusicLoginModal'
import QQMusicPhoneLoginModal, { type QQMusicPhoneLoginModalType } from '@/components/QQMusicPhoneLoginModal'
import QQPlaylistEditModal, { type QQPlaylistEditModalType } from '@/components/QQPlaylistEditModal'
import { useTheme } from '@/store/theme/hook'
import { useDownloadTasks } from '@/store/download/hook'
import { createStyle, toast } from '@/utils/tools'
import { scaleSizeW } from '@/utils/pixelRatio'
import { clearQQMusicSession, filterVisiblePlaylists, getQQMusicPlaylists, getQQMusicSession, getQQMusicUserInfo } from '@/core/qqMusic'
import { deleteQQMusicPlaylist, refreshQQMusicLikedSongs } from '@/core/qqMusicFavorite'
import { isQQMusicFallbackAvatar, isQQMusicFallbackNickname } from '@/core/qqMusicProfile'
import { getLocalMusicCount } from '@/utils/localMatchIndex'
import { navigations } from '@/navigation'
import commonState from '@/store/common/state'
import { getPlayHistory, getQQMusicPlaylistsCache, saveQQMusicPlaylistsCache, saveQQMusicUser } from '@/utils/data'
import { useI18n } from '@/lang'

const AVATAR_SIZE = 56

/**
 * 入口宫格的一格。`ionIcon` 用 Ionicons 的 sharp 版（粗线），
 * `icon` 是 icomoon 的填充字形，二选一。
 * `ionSize` 单独调线条版那一档：线条字形四周留白比填充字形多，同一个名义尺寸看着会偏小。
 */
const Entry = ({ icon, ionIcon, ionSize, label, count, onPress }: {
  icon?: string
  ionIcon?: ComponentProps<typeof IconIonicons>['name']
  ionSize?: number
  label: string
  count?: number
  onPress: () => void
}) => {
  const theme = useTheme()
  return (
    <TouchableOpacity style={styles.entry} activeOpacity={0.7} onPress={onPress}>
      {
        ionIcon
          ? <IconIonicons name={ionIcon} size={scaleSizeW(ionSize ?? 24)} color={theme['c-primary-font']} />
          : icon ? <Icon name={icon} size={24} color={theme['c-primary-font']} /> : null
      }
      <Text style={styles.entryLabel} size={13} numberOfLines={1}>{label}</Text>
      {count == null ? null : <Text size={11} color={theme['c-font-label']}>{count}</Text>}
    </TouchableOpacity>
  )
}

const PlaylistRow = ({ item, onPress, onMore }: {
  item: LX.QQMusic.PlaylistInfo
  onPress: () => void
  onMore?: () => void
}) => {
  const theme = useTheme()
  const t = useI18n()
  return (
    <View style={{ ...styles.row, borderBottomColor: theme['c-border-background'] }}>
      <TouchableOpacity style={styles.rowMain} activeOpacity={0.7} onPress={onPress}>
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
      {onMore
        ? <TouchableOpacity style={styles.rowMore} onPress={onMore}>
            <IconIonicons name="ellipsis-horizontal" size={18} color={theme['c-font-label']} />
          </TouchableOpacity>
        : null}
    </View>
  )
}

// 「我的」页。结构参考 QQ 音乐的版式（账号卡片 / 入口宫格 / 歌单列表），
// 但不做像素级复刻，也没有会员中心。
export default () => {
  const theme = useTheme()
  const t = useI18n()
  const loginRef = useRef<QQMusicLoginModalType>(null)
  const phoneLoginRef = useRef<QQMusicPhoneLoginModalType>(null)
  const playlistEditRef = useRef<QQPlaylistEditModalType>(null)
  const [cookie, setCookie] = useState('')
  const [user, setUser] = useState<LX.QQMusic.UserInfo | null>(null)
  const [playlists, setPlaylists] = useState<LX.QQMusic.PlaylistInfo[]>([])
  const [historyCount, setHistoryCount] = useState(0)
  const [localCount, setLocalCount] = useState(0)
  // 当前试到第几个头像地址。换了账号要从头再试
  const [avatarStage, setAvatarStage] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const refreshingRef = useRef(false)
  const tasks = useDownloadTasks()

  const loggedIn = !!cookie && !!user

  // 歌单：读本地缓存，正常情况下只有「从没拉过」才联网。
  // 例外：旧版手机号登录写入的收藏列表可能没有「我喜欢」项，这种缓存要重拉一次，
  // 否则入口一直点不开（新列表里一定带 liked，见 getQQMusicPlaylists 的兜底）。
  const loadPlaylists = useCallback(async(activeCookie: string) => {
    if (!activeCookie) {
      setPlaylists([])
      return
    }
    const cachedList = filterVisiblePlaylists(await getQQMusicPlaylistsCache())
    if (cachedList.some(item => item.liked)) {
      setPlaylists(cachedList)
      return
    }
    if (cachedList.length) setPlaylists(cachedList)
    try {
      const fresh = await getQQMusicPlaylists(activeCookie, { requireAll: true })
      await saveQQMusicPlaylistsCache(fresh)
      setPlaylists(filterVisiblePlaylists(fresh))
    } catch (error) {
      console.warn('[QQMusic] 拉取歌单失败:', error instanceof Error ? error.message : error)
    }
  }, [])

  useEffect(() => {
    // 读当前会话再决定加载哪个号的歌单。登录/换号、以及别处收藏了歌单时都调它
    const syncFromSession = (nextUser?: LX.QQMusic.UserInfo | null) => {
      if (nextUser !== undefined) setUser(nextUser)
      void getQQMusicSession().then(session => {
        setCookie(session.cookie)
        // 冷启动挂载时没有 nextUser，账号资料只能从会话里拿。
        // 漏了这句就是「cookie 有、user 空」，界面按未登录画。
        // 反过来 cookie 空时不能拿残留的 user 顶上：卡片会显示旧昵称却没登录
        if (nextUser === undefined && session.cookie) setUser(session.user)
        void loadPlaylists(session.cookie)
      })
    }
    syncFromSession()
    const handleAccountUpdate = (nextUser: LX.QQMusic.UserInfo | null) => {
      // 退出登录（含票据失效被自动清理）时把上一个账号的歌单撤掉
      if (!nextUser) setPlaylists([])
      syncFromSession(nextUser)
    }
    // 别处（歌单页头图）收藏/取消收藏了歌单：缓存已就地更新，这里重读一遍就能立刻反映
    const handlePlaylistsUpdate = () => { syncFromSession() }
    global.app_event.on('qqMusicAccountUpdated', handleAccountUpdate)
    global.app_event.on('qqMusicPlaylistsUpdated', handlePlaylistsUpdate)
    return () => {
      global.app_event.off('qqMusicAccountUpdated', handleAccountUpdate)
      global.app_event.off('qqMusicPlaylistsUpdated', handlePlaylistsUpdate)
    }
  }, [loadPlaylists])

  useEffect(() => {
    void getPlayHistory().then(list => { setHistoryCount(list.length) })
    // 事件里已经带着最新的整份历史，别再回头读一次存储
    const handleUpdate = (history: LX.Player.PlayHistoryItem[]) => { setHistoryCount(history.length) }
    global.app_event.on('playHistoryUpdate', handleUpdate)
    return () => { global.app_event.off('playHistoryUpdate', handleUpdate) }
  }, [])

  // 本地歌曲数量直接读匹配索引里的 listCount，避免为了计数加载整份 LOCAL 列表
  useEffect(() => {
    // 用 async 声明：列表事件的监听签名要求返回 Promise<void>
    const load = async() => { setLocalCount(await getLocalMusicCount()) }
    void load()
    global.list_event.on('list_music_add', load)
    global.list_event.on('list_music_remove', load)
    global.list_event.on('list_music_clear', load)
    global.list_event.on('list_music_update', load)
    global.list_event.on('list_music_overwrite', load)
    global.list_event.on('list_data_overwrite', load)
    return () => {
      global.list_event.off('list_music_add', load)
      global.list_event.off('list_music_remove', load)
      global.list_event.off('list_music_clear', load)
      global.list_event.off('list_music_update', load)
      global.list_event.off('list_music_overwrite', load)
      global.list_event.off('list_data_overwrite', load)
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
      const list = await getQQMusicPlaylists(cookie, { requireAll: true })
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
    navigations.pushQQPlaylistScreen(commonState.componentIds.home!, {
      id: info.id,
      name: info.name,
      liked: info.liked,
      // 头图那个收藏角标靠它决定：true 已收藏（能取消）、false 自己建的（不显示）
      subscribed: info.subscribed,
      // 歌单页的头图要用封面和一行副标题，这边手上的就是这一份
      cover: info.cover,
      // 作者缺失（空串也算）时退回曲目数
      subtitle: info.author ? info.author : info.trackCount ? t('mine_song_count', { num: info.trackCount }) : undefined,
    })
  }

  const showPlaylistActions = (playlist: LX.QQMusic.PlaylistInfo) => {
    const confirmDelete = () => {
      Alert.alert(t('qq_playlist_delete_title'), t('qq_playlist_delete_message', { name: playlist.name }), [
        { text: t('cancel'), style: 'cancel' },
        {
          text: t('qq_playlist_delete'),
          style: 'destructive',
          onPress: () => {
            void deleteQQMusicPlaylist(playlist).then(() => {
              toast(t('qq_playlist_delete_success'))
            }).catch((error: unknown) => {
              toast(error instanceof Error ? error.message : t('qq_playlist_edit_failed'), 'long')
            })
          },
        },
      ])
    }
    Alert.alert(playlist.name, undefined, [
      {
        text: t('qq_playlist_rename'),
        onPress: () => playlistEditRef.current?.show({ mode: 'rename', playlist }),
      },
      { text: t('qq_playlist_delete'), style: 'destructive', onPress: confirmDelete },
      { text: t('cancel'), style: 'cancel' },
    ])
  }

  // 头像按顺序试：接口给的地址 → QQ 头像服务。前一个加载失败就换下一个，
  // 全都失败才退回纯色占位（比 LX 占位图好看，也说明确实没辙了）
  const avatarCandidates = useMemo(() => {
    const list: string[] = []
    if (user?.avatar) list.push(user.avatar)
    // 「0」是网页登录的占位 uin，拿去查 qlogo 必然 404，别浪费一次请求
    if (user?.uin && user.uin != '0') list.push(`https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(user.uin)}&s=640`)
    return list
  }, [user?.avatar, user?.uin])
  const avatarUrl = avatarCandidates[avatarStage] ?? ''

  // 换账号后地址全变了，从头再试一遍
  useEffect(() => { setAvatarStage(0) }, [user?.uin])

  // 资料是登录时抓一次就存下来的，换了接口也不会重取。头像缺失、或者退成了兜底地址，
  // 说明当初那次没取到，这里补一次并落盘。只补一次，避免取不到时反复请求。
  const profileRefetchedRef = useRef(false)
  useEffect(() => {
    if (!cookie || !user || profileRefetchedRef.current) return
    if (user.avatar && !user.avatar.includes('qlogo.cn')) return
    profileRefetchedRef.current = true
    void getQQMusicUserInfo(cookie).then(async nextUser => {
      // 资料接口拿不到时会回 QQ <uin> + qlogo；登录回包里的真昵称/头像不能被它覆盖
      const merged = {
        ...nextUser,
        nickname: isQQMusicFallbackNickname(nextUser.uin, nextUser.nickname) && user.nickname ? user.nickname : nextUser.nickname,
        avatar: isQQMusicFallbackAvatar(nextUser.avatar) && user.avatar && !isQQMusicFallbackAvatar(user.avatar)
          ? user.avatar
          : nextUser.avatar,
      }
      setUser(merged)
      await saveQQMusicUser(merged)
    }).catch(() => {})
  }, [cookie, user])

  const liked = playlists.find(item => item.liked)
  const created = playlists.filter(item => !item.liked && !item.subscribed)
  const collected = playlists.filter(item => item.subscribed)

  const renderSection = (title: string, list: LX.QQMusic.PlaylistInfo[], options?: {
    onCreate?: () => void
    onMore?: (item: LX.QQMusic.PlaylistInfo) => void
  }) => (
    <>
      <View style={styles.sectionHeader}>
        <Text size={15}>{`${title} ${list.length}`}</Text>
        {options?.onCreate
          ? <TouchableOpacity style={styles.sectionAction} onPress={options.onCreate}>
              <IconIonicons name="add" size={20} color={theme['c-primary-font']} />
            </TouchableOpacity>
          : null}
      </View>
      {
        list.length
          ? list.map(item => (
              <PlaylistRow
                key={item.id}
                item={item}
                onPress={() => { openPlaylist(item) }}
                onMore={options?.onMore ? () => options.onMore?.(item) : undefined}
              />
          ))
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
                ? <Image url={avatarUrl} style={styles.avatar} onError={() => { setAvatarStage(stage => stage + 1) }} />
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
              : <TouchableOpacity style={styles.userAction} onPress={() => phoneLoginRef.current?.show()}><Text size={13} color={theme['c-primary-font']}>{t('qq_phone_login')}</Text></TouchableOpacity>
          }
        </View>

        <View style={styles.entries}>
          <Entry icon="love" label={t('mine_liked')} count={liked?.trackCount} onPress={() => { if (liked) openPlaylist(liked) }} />
          <Entry ionIcon="time-sharp" ionSize={27} label={t('nav_history')} count={historyCount} onPress={() => { navigations.pushPlayHistoryScreen(commonState.componentIds.home!) }} />
          <Entry icon="download-2" label={t('nav_download')} count={tasks.length} onPress={() => { navigations.pushDownloadScreen(commonState.componentIds.home!) }} />
          <Entry ionIcon="folder-sharp" label={t('mine_local_songs')} count={localCount} onPress={() => { navigations.pushLocalSongsScreen(commonState.componentIds.home!) }} />
        </View>

        {renderSection(t('mine_created_playlists'), created, loggedIn
          ? {
              onCreate: () => playlistEditRef.current?.show({ mode: 'create' }),
              onMore: showPlaylistActions,
            }
          : undefined)}
        {renderSection(t('mine_collected_playlists'), collected)}
      </ScrollView>

      <QQMusicLoginModal ref={loginRef} onLoggedIn={nextUser => { setUser(nextUser); void getQQMusicSession().then(session => { setCookie(session.cookie) }) }} />
      <QQMusicPhoneLoginModal ref={phoneLoginRef} onLoggedIn={nextUser => { setUser(nextUser); void getQQMusicSession().then(session => { setCookie(session.cookie) }) }} />
      <QQPlaylistEditModal ref={playlistEditRef} />
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
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 18, paddingBottom: 8 },
  sectionAction: { padding: 4 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: 1 },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  rowMore: { padding: 8, marginLeft: 4 },
  cover: { width: 48, height: 48, borderRadius: 4 },
  rowInfo: { flex: 1, paddingLeft: 12 },
  empty: { paddingHorizontal: 16, paddingVertical: 14 },
})
