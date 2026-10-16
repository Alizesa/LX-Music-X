import { useEffect, useState } from 'react'
import { filterVisiblePlaylists, getQQMusicPlaylistSongs, getQQMusicPlaylists, getQQMusicSession, getQQMusicTrackIdentity, postAuthedMusicu } from './qqMusic'
import { getQQMusicLikedSongsCache, getQQMusicLikedSongsStale, getQQMusicPlaylistsCache, removeQQMusicLikedSongsCache, removeQQMusicLikedSongsStale, removeQQMusicPlaylistsCache, saveQQMusicLikedSongsCache, saveQQMusicLikedSongsStale, saveQQMusicPlaylistsCache } from '@/utils/data'
import { clearPlaylistSongsCache, dropCachedPlaylistSongs } from './qqMusicPlaylistSongsCache'
import { toast } from '@/utils/tools'

// 「我喜欢」是 dirid=201 的虚拟歌单
const LIKED_DIRID = '201'
// 服务端要求的写入来源标识
const WRITE_SOURCE = 'normal'
// 与 MusicOne 已验证可用的歌单写接口保持同一 App UA。
const QQ_PLAYLIST_WRITE_USER_AGENT = 'QQMusic 2005000982(android 14)'
// 这几个返回码表示票据失效
const LOGIN_ERROR_CODES = new Set([1000, 104400, 104401])

/**
 * 两个写接口的返回值：'ok' 成功；'unsupported' 表示这次不该走账号（非 QQ 歌、未登录、
 * 或拿不到目标），调用方据此退回本地列表。**失败是抛错出来的**（带服务端返回码），
 * 不在这里用返回值表达 —— 否则调用方很容易把 no-op 当成成功。
 */
export type FavoriteResult = 'ok' | 'unsupported'

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
      await removeQQMusicLikedSongsStale()
      return
    }
    const songs = await getQQMusicPlaylistSongs(cookie, LIKED_DIRID)
    setLikedSongs(songs)
    await saveQQMusicLikedSongsCache(songs)
    // 这份就是服务端的，之前标脏的可以清了
    await saveQQMusicLikedSongsStale(false)
  } catch (error) {
    // 失败保留上一次的缓存（标脏那笔也留着，下次进来还会再试），
    // 不要因为一次网络抖动把心形状态全清空
    console.log('[QQMusic] 拉取我喜欢失败:', error)
  }
}

/** 联网拉一次「我喜欢」并落盘。并发调用共用同一次请求。 */
export const refreshQQMusicLikedSongs = async(): Promise<void> => {
  fetchPromise ??= doFetch().finally(() => { fetchPromise = null })
  await fetchPromise
}

/**
 * 收藏/取消后同步更新本地缓存，省掉一次全量重拉。
 *
 * 本地这份是「写入成功、没读回验证」的结果：心形状态和列表就近用它（不然每点一次红心
 * 就要把几百首的「我喜欢」全拉一遍），但会标脏 —— 下次打开「我喜欢」时重拉一次拿服务端
 * 那份替换掉，跟歌单那边「内容变了就丢缓存、下次打开自动刷新」是一个效果。
 */
const markLiked = (musicInfo: LX.Music.MusicInfo, liked: boolean) => {
  const songs = likedSongs ?? []
  const next = liked
    ? (songs.some(song => song.id == musicInfo.id) ? songs : [musicInfo as LX.Music.MusicInfoOnline, ...songs])
    : songs.filter(song => song.id != musicInfo.id)
  setLikedSongs(next)
  void saveQQMusicLikedSongsCache(next)
  void saveQQMusicLikedSongsStale(true)
}

/** 「我喜欢」那份缓存是不是被本地改过、还没核对过。true 时下次打开那个歌单先重拉 */
export const isQQMusicLikedSongsStale = async() => await getQQMusicLikedSongsStale()

