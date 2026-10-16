import { useCallback, useEffect, useRef } from 'react'
import { TouchableOpacity, View } from 'react-native'
import PageContent from '@/components/PageContent'
import StatusBar from '@/components/common/StatusBar'
import SimpleHeader from '@/components/SimpleHeader'
import PlayerBar from '@/components/player/PlayerBar'
import OnlineList, { type OnlineListType, type OnlineListProps } from '@/components/OnlineList'
import Text from '@/components/common/Text'
import ImageBackground from '@/components/common/ImageBackground'
import { IconIonicons } from '@/components/common/Icon'
import { setComponentId } from '@/core/common'
import { COMPONENT_IDS, LIST_IDS } from '@/config/constant'
import { setTempList } from '@/core/list'
import { playList } from '@/core/player/player'
import { getQQMusicDailyPlaylist, getQQMusicPlaylistSongs, getQQMusicSession } from '@/core/qqMusic'
import { getQQMusicLikedSongs, isQQMusicLikedSongsStale, loadQQMusicLikedSongsCache, refreshQQMusicLikedSongs } from '@/core/qqMusicFavorite'
import { cachePlaylistSongs, getCachedPlaylistSongs } from '@/core/qqMusicPlaylistSongsCache'
import { QQ_DAILY_PLAYLIST_ID, playQQMusicDailyPlaylist } from '@/core/qqMusicDailyPosition'
import { getQQMusicDailyPlaylistCache, saveQQMusicDailyPlaylistCache } from '@/utils/data'
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
    /** 头图封面。调用方手上就有（推荐流、我的歌单都带），缺了用纯色兜底 */
    cover?: string | null
    /** 头图副标题（共 N 首 / 作者之类）。调用方按自己的语境拼好，这里不猜 */
    subtitle?: string
  }
}

/** 头图。作为列表头跟着内容一起滚，所以不用管吸顶 */
const PlaylistHero = ({ name, subtitle, cover, onPlay }: {
  name: string
  subtitle?: string
  cover?: string | null
  onPlay: () => void
}) => {
  const t = useI18n()
  const windowSize = useWindowSize()
  const height = Math.round(windowSize.width * 0.52)

  return (
    <View style={{ ...styles.hero, height }}>
      {
        cover
          ? <ImageBackground style={styles.heroBg} source={{ uri: cover }} resizeMode="cover" />
          : <View style={{ ...styles.heroBg, backgroundColor: '#4daf7c' }} />
      }
      {/* 没有渐变库，文字可读性用纯色暗层代替（跟首页方形卡一个做法） */}
      <View style={styles.heroOverlay} />
      <View style={styles.heroBody}>
        <Text size={20} color="#fff" numberOfLines={2}>{name}</Text>
        {subtitle ? <Text size={12} color="rgba(255,255,255,0.85)" style={styles.heroSubtitle} numberOfLines={1}>{subtitle}</Text> : null}
        <TouchableOpacity style={styles.heroPlay} activeOpacity={0.8} onPress={onPlay}>
          <IconIonicons name="play" size={scaleSizeW(15)} color="#fff" />
          <Text size={14} color="#fff" style={styles.heroPlayText}>{t('play')}</Text>
        </TouchableOpacity>
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
  const loadedRef = useRef(false)

  const load = useCallback(async(force: boolean) => {
    listRef.current?.setStatus('refreshing')
    try {
      let songs: LX.Music.MusicInfoOnline[]
      if (info.daily) {
        // 每日推荐读首页那份缓存，只有下拉刷新才联网重取（取回来顺手更新缓存，
        // 首页下次进来读到的就是新的）
        if (force) {
          const { cookie } = await getQQMusicSession()
          if (!cookie) throw new Error(t('qq_not_logged_in'))
          songs = await getQQMusicDailyPlaylist(cookie)
          await saveQQMusicDailyPlaylistCache(songs)
        } else {
          songs = await getQQMusicDailyPlaylistCache()
          if (!songs.length) throw new Error(t('qq_load_failed'))
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
          songs = await getQQMusicPlaylistSongs(cookie, info.id)
          void cachePlaylistSongs(info.id, songs)
        }
      }
      songsRef.current = songs
      listRef.current?.setList(songs)
      // 取歌是一次拿全的，没有分页，所以直接标记到底
      listRef.current?.setStatus('end')
    } catch (error: unknown) {
      listRef.current?.setStatus('error')
      toast(error instanceof Error ? error.message : t('qq_load_failed'), 'long')
    }
  }, [info.daily, info.id, info.liked, t])

  useEffect(() => {
    setComponentId(COMPONENT_IDS.qqPlaylist, componentId)
    // 守卫要同步置位：依赖变化重跑时，上一次的请求可能还没回来
    if (loadedRef.current) return
    loadedRef.current = true
    void load(false)
  }, [componentId, load])

  // 点某一首就从那首开始放。每日推荐要打自己的临时列表 id，位置记忆靠它认队列
  // （见 core/qqMusicDailyPosition），别的歌单沿用各自的 id
  const playFrom: OnlineListProps['onPlayList'] = useCallback((index: number) => {
    const songs = songsRef.current
    if (!songs.length) return
    void setTempList(info.daily ? QQ_DAILY_PLAYLIST_ID : `qq__${info.id}`, [...songs]).then(() => {
      void playList(LIST_IDS.TEMP, index)
    })
  }, [info.daily, info.id])

  // 头图的播放钮：每日推荐接着上次那首放，别的歌单从头放
  const playAll = useCallback(() => {
    const songs = songsRef.current
    if (!songs.length) return
    if (info.daily) void playQQMusicDailyPlaylist(songs)
    else playFrom(0)
  }, [info.daily, playFrom])

  return (
    <PageContent>
      <StatusBar />
      <SimpleHeader componentId={componentId} title={info.name} />
      <OnlineList
        ref={listRef}
        onPlayList={playFrom}
        onRefresh={() => { void load(true) }}
        onLoadMore={() => { listRef.current?.setStatus('end') }}
        ListHeaderComponent={<PlaylistHero name={info.name} subtitle={info.subtitle} cover={info.cover} onPlay={playAll} />}
      />
      <PlayerBar />
    </PageContent>
  )
}

const styles = createStyle({
  hero: { width: '100%', justifyContent: 'flex-end' },
  heroBg: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 },
  heroOverlay: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.35)' },
  heroBody: { padding: 16 },
  heroSubtitle: { paddingTop: 4 },
  // 半透明胶囊：压在封面暗层上，白字白图标
  heroPlay: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', marginTop: 12, paddingHorizontal: 18, paddingVertical: 8, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.22)' },
  heroPlayText: { paddingLeft: 6 },
})
