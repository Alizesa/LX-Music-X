import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { RefreshControl, ScrollView, TouchableOpacity, View, type LayoutChangeEvent } from 'react-native'
import HorizontalScrollHost, { hasNativeHorizontalScrollHost } from '@/components/HorizontalScrollHost'
import Text from '@/components/common/Text'
import Image from '@/components/common/Image'
import ImageBackground from '@/components/common/ImageBackground'
import IconAction from '@/components/common/IconAction'
import QQMusicLoginModal, { type QQMusicLoginModalType } from '@/components/QQMusicLoginModal'
import { useTheme } from '@/store/theme/hook'
import { useTabletLayout } from '@/utils/hooks'
import { createStyle, toast } from '@/utils/tools'
import { LIST_IDS, QQ_HEART_RADAR_PLAYLIST_ID } from '@/config/constant'
import { setHomePagerHorizontalScroll } from '@/core/homePagerScroll'
import { setTempList } from '@/core/list'
import { createPlaySelection, playList } from '@/core/player/player'
import {
  getQQMusicSession,
  getQQMusicSimilarSongs,
  isQQMusicSessionCurrent,
  QQMusicSessionExpiredError,
  type QQMusicSession,
} from '@/core/qqMusic'
import { refreshQQMusicHomeDaily, refreshQQMusicHomeGuess, refreshQQMusicHomePlaylists, refreshQQMusicHomeRadar } from '@/core/qqMusicHome'
import { continueRecommendQueue, initQQMusicRecommendAutoRefresh, startRecommendQueue } from '@/core/qqMusicRecommend'
import { QQ_DAILY_PLAYLIST_ID, playQQMusicDailyPlaylist, playQQMusicHeartRadarPlaylist } from '@/core/qqMusicDailyPosition'
import { navigations } from '@/navigation'
import commonState from '@/store/common/state'
import {
  getPlayHistory,
  getQQMusicDailyPlaylistCache,
  getQQMusicDailyRecommendCache,
  getQQMusicHeartRadarCache,
  getQQMusicRecommendPlaylistsCache,
  getQQMusicRefreshDay,
} from '@/utils/data'
import { useI18n } from '@/lang'

type Songs = LX.Music.MusicInfoOnline[]
type Playlist = LX.QQMusic.PlaylistInfo
type HomeCacheKind = 'daily' | 'guess' | 'radar' | 'playlists'

// 新 APK 在原生触摸阶段保护横滑，只有旧 APK 才需要 JS 往返切换翻页开关。
const horizontalScrollProps = {
  nestedScrollEnabled: true,
  ...(hasNativeHorizontalScrollHost ? {} : {
    onTouchStart: () => { setHomePagerHorizontalScroll(true) },
    onTouchEnd: () => { setHomePagerHorizontalScroll(false) },
    onTouchCancel: () => { setHomePagerHorizontalScroll(false) },
  }),
}

// 每日推荐的临时列表 id。位置记忆和历史标记都按它认队列，所以放在 core 里统一导出
const DAILY_LIST_ID = QQ_DAILY_PLAYLIST_ID
const H_PADDING = 14
const CARD_GAP = 10
// 横向滑动页里露出下一张的一小截，提示后面还有卡片
const CARD_PEEK = 20

/** 一行两张、可横向滑动的推荐卡宽度（第三张只露出一截） */
const getCardSide = (width: number, gap: number) => Math.max(1, (width - H_PADDING * 2 - gap * 2 - CARD_PEEK) / 2)

/**
 * 方形推荐卡。封面铺满，底部压一层暗色保证文字可读（没有渐变库，用纯色代替）。
 *
 * `action` 挂在卡片这个 TouchableOpacity 里面：点它只走它自己的 onPress（内层先拿到
 * 手势响应），不会连带触发卡片的 onPress —— 所以每日推荐能「按钮播放、卡片展开列表」。
 * 不传 subtitle 就只显示标题（猜你喜欢的小字去掉了）。
 */