/** 换号/退出时清掉，否则新号会看到上一个号的收藏状态 */
export const clearQQMusicLikedSongs = () => {
  setLikedSongs(null)
  void removeQQMusicLikedSongsCache()
  void removeQQMusicLikedSongsStale()
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
  const { cookie } = await getQQMusicSession()
  if (!cookie) return 'unsupported'

  // 和写歌单走同一套身份：先补一次详情拿服务端眼中的规范 songId / songType。
  // 取消收藏（DelSonglist）和从歌单删歌是同一个接口、同一个匹配规则 —— 身份对不上
  // 就会被当成「删一个不存在的条目」，返回成功但什么都不做（实测：能收藏、取消删不掉）。
  const fallbackSongId = Number(musicInfo.meta.id ?? 0)
  const fallbackSongType = readSongType(musicInfo)
  const songMid = String(musicInfo.meta.songId ?? '')
  const detail = songMid
    ? await getQQMusicTrackIdentity(cookie, songMid, fallbackSongType, fallbackSongId).catch(error => {
      console.warn('[QQMusic] 取歌曲详情失败，用列表里的身份:', error instanceof Error ? error.message : error)
      return null
    })
    : null
  const songId = detail?.songId ?? fallbackSongId
  const songType = detail?.songType ?? fallbackSongType
  if (!songId) return 'unsupported'

  const body = await postAuthedMusicu(cookie, {
    req_0: {
      module: 'music.musicasset.PlaylistDetailWrite',
      method: liked ? 'AddSonglist' : 'DelSonglist',
      param: {
        dirId: Number(LIKED_DIRID),
        tid: 0,
        bFmtUtf8: true,
        source: WRITE_SOURCE,
        v_songInfo: [{ songId, songType }],
      },
    },
  })
  const result = body?.req_0
  const code = Number(result?.code ?? -1)
  if (LOGIN_ERROR_CODES.has(code)) throw new Error(global.i18n.t('qq_session_expired'))
  const retCode = Number(result?.data?.retCode ?? -1)
  if (code !== 0 || retCode !== 0) {
    throw new Error(`${global.i18n.t('qq_like_failed')} (code=${code} retCode=${retCode})`)
  }

  // 不做读回验证：那要把整个「我喜欢」拉回来核对（几百首、好几个请求），代价太大。
  // 这个分支有意压低对音源的请求量，写入失败时用户自己就能看出来。
  markLiked(musicInfo, liked)
  return 'ok'
}

/**
 * 把一首歌加进 / 移出某个**自己创建的** QQ 歌单。
 *
 * 参数形状**刻意和红心那条完全一致，只换 dirId**：红心（dirId 固定 201）实测是能写进去的，
 * 所以「同一个接口 + 已验证的形状 + 目标歌单的目录编号」是最稳的组合。
 * 早先这条多发了 `dirName`、还把歌单 id 当 `tid` 传（参考实现里 tid 默认 0），
 * 都可能让服务端认定目标歌单不存在 —— 报的就是 80092。
 *
 * dirId 优先用歌单自带的（来自 PlaylistBaseRead，那份响应里才带 dirid），
 * 没有才退回用歌单 id 顶。
 */
export const setQQMusicTrackInPlaylist = async(
  musicInfo: LX.Music.MusicInfo,
  playlist: Pick<LX.QQMusic.PlaylistInfo, 'id' | 'name' | 'dirId'>,
  add: boolean,
): Promise<FavoriteResult> => {
  if (musicInfo.source != 'tx') return 'unsupported'
  const { cookie } = await getQQMusicSession()
  if (!cookie) return 'unsupported'

  // 歌单列表在播放页来自持久缓存。写入前必须重新取当前账号的目标，
  // 否则旧的 dirId 会让接口把删除当成「不存在的条目」并返回成功。
  const freshPlaylists = await getQQMusicPlaylists(cookie)
  const target = freshPlaylists.find(item =>
    !item.subscribed && !item.liked &&
    (item.id == playlist.id || (playlist.dirId != null && item.dirId == playlist.dirId)),
  )
  if (!target) return 'unsupported'

  const numericId = Number(target.id)
  const dirId = target.dirId ?? (Number.isFinite(numericId) && numericId > 0 ? numericId : 0)
  if (!dirId) return 'unsupported'

  // 写入前补一次歌曲详情，拿服务端眼中的「规范身份」：**删除要求身份和当初添加进去的
  // 完全一致**，对不上就会被当成「删一个不存在的条目」——返回成功但什么都不做
  // （实测就是这个现象）。详情取不到就退回列表里那套值。
  const fallbackSongId = Number(musicInfo.meta.id ?? 0)
  const fallbackSongType = readSongType(musicInfo)
  const songMid = String(musicInfo.meta.songId ?? '')
  const detail = songMid
    ? await getQQMusicTrackIdentity(cookie, songMid, fallbackSongType, fallbackSongId).catch(error => {
      console.warn('[QQMusic] 取歌曲详情失败，用列表里的身份:', error instanceof Error ? error.message : error)
      return null
    })
    : null
  // 详情里缺字段时它自己已经退回传入的兜底值了，所以这里用 ?? 就够
  const songId = detail?.songId ?? fallbackSongId
  const songType = detail?.songType ?? fallbackSongType
  if (!songId) return 'unsupported'

  const body = await postAuthedMusicu(cookie, {
    req_0: {
      module: 'music.musicasset.PlaylistDetailWrite',
      method: add ? 'AddSonglist' : 'DelSonglist',
      param: {
        dirId,
        // tid 和 dirName 都按 MusicOne 的原样带上。早先我把这两项去掉过，理由是
        // 「参数形状对齐红心那条」—— 但那个判断是建立在 dirId 的错误诊断上的
        // （当时真正的毛病是旧缓存）。添加不需要它们，删除可能需要靠 tid 定位条目。
        dirName: target.name,
        tid: Number.isFinite(numericId) ? numericId : 0,
        bFmtUtf8: true,
        source: WRITE_SOURCE,
        v_songInfo: [{ songId, songType }],
      },
    },
  }, { 'User-Agent': QQ_PLAYLIST_WRITE_USER_AGENT })
  const result = body?.req_0
  const code = Number(result?.code ?? -1)
  if (LOGIN_ERROR_CODES.has(code)) throw new Error(global.i18n.t('qq_session_expired'))
  const retCode = Number(result?.data?.retCode ?? -1)
  if (code !== 0 || retCode !== 0) {
    // 把 dirId 也带出来：写不进去时最容易怀疑的就是它，不带就只能再猜一轮
    throw new Error(`${global.i18n.t('qq_playlist_write_failed')} (code=${code} retCode=${retCode} dirId=${dirId})`)
  }

  // **读回验证**：这个接口会「返回成功但什么都没改」（服务端把「条目不存在」当成幂等成功），
  // 光看返回码会把 no-op 当成成功报给用户。参考实现也是写完读回来验一遍的。
  await assertPlaylistMember(cookie, target.id, target.dirId, songId, add)
  return 'ok'
}

