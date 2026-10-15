import { useEffect, useState } from 'react'
import { getQQMusicPlaylistSongs, getQQMusicSession, postAuthedMusicu } from './qqMusic'
import { getQQMusicLikedSongsCache, removeQQMusicLikedSongsCache, saveQQMusicLikedSongsCache } from '@/utils/data'
import { clearPlaylistSongsCache } from './qqMusicPlaylistSongsCache'

// 「我喜欢」是 dirid=201 的虚拟歌单
const LIKED_DIRID = '201'
// 服务端要求的写入来源标识
const WRITE_SOURCE = 'normal'
// 这几个返回码表示票据失效
const LOGIN_ERROR_CODES = new Set([1000, 104400, 104401])

export type FavoriteResult = 'ok' | 'unsupported' | 'failed'

/**
 * 写接口要带的歌曲类型：1 普通歌曲 / 2 长音频 / 6 视频直播。
 *
 * **必须是真类型，传 0 会被拒**（早先这里硬编码 0，写歌单一直报 80092）。
 * 歌曲详情里没有这个字段时按普通歌曲算 —— 绝大多数歌都是 1。
 */
const readSongType = (musicInfo: LX.Music.MusicInfo_tx) => {
  const type = Number(musicInfo.meta.songType)
  return Number.isFinite(type) && type > 0 ? type : 1
}

/**
 * 「我喜欢」的全量歌曲。
 *
 * 拉一次要翻好几页（两百多首），所以**持久缓存**：内存 → 存储 → 联网。
 * 心形状态和「我喜欢」歌单页都读这份缓存，只有手动下拉刷新才联网 ——
 * 这个分支有意压低对音源的请求量。
 */
let likedSongs: LX.Music.MusicInfoOnline[] | null = null
let likedIds: Set<string> | null = null
let fetchPromise: Promise<void> | null = null

const setLikedSongs = (songs: LX.Music.MusicInfoOnline[] | null) => {
  likedSongs = songs
  likedIds = songs ? new Set(songs.map(song => song.id)) : null
  global.app_event.qqMusicLikedUpdated()
}

export const isQQMusicTrackLiked = (id: string | null | undefined) =>
  id ? likedIds?.has(id) ?? false : false

/** 已缓存的「我喜欢」歌曲；还没加载过返回 null。 */
export const getQQMusicLikedSongs = () => likedSongs

/** 只读本地缓存（内存 → 存储），不联网。 */
export const loadQQMusicLikedSongsCache = async(): Promise<LX.Music.MusicInfoOnline[]> => {
  if (likedSongs) return likedSongs
  const cached = await getQQMusicLikedSongsCache()
  if (cached.length) setLikedSongs(cached)
  return cached
}

const doFetch = async() => {
  try {
    const { cookie } = await getQQMusicSession()
    if (!cookie) {
      setLikedSongs(null)
      await removeQQMusicLikedSongsCache()
      return
    }
    const songs = await getQQMusicPlaylistSongs(cookie, LIKED_DIRID)
    setLikedSongs(songs)
    await saveQQMusicLikedSongsCache(songs)
  } catch (error) {
    // 失败保留上一次的缓存，不要因为一次网络抖动把心形状态全清空
    console.log('[QQMusic] 拉取我喜欢失败:', error)
  }
}

/** 联网拉一次「我喜欢」并落盘。并发调用共用同一次请求。 */
export const refreshQQMusicLikedSongs = async(): Promise<void> => {
  fetchPromise ??= doFetch().finally(() => { fetchPromise = null })
  await fetchPromise
}

/** 收藏/取消后同步更新本地缓存，省掉一次全量重拉 */
const markLiked = (musicInfo: LX.Music.MusicInfo, liked: boolean) => {
  const songs = likedSongs ?? []
  const next = liked
    ? (songs.some(song => song.id == musicInfo.id) ? songs : [musicInfo as LX.Music.MusicInfoOnline, ...songs])
    : songs.filter(song => song.id != musicInfo.id)
  setLikedSongs(next)
  void saveQQMusicLikedSongsCache(next)
}

/** 换号/退出时清掉，否则新号会看到上一个号的收藏状态 */
export const clearQQMusicLikedSongs = () => {
  setLikedSongs(null)
  void removeQQMusicLikedSongsCache()
}

/**
 * 启动时挂一次账号变化的监听。不放在模块顶层：那时 global.app_event
 * 未必已经建好。由 core/init/dataInit 调用。
 */
export const initQQMusicFavorite = () => {
  global.app_event.on('qqMusicAccountUpdated', () => {
    clearQQMusicLikedSongs()
    // 歌单内容的缓存是另一个号的，一并清掉
    void clearPlaylistSongsCache()
  })
}