const RecommendCard = ({ title, subtitle, cover, onPress, disabled, action, width, height }: {
  title: string
  subtitle?: string
  cover?: string | null
  onPress: () => void
  disabled?: boolean
  action?: ReactNode
  width: number
  height: number
}) => {
  return (
    <TouchableOpacity style={{ ...styles.card, width, height, opacity: disabled ? 0.6 : 1 }} activeOpacity={0.85} disabled={disabled} onPress={onPress}>
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

// 首页：个性化推荐。上排是横向滑动的推荐卡（每日推荐 / 猜你喜欢 / 红心雷达），
// 往下是推荐歌单横向滚动和基于最近播放的相似推荐。
// 进页面只读本地缓存、不发请求；下拉刷新才联网，而且只管「每日推荐」这一块 ——
// 猜你喜欢和推荐歌单各自带刷新钮（卡片右下角 / 板块标题右侧），下拉不碰它们，
// 免得把用户正在听、正在看的那一批顺手换掉。
// 每日推荐 / 红心雷达的点击是「进歌单页（头图 + 那批歌）」，猜你喜欢是「播放」；
// 卡上的圆钮才是播放 / 刷新。
export default () => {
  const t = useI18n()
  const theme = useTheme()
  const { isWide, contentWidth } = useTabletLayout()
  const [pageWidth, setPageWidth] = useState<number | null>(null)
  const onLayout = useCallback(({ nativeEvent: { layout: { width } } }: LayoutChangeEvent) => {
    if (Number.isFinite(width) && width > 0) setPageWidth(width)
  }, [])
  const measuredWidth = pageWidth ?? contentWidth
  // 平板横屏内容更宽：边距放大、推荐卡一行三张；推荐歌单仍横向滑动
  const hPadding = isWide ? 24 : H_PADDING
  const availableWidth = Math.max(1, measuredWidth - hPadding * 2)
  const cardsPerRow = isWide ? 3 : 2
  // createStyle 会缩放 gap，尺寸计算使用渲染时的同一份值。
  const cardGap = styles.cardRow.gap
  const cardWidth = isWide
    ? Math.max(1, Math.min(Math.floor((availableWidth - cardGap * (cardsPerRow - 1)) / cardsPerRow), 340))
    : getCardSide(measuredWidth, cardGap)
  // 平板横屏把卡片压扁到约 16:9，三张卡片不再占满首屏
  const cardHeight = isWide ? Math.min(Math.round(cardWidth * 0.56), 200) : cardWidth
  const similarColumns = isWide ? 2 : 1
  const similarItemWidth: `${number}%` = isWide ? '50%' : '100%'
  const loginRef = useRef<QQMusicLoginModalType>(null)
  const [session, setSession] = useState<QQMusicSession | null>(null)
  const mounted = useRef(true)
  const cacheRevisions = useRef({ daily: 0, guess: 0, radar: 0, playlists: 0 })
  const guessRequestRevision = useRef(0)
  const guessPlayRevision = useRef(0)
  const [daily, setDaily] = useState<Songs>([])
  const [guess, setGuess] = useState<Songs>([])
  const [radar, setRadar] = useState<Songs>([])
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [similar, setSimilar] = useState<{ title: string, seedName: string, songs: Songs }>({ title: '', seedName: '', songs: [] })
  const [refreshing, setRefreshing] = useState(false)
  const refreshingRef = useRef(false)
  const [playing, setPlaying] = useState(false)
  const [refreshingGuess, setRefreshingGuess] = useState(false)
  const refreshingGuessRef = useRef(false)
  const [refreshingPlaylists, setRefreshingPlaylists] = useState(false)
  const refreshingPlaylistsRef = useRef(false)

  const loggedIn = !!session?.cookie
  const isCurrent = useCallback(() => mounted.current && !!session?.cookie && isQQMusicSessionCurrent(session), [session])
  const applyResult = useCallback(async<T,>(kind: HomeCacheKind, request: Promise<T>, update: (value: T) => void): Promise<T> => {
    const value = await request
    if (!isCurrent()) throw new QQMusicSessionExpiredError()
    cacheRevisions.current[kind]++
    update(value)
    return value
  }, [isCurrent])

  // 旧 APK 的回退锁在页面卸载时释放，原生容器不需要 JS 清理翻页开关。
  useEffect(() => {
    if (hasNativeHorizontalScrollHost) return
    return () => { setHomePagerHorizontalScroll(false) }
  }, [])
  // 旧 APK 中，推荐歌单在退出登录/清空时卸载，不一定再有 onTouchEnd。
  useEffect(() => {
    if (!hasNativeHorizontalScrollHost && (!loggedIn || !playlists.length)) setHomePagerHorizontalScroll(false)
  }, [loggedIn, playlists.length])

  useEffect(() => {
    mounted.current = true
    let revision = 0
    const handleAccountUpdate = () => {
      const request = ++revision
      setSession(null)
      setDaily([])
      setGuess([])
      setRadar([])
      setPlaylists([])
      setSimilar({ title: '', seedName: '', songs: [] })
      refreshingRef.current = refreshingGuessRef.current = refreshingPlaylistsRef.current = false
      setRefreshing(false)
      setRefreshingGuess(false)
      setRefreshingPlaylists(false)
      setPlaying(false)
      void getQQMusicSession().then(current => {
        if (mounted.current && request === revision && isQQMusicSessionCurrent(current)) setSession(current)
      }).catch(console.warn)
    }
    handleAccountUpdate()
    global.app_event.on('qqMusicAccountUpdated', handleAccountUpdate)
    return () => {
      mounted.current = false
      revision++
      global.app_event.off('qqMusicAccountUpdated', handleAccountUpdate)
    }
  }, [])

  useEffect(() => {
    if (!isCurrent()) return
    let active = true
    const restore = async<T,>(kind: HomeCacheKind, request: Promise<T>, update: (value: T) => void) => {
      const revision = cacheRevisions.current[kind]
      const value = await request
      if (active && isCurrent() && revision === cacheRevisions.current[kind]) update(value)
    }
    void Promise.all([
      restore('daily', getQQMusicDailyPlaylistCache(), setDaily),
      restore('guess', getQQMusicDailyRecommendCache(), setGuess),
      restore('radar', getQQMusicHeartRadarCache(), setRadar),
      restore('playlists', getQQMusicRecommendPlaylistsCache(), cache => { setPlaylists(cache?.list ?? []) }),
    ]).catch(console.warn)
    return () => { active = false }
  }, [isCurrent])

  // 相似推荐的种子取最近播放的第一首 QQ 歌曲
  const loadSimilar = useCallback(async(activeSession: QQMusicSession | null) => {
    if (!activeSession?.cookie || !isQQMusicSessionCurrent(activeSession)) return
    const history = await getPlayHistory()
    if (!mounted.current || !isQQMusicSessionCurrent(activeSession)) return
    const seed = history.find(item => {
      const info = 'metadata' in item.musicInfo ? item.musicInfo.metadata.musicInfo : item.musicInfo
      return info.source == 'tx' && !!info.meta.id
    })
    if (!seed) return
    const info = 'metadata' in seed.musicInfo ? seed.musicInfo.metadata.musicInfo : seed.musicInfo
    const seedId = (info.meta as LX.Music.MusicInfoOnline['meta'] & { id?: string }).id
    try {
      const result = await getQQMusicSimilarSongs(activeSession.cookie, seedId!)
      if (!mounted.current || !isQQMusicSessionCurrent(activeSession) || !result.songs.length) return
      setSimilar({ title: result.title, seedName: info.name, songs: result.songs })
    } catch {
      // 相似推荐失败不影响首页其它板块，静默跳过
    }
  }, [])

  useEffect(() => { void loadSimilar(session).catch(console.warn) }, [session, loadSimilar])

  /** 拉一份新的每日推荐：铺上、落盘、记下「今天刷过了」 */
  const fetchDaily = useCallback(async() => applyResult('daily', refreshQQMusicHomeDaily(session), setDaily), [session, applyResult])

  /** 拉一份新的猜你喜欢：铺上、落盘、作废上次那批的续播存档、记下「今天刷过了」 */
  const fetchGuess = useCallback(async() => {
    // 刷新一开始就作废尚未完成的旧卡片点播，不能等新批次返回后才阻止恢复。
    guessRequestRevision.current++
    return applyResult('guess', refreshQQMusicHomeGuess(session), setGuess)
  }, [session, applyResult])

  /** 拉一份新的红心雷达：铺上、落盘、记下「今天刷过了」 */
  const fetchRadar = useCallback(async() => applyResult('radar', refreshQQMusicHomeRadar(session), setRadar), [session, applyResult])

  // 跨天自动刷新：首页铺完缓存后看一眼这份缓存是不是「今天刷的」，不是就自己去拉一次
  // （缓存空的时候记账也没有，同样落到这里）。每天首次进首页各一次请求，
  // 之后就不管了 —— 中途要看新的一批还是下拉/点刷新钮。失败保持旧内容，不打扰用户
  useEffect(() => {
    if (!isCurrent()) return
    let active = true
    const valid = () => active && isCurrent()
    const check = async() => {
      const [dailyDay, guessDay, radarDay] = await Promise.all([
        getQQMusicRefreshDay('playlist'),
        getQQMusicRefreshDay('recommend'),
        getQQMusicRefreshDay('radar'),
      ])
      const today = new Date().toDateString()
      // 用户刚好在下拉刷新时别凑热闹
      if (!valid() || refreshingRef.current || refreshingGuessRef.current) return
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
          if (valid()) refreshingRef.current = false
        }
      }
      if (!valid()) return
      if (guessDay != today) {
        refreshingGuessRef.current = true
        try {
          await fetchGuess()
        } catch (error) {
          failures.push(`猜你喜欢: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          if (valid()) refreshingGuessRef.current = false
        }
      }
      if (!valid()) return
      if (radarDay != today) {
        try {
          await fetchRadar()
        } catch (error) {
          failures.push(`红心雷达: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (valid() && failures.length) console.warn('[QQMusic] 跨天自动刷新失败，先用旧内容:', failures.join('; '))
    }
    void check().catch(console.warn)
    return () => { active = false }
  }, [isCurrent, fetchDaily, fetchGuess, fetchRadar])

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
      if (isCurrent()) toast(error instanceof Error ? error.message : t('qq_load_failed'), 'long')
    } finally {
      if (isCurrent()) {
        refreshingRef.current = false
        setRefreshing(false)
      }
    }
    // 相似推荐是顺带算的，跟着下拉一起更新；它自己失败是静默的
    void loadSimilar(session).catch(console.warn)
  }, [session, fetchDaily, loadSimilar, loggedIn, t, isCurrent])

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
      // 每次都向个性化音乐流重新要第一页（first_req_time=1），换一批歌单卡；
      // 和 MusicOne 首页刷新一致，不再自己维护 From 游标
      await applyResult('playlists', refreshQQMusicHomePlaylists(session), setPlaylists)
    } catch (error: unknown) {
      if (isCurrent()) toast(error instanceof Error ? error.message : t('qq_load_failed'), 'long')
    } finally {
      if (isCurrent()) {
        refreshingPlaylistsRef.current = false
        setRefreshingPlaylists(false)
      }
    }
  }, [session, loggedIn, t, isCurrent, applyResult])

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
      if (isCurrent()) toast(error instanceof Error ? error.message : t('qq_load_failed'), 'long')
    } finally {
      if (isCurrent()) {
        refreshingGuessRef.current = false
        setRefreshingGuess(false)
      }
    }
  }, [fetchGuess, loggedIn, t, isCurrent])

  /**
   * 要用的那批每日推荐。缓存还没铺（新装、刚登录、上次拉取失败）时先联网拉一次 ——
   * 「进页面只读缓存」是说进页面，用户点了卡片却弹登录是说不通的。
   * 没登录才弹登录框；拉取失败提示一下就收工。
   */
  const ensureDailySongs = useCallback(async(): Promise<Songs | null> => {
    if (daily.length && isCurrent()) return daily
    if (!loggedIn) {
      loginRef.current?.show()
      return null
    }
    try {
      return await fetchDaily()
    } catch (error: unknown) {
      if (isCurrent()) toast(error instanceof Error ? error.message : t('qq_load_failed'), 'long')
      return null
    }
  }, [daily, fetchDaily, loggedIn, t, isCurrent])

  /** 红心雷达同样先用首页缓存；缓存没铺（新装、刚登录）时点卡片再联网拉 */
  const ensureRadarSongs = useCallback(async(): Promise<Songs | null> => {
    if (radar.length && isCurrent()) return radar
    if (!loggedIn) {
      loginRef.current?.show()
      return null
    }
    try {
      return await fetchRadar()
    } catch (error: unknown) {
      if (isCurrent()) toast(error instanceof Error ? error.message : t('qq_load_failed'), 'long')
      return null
    }
  }, [fetchRadar, loggedIn, radar, t, isCurrent])

  // 每日推荐整表播放。用 30 首的独立列表，不挂电台续播那套
  const playDaily = useCallback(async() => {
    const selection = createPlaySelection()
    const isCurrentPlay = () => selection() && isCurrent()
    const songs = await ensureDailySongs()
    if (!songs || !isCurrentPlay()) return
    // 接着上次那首放（见 core/qqMusicDailyPosition）。列表换了/歌没了会自动回到开头
    await playQQMusicDailyPlaylist(songs, isCurrentPlay)
  }, [ensureDailySongs, isCurrent])

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
    const selection = createPlaySelection()
    const request = ++guessPlayRevision.current
    let batchRevision = guessRequestRevision.current
    const isCurrentPlay = () => selection() && isCurrent() && batchRevision === guessRequestRevision.current
    setPlaying(true)
    try {
      if (await continueRecommendQueue(guess, isCurrentPlay) !== false || !isCurrentPlay()) return
      // 抓不到一批（比如启动时的自动刷新失败了）：走同一条拉取路径，
      // 这样「今天刷过了」也会记上，下次冷启动不会再为同一批多请求一次
      let songs = guess
      if (!songs.length) {
        const loading = fetchGuess()
        // 这是本次点播自己请求的新批次，继续沿用同一个播放选择。
        batchRevision = guessRequestRevision.current
        songs = await loading
      }
      if (!isCurrentPlay()) return
      initQQMusicRecommendAutoRefresh()
      await startRecommendQueue(songs, 0, undefined, isCurrentPlay)
    } catch (error: unknown) {
      if (isCurrentPlay()) toast(error instanceof Error ? error.message : t('qq_load_failed'), 'long')
    } finally {
      if (isCurrent() && request === guessPlayRevision.current) setPlaying(false)
    }
  }, [fetchGuess, guess, loggedIn, t, isCurrent])

  const playSongs = useCallback(async(listId: string, songs: Songs, index: number) => {
    const isCurrentPlay = createPlaySelection()
    await setTempList(listId, [...songs])
    if (isCurrentPlay()) await playList(LIST_IDS.TEMP, index, isCurrentPlay)
  }, [])

  // 红心雷达整表播放。和每日推荐一样接着上次那首放，不挂电台续播
  const playRadar = useCallback(async() => {
    const selection = createPlaySelection()
    const isCurrentPlay = () => selection() && isCurrent()
    const songs = await ensureRadarSongs()
    if (!songs || !isCurrentPlay()) return
    await playQQMusicHeartRadarPlaylist(songs, isCurrentPlay)
  }, [ensureRadarSongs, isCurrent])

  // 横幅进歌单页（头图 + 那批红心雷达歌曲），播放交给右下角的按钮
  const openRadar = useCallback(async() => {
    const songs = await ensureRadarSongs()
    if (!songs) return
    navigations.pushQQPlaylistScreen(commonState.componentIds.home!, {
      id: QQ_HEART_RADAR_PLAYLIST_ID,
      name: t('qq_heart_radar'),
      radar: true,
      cover: songs[0]?.meta.picUrl,
      subtitle: t('mine_song_count', { num: songs.length }),
    })
  }, [ensureRadarSongs, t])

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
    <View style={styles.container} onLayout={onLayout}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ paddingHorizontal: hPadding, paddingBottom: 16 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void refresh() }} colors={[theme['c-primary']]} />}
      >
        {
          loggedIn
            ? null
            : <TouchableOpacity style={{ ...styles.loginCard, maxWidth: 620, alignSelf: 'center', backgroundColor: theme['c-button-background'] }} onPress={() => loginRef.current?.show()}>
                <Text color={theme['c-button-font']}>{t('qq_login')}</Text>
                <Text size={12} color={theme['c-button-font']} style={styles.loginHint}>{t('qq_login_hint')}</Text>
              </TouchableOpacity>
        }

        <HorizontalScrollHost style={{ ...styles.horizontalHost, ...styles.cardScroll }}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ ...styles.horizontalScroll, width: availableWidth }}
            contentContainerStyle={isWide ? { ...styles.cardRow, flexGrow: 1, justifyContent: 'center' } : styles.cardRow}
            {...horizontalScrollProps}
          >
            <RecommendCard
              title={t('qq_daily_recommend')}
              subtitle={t('mine_song_count', { num: daily.length })}
              cover={daily[0]?.meta.picUrl}
              width={cardWidth}
              height={cardHeight}
              onPress={() => { void openDaily() }}
              action={<IconAction overlay icon="play" onPress={() => { void playDaily() }} />}
            />
            <RecommendCard
              title={t('qq_guess_you_like')}
              cover={guess[0]?.meta.picUrl}
              width={cardWidth}
              height={cardHeight}
              onPress={() => { void playGuess() }}
              disabled={playing}
              action={<IconAction overlay icon="refresh" onPress={() => { void refreshGuess() }} disabled={refreshingGuess} />}
            />
            <RecommendCard
              title={t('qq_heart_radar')}
              subtitle={t('mine_song_count', { num: radar.length })}
              cover={radar[0]?.meta.picUrl}
              width={cardWidth}
              height={cardHeight}
              onPress={() => { void openRadar() }}
              action={<IconAction overlay icon="play" onPress={() => { void playRadar() }} />}
            />
          </ScrollView>
        </HorizontalScrollHost>

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
                    ? <HorizontalScrollHost style={styles.horizontalHost}>
                        <ScrollView
                          horizontal
                          showsHorizontalScrollIndicator={false}
                          style={{ ...styles.horizontalScroll, width: availableWidth }}
                          contentContainerStyle={styles.hList}
                          {...horizontalScrollProps}
                        >
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
                      </HorizontalScrollHost>
                    : null
                }
              </>
            : null
        }

        {
          similar.songs.length
            ? <>
                <Text style={styles.sectionTitle} size={15} numberOfLines={1}>{similarTitle}</Text>
                <View style={styles.similarGrid}>
                  {
                    similar.songs.map((song, index) => (
                      <TouchableOpacity
                        key={`${song.id}-${index}`}
                        style={{ ...styles.songRow, width: similarItemWidth, paddingRight: similarColumns > 1 ? 12 : 0, borderBottomColor: theme['c-border-background'] }}
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
                </View>
              </>
            : null
        }
      </ScrollView>

      <QQMusicLoginModal ref={loginRef} />
    </View>
  )
}

const styles = createStyle({
  container: { flex: 1 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: H_PADDING, paddingBottom: 16 },
  loginCard: { marginTop: 12, paddingHorizontal: 16, paddingVertical: 14, borderRadius: 8, alignItems: 'center' },
  loginHint: { marginTop: 4 },
  horizontalHost: { flexGrow: 0, flexShrink: 0 },
  horizontalScroll: { flexGrow: 0, flexShrink: 0 },
  cardScroll: { marginTop: 12 },
  // 横向滑动页：卡片之间留固定间距
  cardRow: { gap: CARD_GAP },
  // 板块标题和右上角的刷新钮同一行
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 20, paddingBottom: 10 },
  card: { borderRadius: 12, overflow: 'hidden', justifyContent: 'flex-end' },
  cardBg: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 },
  cardOverlay: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.3)' },
  // 文字和右下角的动作钮并排贴底。文字自己 flex:1，右内边距给按钮让位
  cardFooter: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', padding: 10 },
  cardText: { flex: 1, paddingRight: 8 },
  sectionTitle: { paddingTop: 20, paddingBottom: 10 },
  similarGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  hList: { paddingRight: 8 },
  playlistCard: { width: 104, marginRight: 10 },
  playlistCover: { width: 104, height: 104, borderRadius: 8 },
  playlistName: { marginTop: 6 },
  songRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1 },
  songPic: { width: 44, height: 44, borderRadius: 3 },
  songInfo: { flex: 1, paddingLeft: 10 },
})
