import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { RefreshControl, ScrollView, TouchableOpacity, View } from 'react-native'
import Text from '@/components/common/Text'
import Image from '@/components/common/Image'
import ImageBackground from '@/components/common/ImageBackground'
import IconAction from '@/components/common/IconAction'
import QQMusicLoginModal, { type QQMusicLoginModalType } from '@/components/QQMusicLoginModal'
import { useTheme } from '@/store/theme/hook'
import { useWindowSize } from '@/utils/hooks'
import { createStyle, toast } from '@/utils/tools'
import { scaleSizeW } from '@/utils/pixelRatio'
import { LIST_IDS, QQ_DAILY_RECOMMEND_ID } from '@/config/constant'
import { setTempList } from '@/core/list'
import { playList } from '@/core/player/player'
import {
  getQQMusicDailyPlaylist,
  getQQMusicDailyRecommendations,
  getQQMusicRecommendedPlaylists,
  getQQMusicSession,
  getQQMusicSimilarSongs,
} from '@/core/qqMusic'
import { continueRecommendQueue, initQQMusicRecommendAutoRefresh, startRecommendQueue } from '@/core/qqMusicRecommend'
import { dropRecommendSession } from '@/core/qqMusicRecommendSession'
import { QQ_DAILY_PLAYLIST_ID, playQQMusicDailyPlaylist } from '@/core/qqMusicDailyPosition'
import { navigations } from '@/navigation'
import commonState from '@/store/common/state'
import {
  getPlayHistory,
  getQQMusicDailyPlaylistCache,
  getQQMusicDailyRecommendCache,
  getQQMusicRecommendPlaylistsCache,
  getQQMusicRefreshDay,
  saveQQMusicDailyPlaylistCache,
  saveQQMusicDailyRecommendCache,
  saveQQMusicRecommendPlaylistsCache,
  saveQQMusicRefreshDay,
} from '@/utils/data'
import { useI18n } from '@/lang'

type Songs = LX.Music.MusicInfoOnline[]
type Playlist = LX.QQMusic.PlaylistInfo

// 每日推荐的临时列表 id。位置记忆和历史标记都按它认队列，所以放在 core 里统一导出
const DAILY_LIST_ID = QQ_DAILY_PLAYLIST_ID
const H_PADDING = 14
const CARD_GAP = 10

/**
 * 方形推荐卡。封面铺满，底部压一层暗色保证文字可读（没有渐变库，用纯色代替）。
 *
 * `action` 挂在卡片这个 TouchableOpacity 里面：点它只走它自己的 onPress（内层先拿到
 * 手势响应），不会连带触发卡片的 onPress —— 所以每日推荐能「按钮播放、卡片展开列表」。
 * 不传 subtitle 就只显示标题（猜你喜欢的小字去掉了）。
 */
const SquareCard = ({ title, subtitle, cover, onPress, disabled, action }: {
  title: string
  subtitle?: string
  cover?: string | null
  onPress: () => void
  disabled?: boolean
  action?: ReactNode
}) => {
  const windowSize = useWindowSize()
  const side = (windowSize.width - H_PADDING * 2 - CARD_GAP) / 2

  return (
    <TouchableOpacity style={{ ...styles.card, width: side, height: side, opacity: disabled ? 0.6 : 1 }} activeOpacity={0.85} disabled={disabled} onPress={onPress}>
      {
        cover
          ? <ImageBackground style={styles.cardBg} source={{ uri: cover }} resizeMode="cover" />
          : <View style={{ ...styles.cardBg, backgroundColor: '#4daf7c' }} />
      }
      <View style={styles.cardOverlay} />
      <View style={styles.cardFooter}>
        <View style={styles.cardText}>
          <Text size={17} color="#fff" numberOfLines={1}>{title}</Text>
          {subtitle ? <Text size={11} color="rgba(255,255,255,0.85)" numberOfLines={1}>{subtitle}</Text> : null}
        </View>
        {action}
      </View>
    </TouchableOpacity>
  )
}