/**
 * 把一首歌加进/移出 QQ 音乐的「我喜欢」。
 *
 * 返回 'unsupported' 表示这次不该走账号：没登录，或者这首歌不是 QQ 的 ——
 * 调用方据此退回本地「我的收藏」列表。
 */
export const setQQMusicTrackLiked = async(musicInfo: LX.Music.MusicInfo, liked: boolean): Promise<FavoriteResult> => {
  if (musicInfo.source != 'tx') return 'unsupported'
  const songId = Number(musicInfo.meta.id ?? 0)
  if (!songId) return 'unsupported'
  const { cookie } = await getQQMusicSession()
  if (!cookie) return 'unsupported'

  const body = await postAuthedMusicu(cookie, {
    req_0: {
      module: 'music.musicasset.PlaylistDetailWrite',
      method: liked ? 'AddSonglist' : 'DelSonglist',
      param: {
        dirId: Number(LIKED_DIRID),
        tid: 0,
        bFmtUtf8: true,
        source: WRITE_SOURCE,
        v_songInfo: [{ songId, songType: readSongType(musicInfo) }],
      },
    },
  })
  const result = body?.req_0
  const code = Number(result?.code ?? -1)
  if (LOGIN_ERROR_CODES.has(code)) throw new Error(global.i18n.t('qq_session_expired'))
  if (code !== 0) return 'failed'
  const retCode = Number(result?.data?.retCode ?? -1)
  if (retCode !== 0) return 'failed'

  markLiked(musicInfo, liked)
  return 'ok'
}

/**
 * 把一首歌加进 / 移出某个**自己创建的** QQ 歌单。
 *
 * 写接口的 dirId 是目录编号。**优先用歌单自带的 dirId，没有就退回用歌单 id 顶上** ——
 * 很多账号的创建歌单响应里根本没有 dirid 字段，只有编号，硬性要求 dirId 会让功能整个不可用。
 * （MusicOne 也是这么回退的。）
 *
 * 校验失败时**抛错并带上服务端的返回码**：写不通的原因基本都在码里，
 * 只回一句「失败」等于把唯一的线索丢了。
 */
export const setQQMusicTrackInPlaylist = async(
  musicInfo: LX.Music.MusicInfo,
  playlist: Pick<LX.QQMusic.PlaylistInfo, 'id' | 'name' | 'dirId'>,
  add: boolean,
): Promise<FavoriteResult> => {
  if (musicInfo.source != 'tx') return 'unsupported'
  const songId = Number(musicInfo.meta.id ?? 0)
  if (!songId) return 'unsupported'
  const numericId = Number(playlist.id)
  const dirId = playlist.dirId ?? (Number.isFinite(numericId) && numericId > 0 ? numericId : 0)
  if (!dirId) return 'unsupported'
  const { cookie } = await getQQMusicSession()
  if (!cookie) return 'unsupported'

  const body = await postAuthedMusicu(cookie, {
    req_0: {
      module: 'music.musicasset.PlaylistDetailWrite',
      method: add ? 'AddSonglist' : 'DelSonglist',
      param: {
        dirId,
        dirName: playlist.name,
        tid: Number.isFinite(numericId) ? numericId : 0,
        bFmtUtf8: true,
        source: WRITE_SOURCE,
        v_songInfo: [{ songId, songType: readSongType(musicInfo) }],
      },
    },
  })
  const result = body?.req_0
  const code = Number(result?.code ?? -1)
  if (LOGIN_ERROR_CODES.has(code)) throw new Error(global.i18n.t('qq_session_expired'))
  const retCode = Number(result?.data?.retCode ?? -1)
  if (code !== 0 || retCode !== 0) {
    throw new Error(`${global.i18n.t('qq_playlist_write_failed')} (code=${code} retCode=${retCode})`)
  }
  return 'ok'
}

/**
 * 心形状态。入参是歌曲 id（播放详情页拿到的是 LX.Player.MusicInfo，没有完整歌曲信息）。
 * 只读缓存，不发请求 —— 缓存为空时才去读一次存储。
 */
export const useQQMusicLiked = (id: string | null | undefined) => {
  const [liked, setLiked] = useState(() => isQQMusicTrackLiked(id))

  useEffect(() => {
    setLiked(isQQMusicTrackLiked(id))
    if (likedIds == null) {
      void loadQQMusicLikedSongsCache().then(() => { setLiked(isQQMusicTrackLiked(id)) })
    }
    const update = () => { setLiked(isQQMusicTrackLiked(id)) }
    global.app_event.on('qqMusicLikedUpdated', update)
    return () => { global.app_event.off('qqMusicLikedUpdated', update) }
  }, [id])

  return liked
}
