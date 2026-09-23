import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshControl, ScrollView, TouchableOpacity, View } from 'react-native'
import Text from '@/components/common/Text'
import Image from '@/components/common/Image'
import { Icon } from '@/components/common/Icon'
import Loading from '@/components/common/Loading'
import StatusBar from '@/components/common/StatusBar'
import { createStyle } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { useStatusbarHeight } from '@/store/common/hook'
import { getQQMusicPlaylists, getQQMusicSession } from '@/core/qqMusic'
import { markQQMusicViewDataRefreshed, shouldRefreshQQMusicViewData } from '@/core/qqMusicRecommend'
import { getListMusics, setActiveList } from '@/core/list'
import { getQQMusicPlaylistsCache } from '@/utils/data'
import { LIST_IDS } from '@/config/constant'
import { openQQPlaylist } from './openQQPlaylist'
import type { InitState as CommonState } from '@/store/common/state'

interface Props {
  /** 只用来跳转旧功能页；回仪表盘是底部 Tab 的事 */
  onModeChange: (id: CommonState['navActiveId']) => void
  onOpenMenu: () => void
}

// 统计入口前三项是本地列表（数量直接读本地存储），最后一项是下载管理。
// 下载任务数含未完成的，和「已下载多少首」不是一回事，所以这里不给数字。
// 「最近播放」在这个项目里没有对应实现，用实际存在的试听列表替代。
const stats = [
  { icon: 'list-order', label: 'list_name_default', listId: LIST_IDS.DEFAULT, target: 'nav_love' },
  { icon: 'love', label: 'list_name_love', listId: LIST_IDS.LOVE, target: 'nav_love' },
  { icon: 'sd-card', label: 'list_name_local', listId: LIST_IDS.LOCAL, target: 'nav_love' },
  { icon: 'download-2', label: 'nav_download', listId: null, target: 'nav_download' },
] as const

const VIEW_KEY = 'mine'

