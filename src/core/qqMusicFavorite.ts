import { useEffect, useState } from 'react'
import { getQQMusicPlaylistSongs, getQQMusicSession, postAuthedMusicu } from './qqMusic'

// 「我喜欢」是 dirid=201 的虚拟歌单
const LIKED_DIRID = '201'
// 服务端要求的写入来源标识
const WRITE_SOURCE = 'normal'
// 这几个返回码表示票据失效
const LOGIN_ERROR_CODES = new Set([1000, 104400, 104401])
// QQ 歌曲的 id 形如 tx_<songmid>
const TX_ID_PREFIX = 'tx_'

export type FavoriteResult = 'ok' | 'unsupported' | 'failed'

// 已收藏歌曲的 id 集合。心形状态从这里来 —— 收藏动作已经改成直接写账号，
// 本地「我的收藏」列表不再是真源。拿不到这个集合时心形先按未收藏显示。
let likedIds: Set<string> | null = null
let refreshPromise: Promise<void> | null = null

export const isQQMusicTrackLiked = (id: string | null | undefined) =>
  id ? likedIds?.has(id) ?? false : false

const doRefresh = async() => {
  try {
    const { cookie } = await getQQMusicSession()
    if (!cookie) {
      likedIds = null
    } else {
      const songs = await getQQMusicPlaylistSongs(cookie, LIKED_DIRID)
      likedIds = new Set(songs.map(song => song.id))
    }
  } catch (error) {
    // 拿不到就保持未知，心形按未收藏显示，不阻断播放
    console.log('[QQMusic] 拉取我喜欢失败:', error)
  }
  global.app_event.qqMusicLikedUpdated()
}

/** 拉一次「我喜欢」全量填充 id 集合。并发调用共用同一次请求。 */
export const refreshQQMusicLikedIds = async(): Promise<void> => {
  refreshPromise ??= doRefresh().finally(() => { refreshPromise = null })
  await refreshPromise
}

const markLiked = (id: string, liked: boolean) => {
  if (!likedIds) likedIds = new Set()
  if (liked) likedIds.add(id)
  else likedIds.delete(id)
  global.app_event.qqMusicLikedUpdated()
}

/** 换号/退出时把集合清掉，否则新号会看到上一个号的收藏状态 */
export const clearQQMusicLikedIds = () => {
  likedIds = null
  global.app_event.qqMusicLikedUpdated()
}

/**
 * 启动时挂一次账号变化的监听。不放在模块顶层：那时 global.app_event
 * 未必已经建好。由 core/init/dataInit 调用。
 */
export const initQQMusicFavorite = () => {
  global.app_event.on('qqMusicAccountUpdated', clearQQMusicLikedIds)
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
        v_songInfo: [{ songId, songType: 0 }],
      },
    },
  })
  const result = body?.req_0
  const code = Number(result?.code ?? -1)
  if (LOGIN_ERROR_CODES.has(code)) throw new Error(global.i18n.t('qq_session_expired'))
  if (code !== 0) return 'failed'
  const retCode = Number(result?.data?.retCode ?? -1)
  if (retCode !== 0) return 'failed'

  markLiked(musicInfo.id, liked)
  return 'ok'
}

/**
 * 心形状态。入参是歌曲 id（播放栏拿到的只有 LX.Player.MusicInfo，没有完整歌曲信息）。
 * 集合还没拉过、且这首歌是 QQ 的就先拉一次。
 */
export const useQQMusicLiked = (id: string | null | undefined) => {
  const [liked, setLiked] = useState(() => isQQMusicTrackLiked(id))

  useEffect(() => {
    setLiked(isQQMusicTrackLiked(id))
    if (likedIds == null && id?.startsWith(TX_ID_PREFIX)) void refreshQQMusicLikedIds()
    const update = () => { setLiked(isQQMusicTrackLiked(id)) }
    global.app_event.on('qqMusicLikedUpdated', update)
    return () => { global.app_event.off('qqMusicLikedUpdated', update) }
  }, [id])

  return liked
}