/** 能往里写歌的那批：自己创建的歌单。收藏来的写不了 */
const writablePlaylists = (list: LX.QQMusic.PlaylistInfo[]) =>
  filterVisiblePlaylists(list).filter(item => !item.subscribed && !item.liked)

/**
 * 「添加到歌单」的候选列表。
 *
 * 缓存可能是**旧版本**写进去的（那时歌单对象上还没有 dirId 字段，而页面只有手动下拉
 * 才会重拉），拿不到目录编号就没法写歌单。发现缺编号就自己重拉一次并落盘，
 * 不指望用户记得去下拉刷新。
 */
export const loadWritableQQMusicPlaylists = async(): Promise<LX.QQMusic.PlaylistInfo[]> => {
  const cached = writablePlaylists(await getQQMusicPlaylistsCache())
  if (!cached.some(item => !item.dirId)) return cached
  const { cookie } = await getQQMusicSession()
  if (!cookie) return cached
  try {
    const fresh = await getQQMusicPlaylists(cookie)
    await saveQQMusicPlaylistsCache(fresh)
    return writablePlaylists(fresh)
  } catch (error) {
    console.warn('[QQMusic] 刷新歌单失败:', error instanceof Error ? error.message : error)
    return cached
  }
}

/**
 * 加进/移出歌单，连提示和缓存作废一起做掉 —— 菜单只管调它、按返回值决定要不要收尾。
 * 返回是否成功；失败时提示语已经发出去了，调用方不用再拼一遍。
 */
export const changeQQMusicPlaylistMembership = async(
  musicInfo: LX.Music.MusicInfo,
  playlist: Pick<LX.QQMusic.PlaylistInfo, 'id' | 'name' | 'dirId'>,
  add: boolean,
): Promise<boolean> => {
  try {
    const result = await setQQMusicTrackInPlaylist(musicInfo, playlist, add)
    if (result == 'ok') {
      toast(global.i18n.t(add ? 'qq_playlist_added' : 'qq_playlist_removed', { name: playlist.name }))
      // 歌单内容变了，缓存作废，下次进歌单页会重新取
      void dropCachedPlaylistSongs(playlist.id)
      return true
    }
    // 写失败是抛错出来的（带服务端返回码），走下面的 catch
    toast(global.i18n.t('qq_playlist_write_unsupported'), 'long')
  } catch (error: unknown) {
    toast(error instanceof Error ? error.message : global.i18n.t('qq_playlist_write_failed'), 'long')
  }
  return false
}

