import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useScreenVisible } from '@/utils/hooks/useScreenVisible'
import { TouchableOpacity, View } from 'react-native'
import PageContent from '@/components/PageContent'
import StatusBar from '@/components/common/StatusBar'
import SimpleHeader from '@/components/SimpleHeader'
import PlayerBar from '@/components/player/PlayerBar'
import OnlineList, { type OnlineListType, type OnlineListProps } from '@/components/OnlineList'
import Text from '@/components/common/Text'
import ImageBackground from '@/components/common/ImageBackground'
import { IconIonicons } from '@/components/common/Icon'
import IconAction from '@/components/common/IconAction'
import PlusMinusIcon from '@/components/common/PlusMinusIcon'
import { setComponentId } from '@/core/common'
import { COMPONENT_IDS, LIST_IDS, QQ_HEART_RADAR_PLAYLIST_ID } from '@/config/constant'
import { setTempList } from '@/core/list'
import { createPlaySelection, playList } from '@/core/player/player'
import { getQQMusicPlaylistSongs, getQQMusicSession } from '@/core/qqMusic'
import { refreshQQMusicHomeDaily, refreshQQMusicHomeRadar } from '@/core/qqMusicHome'
import { getQQMusicLikedSongs, isQQMusicLikedSongsStale, loadQQMusicLikedSongsCache, refreshQQMusicLikedSongs, releaseQQMusicLikedSongs, retainQQMusicLikedSongs, toggleQQMusicPlaylistCollected } from '@/core/qqMusicFavorite'
import { cachePlaylistSongs, getCachedPlaylistSongs, getPlaylistSongsCacheVersion } from '@/core/qqMusicPlaylistSongsCache'
import { QQ_DAILY_PLAYLIST_ID, playQQMusicDailyPlaylist, playQQMusicHeartRadarPlaylist } from '@/core/qqMusicDailyPosition'
import {
  getQQMusicDailyPlaylistCache,
  getQQMusicHeartRadarCache,
  getQQMusicPlaylistsCache,
  getQQMusicRefreshDay,
} from '@/utils/data'
import { createStyle, toast } from '@/utils/tools'
import { scaleSizeW } from '@/utils/pixelRatio'
import { useWindowSize } from '@/utils/hooks'
import { useI18n } from '@/lang'

interface Props {
  componentId: string
  info: {
    id: string
    name: string
    liked?: boolean
    /** 每日推荐这类没有歌单 id 的列表：歌曲读本地那份缓存，播放走位置记忆 */
    daily?: boolean
    /** 红心雷达：同样没有歌单 id，歌曲读首页那份缓存，但播放不记位置 */
    radar?: boolean
    /** 头图封面。调用方手上就有（推荐流、我的歌单都带），缺了用纯色兜底 */
    cover?: string | null
    /** 头图副标题（共 N 首 / 作者之类）。调用方按自己的语境拼好，这里不猜 */
    subtitle?: string
    /** 收藏状态：true 已收藏 / false 自己建的 / 不给就是别人的歌单（推荐流那种） */
    subscribed?: boolean
  }
}

/**
 * 头图。作为列表头跟着内容一起滚，所以不用管吸顶。
 * action 挂在右下角（歌单收藏那个＋/－），跟左下角的播放钮同一行。
 */
const PlaylistHero = ({ name, subtitle, cover, onPlay, action }: {
  name: string
  subtitle?: string
  cover?: string | null
  onPlay: () => void
  action?: ReactNode
}) => {
  const t = useI18n()
  const windowSize = useWindowSize()
  // 平板横屏内容很宽，头图不能跟着 0.52 一路涨到几百上千高，封顶 380
  const height = Math.min(Math.round(windowSize.width * 0.52), 380)
  // 封面按自己的比例铺满宽度后的高度。头图这么扁，方形封面铺开是放不下的，
  // 超出的部分由容器从下面裁掉 —— 露出来的是封面上半截（歌名/歌手那块），
  // 而不是 cover 居中裁出来的中间那一条
  const [coverHeight, setCoverHeight] = useState(height)

  return (
    <View style={{ ...styles.hero, height }}>
      {/* 没有封面时什么都不铺：保留和其它歌单一样的暗层 + 白字布局，
          只是背景透出页面本身，不要绿色占位 */}
      {
        cover
          ? <ImageBackground
              style={styles.heroBg}
              imageStyle={{ height: coverHeight }}
              source={{ uri: cover }}
              resizeMode="cover"
              onLoad={({ nativeEvent }) => {
                const size = nativeEvent?.source
                if (!size?.width || !size?.height) return
                setCoverHeight(Math.max(height, Math.round(windowSize.width * size.height / size.width)))
              }}
            />
          : null
      }
      {/* 没有渐变库，文字可读性用纯色暗层代替（跟首页方形卡一个做法） */}
      <View style={styles.heroOverlay} />
      <View style={styles.heroBody}>
        <View style={styles.heroText}>
          <Text size={20} color="#fff" numberOfLines={2}>{name}</Text>
          {subtitle ? <Text size={12} color="rgba(255,255,255,0.85)" style={styles.heroSubtitle} numberOfLines={1}>{subtitle}</Text> : null}
          <TouchableOpacity style={styles.heroPlay} activeOpacity={0.8} onPress={onPlay}>
            <IconIonicons name="play" size={scaleSizeW(15)} color="#fff" />
            <Text size={14} color="#fff" style={styles.heroPlayText}>{t('play')}</Text>
          </TouchableOpacity>
        </View>
        {action}
      </View>
    </View>
  )
}

