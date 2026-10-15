import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshControl, ScrollView, TouchableOpacity, View } from 'react-native'
import Text from '@/components/common/Text'
import Image from '@/components/common/Image'
import ImageBackground from '@/components/common/ImageBackground'
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
import { navigations } from '@/navigation'
import commonState from '@/store/common/state'
import {
  getPlayHistory,
  getQQMusicDailyPlaylistCache,
  getQQMusicDailyRecommendCache,
  getQQMusicRecommendPlaylistsCache,
  saveQQMusicDailyPlaylistCache,
  saveQQMusicDailyRecommendCache,
  saveQQMusicRecommendPlaylistsCache,
} from '@/utils/data'
import { useI18n } from '@/lang'

type Songs = LX.Music.MusicInfoOnline[]
type Playlist = LX.QQMusic.PlaylistInfo

const DAILY_LIST_ID = 'qq_daily_playlist'
const H_PADDING = 14
const CARD_GAP = 10

/** 方形推荐卡。封面铺满，底部压一层暗色保证文字可读（没有渐变库，用纯色代替）。 */
const SquareCard = ({ title, subtitle, cover, onPress, disabled }: {
  title: string
  subtitle: string
  cover?: string | null
  onPress: () => void
  disabled?: boolean
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
      <View style={styles.cardText}>
        <Text size={17} color="#fff" numberOfLines={1}>{title}</Text>
        <Text size={11} color="rgba(255,255,255,0.85)" numberOfLines={1}>{subtitle}</Text>
      </View>
    </TouchableOpacity>
  )
}

// 首页：个性化推荐。上排两张方形卡（每日推荐 / 猜你喜欢），
// 下面是推荐歌单横向滚动和基于最近播放的相似推荐。
// 进页面只读本地缓存、不发请求；下拉刷新才联网。
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
      // 用 allSettled：任一块失败不该把已经拿到的其它块一起丢掉
      const [dailyResult, guessResult, playlistResult] = await Promise.allSettled([
        getQQMusicDailyPlaylist(cookie),
        getQQMusicDailyRecommendations(cookie),
        getQQMusicRecommendedPlaylists(cookie, nextFromRef.current),
      ])
      if (dailyResult.status == 'fulfilled') {
        setDaily(dailyResult.value)
        await saveQQMusicDailyPlaylistCache(dailyResult.value)
      }
      if (guessResult.status == 'fulfilled') {
        setGuess(guessResult.value)
        await saveQQMusicDailyRecommendCache(guessResult.value)
        // 刷新就是要换一批：上次那批的续播存档作废，下次点「猜你喜欢」从新的这批开头放。
        // 失败时不能丢——用户没拿到新列表，不该连续播也一起没了。
        await dropRecommendSession()
      }
      if (playlistResult.status == 'fulfilled') {
        setPlaylists(playlistResult.value.list)
        // 取尽后回到开头，这样能一直「一批批」换下去而不是停在最后一批
        nextFromRef.current = playlistResult.value.hasMore ? playlistResult.value.nextFrom : 0
        await saveQQMusicRecommendPlaylistsCache({ list: playlistResult.value.list, nextFrom: nextFromRef.current })
      }
      void loadSimilar(cookie)
      const failure = [dailyResult, guessResult, playlistResult].find(result => result.status == 'rejected')
      if (failure?.status == 'rejected') {
        toast(failure.reason instanceof Error ? failure.reason.message : t('qq_load_failed'), 'long')
      }
    } finally {
      refreshingRef.current = false
      setRefreshing(false)
    }
  }, [cookie, loadSimilar, loggedIn, t])

  // 每日推荐整表播放。用 30 首的独立列表，不挂电台续播那套
  const playDaily = useCallback(async() => {
    if (!daily.length) {
      loginRef.current?.show()
      return
    }
    await setTempList(DAILY_LIST_ID, [...daily])
    void playList(LIST_IDS.TEMP, 0)
  }, [daily])

  // 猜你喜欢走电台续播：播到快结束自动续下一批
  const playGuess = useCallback(async() => {
    if (!loggedIn) {
      loginRef.current?.show()
      return
    }
    setPlaying(true)
    try {
      if (await continueRecommendQueue(guess)) return
      let songs = guess
      if (!songs.length) {
        songs = await getQQMusicDailyRecommendations(cookie)
        if (!songs.length) throw new Error(t('qq_load_failed'))
        setGuess(songs)
        await saveQQMusicDailyRecommendCache(songs)
      }
      await setTempList(QQ_DAILY_RECOMMEND_ID, songs)
      initQQMusicRecommendAutoRefresh()
      await startRecommendQueue(songs, 0)
    } catch (error: unknown) {
      toast(error instanceof Error ? error.message : t('qq_load_failed'), 'long')
    } finally {
      setPlaying(false)
    }
  }, [cookie, guess, loggedIn, t])

  const playSongs = useCallback(async(listId: string, songs: Songs, index: number) => {
    await setTempList(listId, [...songs])
    void playList(LIST_IDS.TEMP, index)
  }, [])

  const openPlaylist = (info: Playlist) => {
    navigations.pushQQPlaylistScreen(commonState.componentIds.home!, { id: info.id, name: info.name, liked: info.liked })
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
            onPress={() => { void playDaily() }}
          />
          <SquareCard
            title={t('qq_guess_you_like')}
            subtitle={playing ? t('qq_loading') : t('mine_song_count', { num: guess.length })}
            cover={guess[0]?.meta.picUrl}
            onPress={() => { void playGuess() }}
            disabled={playing}
          />
        </View>

        {
          playlists.length
            ? <>
                <Text style={styles.sectionTitle} size={15}>{t('qq_recommend_playlists')}</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hList}>
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
  card: { borderRadius: 12, overflow: 'hidden', justifyContent: 'flex-end' },
  cardBg: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 },
  cardOverlay: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.3)' },
  cardText: { padding: 10 },
  sectionTitle: { paddingTop: 20, paddingBottom: 10 },
  hList: { paddingRight: 8 },
  playlistCard: { width: scaleSizeW(104), marginRight: 10 },
  playlistCover: { width: scaleSizeW(104), height: scaleSizeW(104), borderRadius: 8 },
  playlistName: { marginTop: 6 },
  songRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1 },
  songPic: { width: 44, height: 44, borderRadius: 3 },
  songInfo: { flex: 1, paddingLeft: 10 },
})