export default ({ onModeChange, onOpenMenu }: Props) => {
  const theme = useTheme()
  const t = useI18n()
  const statusbarHeight = useStatusbarHeight()
  const [user, setUser] = useState<LX.QQMusic.UserInfo | null>(null)
  const [playlists, setPlaylists] = useState<LX.QQMusic.PlaylistInfo[]>([])
  const [counts, setCounts] = useState<Partial<Record<string, number>>>({})
  // QQ 头像加载失败时退回默认头像，而不是让 Image 兜底成 LX 图标
  const [avatarFailed, setAvatarFailed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async(refresh = false) => {
    if (refresh) setRefreshing(true)
    const needFetch = refresh || shouldRefreshQQMusicViewData(VIEW_KEY)
    try {
      const session = await getQQMusicSession()
      setUser(session.user)
      // 换账号（或退出登录）后要重新给新头像一次机会
      setAvatarFailed(false)
      if (!session.cookie) return
      if (!needFetch) {
        // 闸门内只读缓存，不发请求；缓存里没有的等下拉刷新再取
        setPlaylists(await getQQMusicPlaylistsCache())
        return
      }
      setPlaylists(await getQQMusicPlaylists(session.cookie))
      setFailed(false)
      markQQMusicViewDataRefreshed(VIEW_KEY)
    } catch (error) {
      // 失败不记时间，下次进页面还能重试
      setFailed(true)
      console.warn('[QQMusic] load my playlists failed:', error instanceof Error ? error.message : error)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load() }, [])

  // 本地列表数量直接读本地存储，不进网络
  useEffect(() => {
    void Promise.all(stats.map(async({ listId }) => listId ? getListMusics(listId) : []))
      .then(lists => {
        const next: Partial<Record<string, number>> = {}
        // 没有 listId 的入口（下载管理）不写数量，免得显示一个凭空的 0
        stats.forEach((item, index) => { if (item.listId) next[item.label] = lists[index].length })
        setCounts(next)
      })
      .catch(() => {})
  }, [])

  // 用不上账号头像就不画头像：Image 拿不到 url 时会兜底成 LX 图标，那个当头像很难看
  const avatarUrl = avatarFailed ? '' : user?.avatar ?? ''

  const created = useMemo(() => playlists.filter(item => !item.subscribed), [playlists])
  const collected = useMemo(() => playlists.filter(item => item.subscribed), [playlists])

  // 进「我的列表」之前先把它切到对应列表：不切的话三个入口点下去都落在
  // 上次停留的那个列表上，入口就只是摆设。
  const openStat = (listId: string | null, target: CommonState['navActiveId']) => {
    if (listId) setActiveList(listId)
    onModeChange(target)
  }

  const emptyText = failed
    ? t('qq_load_failed')
    : user ? t('home_empty_playlists') : t('qq_login_hint')

  const renderPlaylists = (list: LX.QQMusic.PlaylistInfo[], showLoading: boolean) => {
    if (list.length) {
      return list.slice(0, 5).map(item => (
        <TouchableOpacity key={item.id} style={styles.playlist} onPress={() => { openQQPlaylist(item) }}>
          <Image url={item.cover} style={styles.playlistImage} />
          <View style={styles.playlistInfo}>
            <Text numberOfLines={1} size={15}>{item.name}</Text>
            <Text size={12} color={theme['c-font-label']}>{item.trackCount ? `${item.trackCount} ${t('qq_songs')}` : t('qq_playlist')}</Text>
          </View>
        </TouchableOpacity>
      ))
    }
    return (
      <View style={styles.statusLine}>
        {showLoading && loading ? <Loading size={16} label={t('qq_loading')} /> : <Text size={13} color={theme['c-font-label']}>{emptyText}</Text>}
      </View>
    )
  }

  return <View style={{ flex: 1, backgroundColor: theme['c-content-background'] }}>
    <StatusBar />
    <ScrollView
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void load(true) }} colors={[theme['c-primary']]} />}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      <View style={{ ...styles.header, paddingTop: statusbarHeight + 12 }}>
        <Text size={28} style={styles.title}>{t('home_title_mine')}</Text>
        <TouchableOpacity style={styles.menuButton} onPress={onOpenMenu}><Icon name="menu" size={24} /></TouchableOpacity>
      </View>
      {/* 这里原本还有一个搜索框，和首页那个完全一样，全 App 的第三个搜索入口，去掉了 */}
      <View style={{ ...styles.profile, backgroundColor: theme['c-primary-light-900-alpha-500'] }}>
        {avatarUrl ? <Image url={avatarUrl} style={styles.avatar} onError={() => { setAvatarFailed(true) }} /> : null}
        <View style={styles.profileInfo}>
          <Text size={19} style={styles.profileName}>{user?.nickname ?? t('qq_not_logged_in')}</Text>
          <Text size={13} color={theme['c-font-label']}>{user ? t('qq_logged_in') : t('qq_login_hint')}</Text>
        </View>
        <TouchableOpacity style={{ ...styles.loginButton, backgroundColor: theme['c-primary'] }} onPress={() => { onModeChange('nav_qq') }}>
          <Text color="#fff" size={12}>{user ? t('home_account') : t('qq_login')}</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.stats}>
        {stats.map(({ icon, label, listId, target }) => (
          <TouchableOpacity key={label} style={styles.stat} onPress={() => { openStat(listId, target) }}>
            <Icon name={icon} size={26} color={theme['c-primary']} />
            <Text size={14} style={styles.statLabel}>{t(label)}</Text>
            {counts[label] == null ? null : <Text size={12} color={theme['c-font-label']}>{counts[label]}</Text>}
          </TouchableOpacity>
        ))}
      </View>
      <Text size={20} style={styles.sectionTitle}>{t('home_section_created')}</Text>
      {renderPlaylists(created, true)}
      <Text size={20} style={styles.sectionTitle}>{t('collect_songlist')}</Text>
      {renderPlaylists(collected, false)}
      {/* 歌单的增删改和导入都在 QQ 音乐页，那里每行右边就是导入按钮，
          所以这里只留一个入口，不再重复“管理×2 + 导入”三条通往同一页的路径 */}
      <TouchableOpacity style={styles.import} onPress={() => { onModeChange('nav_qq') }}>
        <Icon name="album" size={26} color={theme['c-primary']} />
        <Text size={16} style={styles.importText}>{t('home_manage_playlists')}</Text>
      </TouchableOpacity>
    </ScrollView>
  </View>
}

const styles = createStyle({
  content: { paddingHorizontal: 16, paddingBottom: 24 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 14 },
  title: { fontWeight: '700' },
  menuButton: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center' },
  // 高度交给内容决定：没头像时（未登录、或头像加载失败）卡片自然收窄，
  // 不留一个空着 112 高度的框
  profile: { borderRadius: 16, paddingVertical: 18, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center' },
  avatar: { width: 62, height: 62, borderRadius: 31, marginRight: 14 },
  profileInfo: { flex: 1 },
  profileName: { fontWeight: '700', marginBottom: 6 },
  loginButton: { borderRadius: 16, paddingHorizontal: 13, paddingVertical: 7 },
  stats: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 24 },
  stat: { flex: 1, alignItems: 'center' },
  statLabel: { marginTop: 7, marginBottom: 3 },
  sectionTitle: { fontWeight: '700', marginBottom: 10 },
  playlist: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  playlistImage: { width: 58, height: 58, borderRadius: 8, marginRight: 12 },
  playlistInfo: { flex: 1 },
  statusLine: { paddingVertical: 18, alignItems: 'center', justifyContent: 'center' },
  import: { height: 72, borderRadius: 12, backgroundColor: 'rgba(128,128,128,.08)', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, marginTop: 6 },
  importText: { marginLeft: 14 },
})