// 歌单页，三个来源共用：QQ 歌单 / 「我喜欢」/ 每日推荐。
// 不复用多源的 SonglistDetail：那条链路取歌走 core/songlist，而「我喜欢」是 dirid=201
// 的虚拟歌单，只有 getQQMusicPlaylistSongs 这条 CgiGetDiss 优先的通道认得；
// 每日推荐更是连歌单 id 都没有 —— 它的列表就是首页那份缓存。
export default ({ componentId, info }: Props) => {
  const t = useI18n()
  const listRef = useRef<OnlineListType>(null)
  const songsRef = useRef<LX.Music.MusicInfoOnline[]>([])
  const visible = useScreenVisible()
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const requestVersion = useRef(0)
  // 头图上那个收藏角标的状态。初始值来自进页面时带的 subscribed，点完就地翻转
  const [collected, setCollected] = useState(info.subscribed === true)
  const [collecting, setCollecting] = useState(false)

  // 「我喜欢」、每日推荐和红心雷达都没有可收藏的歌单身份；subscribed 明确是 false 的说明是自己建的
  const canCollect = !info.liked && !info.daily && !info.radar && info.subscribed !== false

  // 调用方没给收藏状态时（推荐流那种：手上只有别人的歌单信息），去「我的歌单」缓存里查一下
  // —— 本地读，不发请求。缓存里没有就当没收藏
  useEffect(() => {
    if (!canCollect || info.subscribed !== undefined) return
    let alive = true
    void getQQMusicPlaylistsCache().then(cached => {
      if (!alive) return
      if (cached.some(item => item.subscribed === true && item.id == info.id)) setCollected(true)
    })
    return () => { alive = false }
  }, [canCollect, info.id, info.subscribed])

  const toggleCollected = useCallback(async() => {
    if (collecting) return
    const next = !collected
    setCollecting(true)
    try {
      // 带上封面和当前这首数：收藏后「我的」页那条不会显示「共 0 首」。
      // 提示和缓存更新都在里面做掉了
      const playlist = {
        id: info.id,
        name: info.name,
        cover: info.cover ?? undefined,
        trackCount: songsRef.current.length,
      }
      if (await toggleQQMusicPlaylistCollected(playlist, next)) setCollected(next)
    } finally {
      setCollecting(false)
    }
  }, [collecting, collected, info])

  const load = useCallback(async(force: boolean) => {
    if (!visibleRef.current) return
    const version = ++requestVersion.current
    listRef.current?.setStatus('refreshing')
    try {
      let songs: LX.Music.MusicInfoOnline[]
      const localKind = info.daily === true ? 'daily' : info.radar === true ? 'radar' : null
      if (localKind) {
        // 每日推荐/红心雷达读首页那份缓存。「今天刷过了」的记账一起写上，
        // 免得首页再为同一批多拉一次
        const isDaily = localKind === 'daily'
        const fetchSongs = isDaily ? refreshQQMusicHomeDaily : refreshQQMusicHomeRadar
        const readCache = isDaily ? getQQMusicDailyPlaylistCache : getQQMusicHeartRadarCache
        const refreshKind = isDaily ? 'playlist' : 'radar'
        // 当天固定的一批允许直接复用；取新数据时与首页共用会话校验和落盘。
        const useCache = !force || await getQQMusicRefreshDay(refreshKind) == new Date().toDateString()
        songs = useCache ? await readCache() : []
        if (!songs.length) {
          const session = await getQQMusicSession()
          if (!session.cookie) throw new Error(t('qq_not_logged_in'))
          songs = await fetchSongs(session)
        }
      } else if (info.liked) {
        // 「我喜欢」走持久缓存：全量要翻好几页，进页面不该重拉，只有下拉刷新才联网。
        // 例外是缓存被标脏了（红心/取消红心之后本地改过、还没跟服务端核对）——
        // 这时重拉一次，跟歌单页「内容变了就丢缓存、下次打开自动刷新」是一个效果。
        // 拉失败继续用现有缓存，别让一次网络抖动把列表清空
        if (force || await isQQMusicLikedSongsStale()) {
          await refreshQQMusicLikedSongs().catch(() => {})
        }
        songs = getQQMusicLikedSongs() ?? await loadQQMusicLikedSongsCache()
      } else {
        // 打开过的歌单同样读缓存，只有下拉刷新才联网
        const cached = force ? null : await getCachedPlaylistSongs(info.id)
        if (cached) {
          songs = cached
        } else {
          const { cookie } = await getQQMusicSession()
          if (!cookie) throw new Error(t('qq_not_logged_in'))
          // 拿到当前账号后再记版本：请求期间换号的话，结果不再写回新账号的缓存
          const cacheVersion = getPlaylistSongsCacheVersion()
          songs = await getQQMusicPlaylistSongs(cookie, info.id)
          void cachePlaylistSongs(info.id, songs, cacheVersion)
        }
      }
      if (version !== requestVersion.current || !visibleRef.current) return
      songsRef.current = songs
      listRef.current?.setList(songs)
      // 取歌是一次拿全的，没有分页，所以直接标记到底
      listRef.current?.setStatus('end')
    } catch (error: unknown) {
      if (version !== requestVersion.current || !visibleRef.current) return
      listRef.current?.setStatus('error')
      toast(error instanceof Error ? error.message : t('qq_load_failed'), 'long')
    }
  }, [info.daily, info.id, info.liked, info.radar, t])

  useEffect(() => {
    setComponentId(COMPONENT_IDS.qqPlaylist, componentId)
    if (!visible) return
    const reason = `screen:qqLiked:${componentId}`
    if (info.liked) retainQQMusicLikedSongs(reason)
    void load(false)
    return () => {
      requestVersion.current += 1
      songsRef.current = []
      if (info.liked) releaseQQMusicLikedSongs(reason)
    }
  }, [componentId, load, info.liked, visible])

  // 点某一首就从那首开始放。每日推荐要打自己的临时列表 id，位置记忆靠它认队列
  // （见 core/qqMusicDailyPosition）；红心雷达也用自己的 id，免得和别的列表串位置记忆。
  // 别的歌单沿用各自的 id
  const playFrom: OnlineListProps['onPlayList'] = useCallback((index: number) => {
    const songs = songsRef.current
    if (!songs.length) return
    const selection = createPlaySelection()
    const listId = info.daily ? QQ_DAILY_PLAYLIST_ID : info.radar ? QQ_HEART_RADAR_PLAYLIST_ID : `qq__${info.id}`
    void setTempList(listId, [...songs]).then(async() => {
      if (selection()) await playList(LIST_IDS.TEMP, index, selection)
    })
  }, [info.daily, info.id, info.radar])

  // 头图的播放钮：每日推荐 / 红心雷达接着上次那首放，别的歌单从头放
  const playAll = useCallback(() => {
    const songs = songsRef.current
    if (!songs.length) return
    if (info.daily) void playQQMusicDailyPlaylist(songs)
    else if (info.radar) void playQQMusicHeartRadarPlaylist(songs)
    else playFrom(0)
  }, [info.daily, info.radar, playFrom])

  return (
    <PageContent>
      <StatusBar />
      <SimpleHeader componentId={componentId} title={info.name} />
      <OnlineList
        ref={listRef}
        releaseOnHide
        onPlayList={playFrom}
        onRefresh={() => { void load(true) }}
        onLoadMore={() => { listRef.current?.setStatus('end') }}
        ListHeaderComponent={
          <PlaylistHero
            name={info.name}
            subtitle={info.subtitle}
            cover={info.cover}
            onPlay={playAll}
            action={canCollect
              ? <IconAction
                  overlay
                  disabled={collecting}
                  onPress={() => { void toggleCollected() }}
                >
                  {/* QQ 音乐那个样子：没收藏是＋，收藏了只剩－ */}
                  <PlusMinusIcon saved={collected} color="#fff" />
                </IconAction>
              : undefined}
          />
        }
      />
      <PlayerBar />
    </PageContent>
  )
}

const styles = createStyle({
  hero: { width: '100%', justifyContent: 'flex-end' },
  // overflow: hidden 是为了裁掉封面超出头图的下半截（见 PlaylistHero 里对 coverHeight 的说明）
  heroBg: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, overflow: 'hidden' },
  heroOverlay: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.35)' },
  // 文字在左下、收藏角标在右下，同一行贴底
  heroBody: { flexDirection: 'row', alignItems: 'flex-end', padding: 16 },
  heroText: { flex: 1, paddingRight: 8 },
  heroSubtitle: { paddingTop: 4 },
  // 半透明胶囊：压在封面暗层上，白字白图标
  heroPlay: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', marginTop: 12, paddingHorizontal: 18, paddingVertical: 8, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.22)' },
  heroPlayText: { paddingLeft: 6 },
})