/**
 * 收藏 / 取消收藏一个歌单（把别人的歌单存进自己的「收藏歌单」）。
 *
 * 参数形状照参考实现那条：模块 music.musicasset.PlaylistFavWrite，方法 FavPlaylist /
 * CancelFavPlaylist，param 只带 v_playlistId（数字 id 的数组）；UA 用写接口那套
 * （和参考实现这条用的完全一致）。Referer / Origin 由 request 统一带上，不用在这里写。
 *
 * 这条的返回比别处细：顶层 code、req_0.code、data.result 都为 0 才算成功，
 * 而且 data.v_failedPlaylistId 会列出没处理成功的 id —— 只判 code 会把部分失败当成功。
 */
export const setQQMusicPlaylistCollected = async(
  playlist: Pick<LX.QQMusic.PlaylistInfo, 'id' | 'name'>,
  collected: boolean,
): Promise<FavoriteResult> => {
  const { cookie } = await getQQMusicSession()
  if (!cookie) return 'unsupported'
  // 这条接口只认数字 id（disstid/tid 那一类），拿不到就没法收藏
  const playlistId = Number(playlist.id)
  if (!Number.isFinite(playlistId) || playlistId <= 0) return 'unsupported'

  const body = await postAuthedMusicu(cookie, {
    req_0: {
      module: 'music.musicasset.PlaylistFavWrite',
      method: collected ? 'FavPlaylist' : 'CancelFavPlaylist',
      param: { v_playlistId: [playlistId] },
    },
  }, { 'User-Agent': QQ_PLAYLIST_WRITE_USER_AGENT })

  const request = body?.req_0
  const code = Number(body?.code ?? -1)
  const requestCode = Number(request?.code ?? -1)
  if (LOGIN_ERROR_CODES.has(code) || LOGIN_ERROR_CODES.has(requestCode)) {
    throw new Error(global.i18n.t('qq_session_expired'))
  }
  const result = Number(request?.data?.result ?? -1)
  const failedIds: unknown[] = Array.isArray(request?.data?.v_failedPlaylistId) ? request.data.v_failedPlaylistId : []
  if (code !== 0 || requestCode !== 0 || result !== 0 || failedIds.some(id => Number(id) === playlistId)) {
    // 服务端有时会带一句原因，带上它比只报几个码好查
    const reason = String(request?.data?.reason ?? request?.message ?? body?.message ?? '').trim()
    throw new Error(reason || `${global.i18n.t('qq_playlist_write_failed')} (code=${code} reqCode=${requestCode} result=${result})`)
  }
  return 'ok'
}

/**
 * 收藏/取消收藏歌单，连提示和缓存作废一起做掉 —— 歌单页头图那个角标只管调它。
 * 返回是否成功；失败时提示已经发出去了。
 */
export const toggleQQMusicPlaylistCollected = async(
  playlist: Pick<LX.QQMusic.PlaylistInfo, 'id' | 'name'>,
  collected: boolean,
): Promise<boolean> => {
  try {
    const result = await setQQMusicPlaylistCollected(playlist, collected)
    if (result == 'ok') {
      toast(global.i18n.t(collected ? 'qq_playlist_faved' : 'qq_playlist_unfaved', { name: playlist.name }))
      // 「我的」页那两个歌单分区读的是这份缓存，作废掉，下次进页面会重新取
      await removeQQMusicPlaylistsCache()
      return true
    }
    // unsupported：没登录，或这个歌单没有数字 id
    toast(global.i18n.t('qq_not_logged_in'), 'long')
  } catch (error: unknown) {
    toast(error instanceof Error ? error.message : global.i18n.t('qq_playlist_write_failed'), 'long')
  }
  return false
}

/** 写完读回歌单，确认这首歌的状态真的变了。对不上就抛错，不能谎报成功。 */
const assertPlaylistMember = async(
  cookie: string,
  playlistId: string,
  dirId: number | undefined,
  songId: number,
  shouldExist: boolean,
) => {
  let songs: LX.Music.MusicInfoOnline[]
  try {
    songs = await getQQMusicPlaylistSongs(cookie, playlistId, dirId)
  } catch (error) {
    // 读不回来时不轻易判失败：写本身可能已经成功了，只是这次读出错
    console.warn('[QQMusic] 写歌单后读回失败:', error instanceof Error ? error.message : error)
    return
  }
  const exists = songs.some(song => song.source == 'tx' && Number(song.meta.id) === songId)
  if (exists !== shouldExist) throw new Error(global.i18n.t('qq_playlist_write_no_effect'))
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