// 首页：个性化推荐。上排两张方形卡（每日推荐 / 猜你喜欢），
// 下面是推荐歌单横向滚动和基于最近播放的相似推荐。
// 进页面只读本地缓存、不发请求；下拉刷新才联网，而且只管「每日推荐」这一块 ——
// 猜你喜欢和推荐歌单各自带刷新钮（卡片右下角 / 板块标题右侧），下拉不碰它们，
// 免得把用户正在听、正在看的那一批顺手换掉。
// 两张卡的点击分别是「进每日推荐歌单页（头图 + 那 30 首）」和「播放」，
// 卡上的圆钮才是播放 / 刷新。
export default () => {
  const t = useI18n()
  const theme = useTheme()
  const loginRef = useRef<QQMusicLoginModalType>(null)
  const [cookie, setCookie] = useState('')
  const [daily, setDaily] = useState<Songs>([])
  const [guess, setGuess] = useState<Songs>([])
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [similar, setSimilar] = useState<{ title: string, seedName: string, songs: Songs }>({ title: '', seedName: '', songs: [] })
  const [refreshing, setRefreshing] = useState(false)
  const refreshingRef = useRef(false)
  const nextFromRef = useRef(0)
  const [playing, setPlaying] = useState(false)
  const [refreshingGuess, setRefreshingGuess] = useState(false)
  const refreshingGuessRef = useRef(false)
  const [refreshingPlaylists, setRefreshingPlaylists] = useState(false)
  const refreshingPlaylistsRef = useRef(false)

  const loggedIn = !!cookie

  useEffect(() => {
    void getQQMusicSession().then(session => { setCookie(session.cookie) })
    const handleAccountUpdate = () => {
      void getQQMusicSession().then(session => { setCookie(session.cookie) })
    }
    global.app_event.on('qqMusicAccountUpdated', handleAccountUpdate)
    return () => { global.app_event.off('qqMusicAccountUpdated', handleAccountUpdate) }
  }, [])

  useEffect(() => {
    // 先铺缓存
    void getQQMusicDailyPlaylistCache().then(setDaily)
    void getQQMusicDailyRecommendCache().then(setGuess)
    void getQQMusicRecommendPlaylistsCache().catch(() => null).then(cache => {
      if (!cache?.list.length) return
      setPlaylists(cache.list)
      nextFromRef.current = cache.nextFrom
    })
  }, [])

  // 相似推荐的种子取最近播放的第一首 QQ 歌曲
  const loadSimilar = useCallback(async(activeCookie: string) => {
    if (!activeCookie) return
    const history = await getPlayHistory()
    const seed = history.find(item => {
      const info = 'metadata' in item.musicInfo ? item.musicInfo.metadata.musicInfo : item.musicInfo
      return info.source == 'tx' && !!info.meta.id
    })
    if (!seed) return
    const info = 'metadata' in seed.musicInfo ? seed.musicInfo.metadata.musicInfo : seed.musicInfo
    const seedId = (info.meta as LX.Music.MusicInfoOnline['meta'] & { id?: string }).id
    try {
      const result = await getQQMusicSimilarSongs(activeCookie, seedId!)
      if (!result.songs.length) return
      setSimilar({ title: result.title, seedName: info.name, songs: result.songs })
    } catch {
      // 相似推荐失败不影响首页其它板块，静默跳过
    }
  }, [])

  useEffect(() => { void loadSimilar(cookie) }, [cookie, loadSimilar])

  /** 拉一份新的每日推荐：铺上、落盘、记下「今天刷过了」 */
  const fetchDaily = useCallback(async() => {
    const songs = await getQQMusicDailyPlaylist(cookie)
    setDaily(songs)
    await saveQQMusicDailyPlaylistCache(songs)
    await saveQQMusicRefreshDay('playlist')
    return songs
  }, [cookie])

  /** 拉一份新的猜你喜欢：铺上、落盘、作废上次那批的续播存档、记下「今天刷过了」 */
  const fetchGuess = useCallback(async() => {
    const songs = await getQQMusicDailyRecommendations(cookie)
    if (!songs.length) throw new Error(t('qq_load_failed'))
    setGuess(songs)
    await saveQQMusicDailyRecommendCache(songs)
    await saveQQMusicRefreshDay('recommend')
    // 刷新就是要换一批：上次那批的续播存档作废，下次点「猜你喜欢」从新的这批开头放。
    // 失败时不能丢——用户没拿到新列表，不该连续播也一起没了。
    await dropRecommendSession()
    return songs
  }, [cookie, t])

  // 跨天自动刷新：首页铺完缓存后看一眼这份缓存是不是「今天刷的」，不是就自己去拉一次
  // （缓存空的时候记账也没有，同样落到这里）。每天首次进首页各一次请求，
  // 之后就不管了 —— 中途要看新的一批还是下拉/点刷新钮。失败保持旧内容，不打扰用户
  useEffect(() => {
    if (!cookie) return
    const check = async() => {
      const [dailyDay, guessDay] = await Promise.all([
        getQQMusicRefreshDay('playlist'),
        getQQMusicRefreshDay('recommend'),
      ])
      const today = new Date().toDateString()
      // 用户刚好在下拉刷新时别凑热闹
      if (refreshingRef.current || refreshingGuessRef.current) return
      const failures: string[] = []
      // 占住手动刷新那两道闸：自动刷新自己在发请求的这段时间里，
      // 用户再下拉/点刷新钮也应该被挡住，否则同一批会请求两遍
      if (dailyDay != today) {
        refreshingRef.current = true
        try {
          await fetchDaily()
        } catch (error) {
          failures.push(`每日推荐: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          refreshingRef.current = false
        }
      }
      if (guessDay != today) {
        refreshingGuessRef.current = true
        try {
          await fetchGuess()
        } catch (error) {
          failures.push(`猜你喜欢: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          refreshingGuessRef.current = false
        }
      }
      if (failures.length) console.warn('[QQMusic] 跨天自动刷新失败，先用旧内容:', failures.join('; '))
    }
    void check()
  }, [cookie, fetchDaily, fetchGuess])

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
      // 下拉刷新只管「每日推荐」这一块：猜你喜欢和推荐歌单都各自带了刷新钮，
      // 下拉不该顺手换掉用户正在看/正在听的那一批。
      await fetchDaily()
    } catch (error: unknown) {
      toast(error instanceof Error ? error.message : t('qq_load_failed'), 'long')
    } finally {
      refreshingRef.current = false
      setRefreshing(false)
    }
    // 相似推荐是顺带算的，跟着下拉一起更新；它自己失败是静默的
    void loadSimilar(cookie)
  }, [cookie, fetchDaily, loadSimilar, loggedIn, t])

  // 推荐歌单标题右侧那个刷新钮。每点一次换一批：游标往下走，取尽后回到开头
  const refreshPlaylists = useCallback(async() => {
    if (!loggedIn) {
      loginRef.current?.show()
      return
    }
    // 同 refresh：setRefreshingPlaylists 要到下次渲染才生效，光靠 disabled 挡不住这个窗口内的第二次触发
    if (refreshingPlaylistsRef.current) return
    refreshingPlaylistsRef.current = true
    setRefreshingPlaylists(true)
    try {
      const result = await getQQMusicRecommendedPlaylists(cookie, nextFromRef.current)
      setPlaylists(result.list)
      // 取尽后回到开头，这样能一直「一批批」换下去而不是停在最后一批
      nextFromRef.current = result.hasMore ? result.nextFrom : 0
      await saveQQMusicRecommendPlaylistsCache({ list: result.list, nextFrom: nextFromRef.current })
    } catch (error: unknown) {
      toast(error instanceof Error ? error.message : t('qq_load_failed'), 'long')
    } finally {
      refreshingPlaylistsRef.current = false
      setRefreshingPlaylists(false)
    }
  }, [cookie, loggedIn, t])

  // 猜你喜欢右下角那个刷新按钮。要换的一批就是重新拉一次推荐，并把上次那批的续播存档作废
  const refreshGuess = useCallback(async() => {
    if (!loggedIn) {
      loginRef.current?.show()
      return
    }
    // 同 refresh：setRefreshingGuess 要到下次渲染才生效，光靠 disabled 挡不住这个窗口内的第二次触发
    if (refreshingGuessRef.current) return
    refreshingGuessRef.current = true
    setRefreshingGuess(true)
    try {
      await fetchGuess()
    } catch (error: unknown) {
      toast(error instanceof Error ? error.message : t('qq_load_failed'), 'long')
    } finally {
      refreshingGuessRef.current = false
      setRefreshingGuess(false)
    }
  }, [fetchGuess, loggedIn, t])

  /**
   * 要用的那批每日推荐。缓存还没铺（新装、刚登录、上次拉取失败）时先联网拉一次 ——
   * 「进页面只读缓存」是说进页面，用户点了卡片却弹登录是说不通的。
   * 没登录才弹登录框；拉取失败提示一下就收工。
   */
  const ensureDailySongs = useCallback(async(): Promise<Songs | null> => {
    if (daily.length) return daily
    if (!loggedIn) {
      loginRef.current?.show()
      return null
    }
    try {
      return await fetchDaily()
    } catch (error: unknown) {
      toast(error instanceof Error ? error.message : t('qq_load_failed'), 'long')
      return null
    }
  }, [daily, fetchDaily, loggedIn, t])

  // 每日推荐整表播放。用 30 首的独立列表，不挂电台续播那套
  const playDaily = useCallback(async() => {
    const songs = await ensureDailySongs()
    if (!songs) return
    // 接着上次那首放（见 core/qqMusicDailyPosition）。列表换了/歌没了会自动回到开头
    await playQQMusicDailyPlaylist(songs)
  }, [ensureDailySongs])

  // 卡片本身进歌单页（头图 + 那 30 首），播放交给右下角的按钮
  const openDaily = useCallback(async() => {
    const songs = await ensureDailySongs()
    if (!songs) return
    navigations.pushQQPlaylistScreen(commonState.componentIds.home!, {
      id: DAILY_LIST_ID,
      name: t('qq_daily_recommend'),
      daily: true,
      cover: songs[0]?.meta.picUrl,
      subtitle: t('mine_song_count', { num: songs.length }),
    })
  }, [ensureDailySongs, t])

  // 猜你喜欢走电台续播：播到快结束自动续下一批
  const playGuess = useCallback(async() => {
    if (!loggedIn) {
      loginRef.current?.show()
      return
    }
    setPlaying(true)
    try {
      if (await continueRecommendQueue(guess)) return
      // 抓不到一批（比如启动时的自动刷新失败了）：走同一条拉取路径，
      // 这样「今天刷过了」也会记上，下次冷启动不会再为同一批多请求一次
      const songs = guess.length ? guess : await fetchGuess()
      await setTempList(QQ_DAILY_RECOMMEND_ID, songs)
      initQQMusicRecommendAutoRefresh()
      await startRecommendQueue(songs, 0)
    } catch (error: unknown) {
      toast(error instanceof Error ? error.message : t('qq_load_failed'), 'long')
    } finally {
      setPlaying(false)
    }
  }, [fetchGuess, guess, loggedIn, t])

  const playSongs = useCallback(async(listId: string, songs: Songs, index: number) => {
    await setTempList(listId, [...songs])
    void playList(LIST_IDS.TEMP, index)
  }, [])

  const openPlaylist = (info: Playlist) => {
    navigations.pushQQPlaylistScreen(commonState.componentIds.home!, {
      id: info.id,
      name: info.name,
      liked: info.liked,
      // 头图的封面和副标题这边手上就有，顺手带过去，省得歌单页再去猜
      cover: info.cover,
      // 作者缺失（空串也算）时退回曲目数
      subtitle: info.author ? info.author : info.trackCount ? t('mine_song_count', { num: info.trackCount }) : undefined,
    })
  }

  const similarTitle = similar.title || t('home_similar_title', { name: similar.seedName })

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void refresh() }} colors={[theme['c-primary']]} />}
      >
        {
          loggedIn
            ? null
            : <TouchableOpacity style={{ ...styles.loginCard, backgroundColor: theme['c-button-background'] }} onPress={() => loginRef.current?.show()}>
                <Text color={theme['c-button-font']}>{t('qq_login')}</Text>
                <Text size={12} color={theme['c-button-font']} style={styles.loginHint}>{t('qq_login_hint')}</Text>
              </TouchableOpacity>
        }

        <View style={styles.cardRow}>
          <SquareCard
            title={t('qq_daily_recommend')}
            subtitle={t('mine_song_count', { num: daily.length })}
            cover={daily[0]?.meta.picUrl}
            onPress={() => { void openDaily() }}
            action={<IconAction overlay icon="play" onPress={() => { void playDaily() }} />}
          />
          <SquareCard
            title={t('qq_guess_you_like')}
            cover={guess[0]?.meta.picUrl}
            onPress={() => { void playGuess() }}
            disabled={playing}
            action={<IconAction overlay icon="refresh" onPress={() => { void refreshGuess() }} disabled={refreshingGuess} />}
          />
        </View>

        {
          // 标题和刷新钮登录后一直在：列表空的时候也得留着入口，否则没法手动重拉
          loggedIn
            ? <>
                <View style={styles.sectionHeader}>
                  <Text size={15}>{t('qq_recommend_playlists')}</Text>
                  <IconAction icon="refresh" onPress={() => { void refreshPlaylists() }} disabled={refreshingPlaylists} />
                </View>
                {
                  playlists.length
                    ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hList}>
                        {
                          playlists.map(item => (
                            <TouchableOpacity key={item.id} style={styles.playlistCard} activeOpacity={0.8} onPress={() => { openPlaylist(item) }}>
                              {item.cover
                                ? <Image url={item.cover} style={styles.playlistCover} />
                                : <View style={{ ...styles.playlistCover, backgroundColor: theme['c-primary-background'] }} />}
                              <Text style={styles.playlistName} size={12} numberOfLines={2}>{item.name}</Text>
                            </TouchableOpacity>
                          ))
                        }
                      </ScrollView>
                    : null
                }
              </>
            : null
        }

        {
          similar.songs.length
            ? <>
                <Text style={styles.sectionTitle} size={15} numberOfLines={1}>{similarTitle}</Text>
                {
                  similar.songs.map((song, index) => (
                    <TouchableOpacity
                      key={`${song.id}-${index}`}
                      style={{ ...styles.songRow, borderBottomColor: theme['c-border-background'] }}
                      activeOpacity={0.7}
                      onPress={() => { void playSongs('qq_similar', similar.songs, index) }}
                    >
                      {song.meta.picUrl
                        ? <Image url={song.meta.picUrl} style={styles.songPic} />
                        : <View style={{ ...styles.songPic, backgroundColor: theme['c-primary-background'] }} />}
                      <View style={styles.songInfo}>
                        <Text numberOfLines={1}>{song.name}</Text>
                        <Text size={12} color={theme['c-font-label']} numberOfLines={1}>{song.singer}</Text>
                      </View>
                    </TouchableOpacity>
                  ))
                }
              </>
            : null
        }
      </ScrollView>

      <QQMusicLoginModal ref={loginRef} onLoggedIn={() => { void getQQMusicSession().then(session => { setCookie(session.cookie) }) }} />
    </View>
  )
}

const styles = createStyle({
  container: { flex: 1 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: H_PADDING, paddingBottom: 16 },
  loginCard: { marginTop: 12, paddingHorizontal: 16, paddingVertical: 14, borderRadius: 8, alignItems: 'center' },
  loginHint: { marginTop: 4 },
  cardRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 },
  // 板块标题和右上角的刷新钮同一行
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 20, paddingBottom: 10 },
  card: { borderRadius: 12, overflow: 'hidden', justifyContent: 'flex-end' },
  cardBg: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 },
  cardOverlay: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.3)' },
  // 文字和右下角的动作钮并排贴底。文字自己 flex:1，右内边距给按钮让位
  cardFooter: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', padding: 10 },
  cardText: { flex: 1, paddingRight: 8 },
  sectionTitle: { paddingTop: 20, paddingBottom: 10 },
  hList: { paddingRight: 8 },
  playlistCard: { width: scaleSizeW(104), marginRight: 10 },
  playlistCover: { width: scaleSizeW(104), height: scaleSizeW(104), borderRadius: 8 },
  playlistName: { marginTop: 6 },
  songRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1 },
  songPic: { width: 44, height: 44, borderRadius: 3 },
  songInfo: { flex: 1, paddingLeft: 10 },
})
