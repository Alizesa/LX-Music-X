import { useEffect, useState } from 'react'
import { filterVisiblePlaylists, getQQMusicPlaylistSongs, getQQMusicPlaylists, getQQMusicSession, getQQMusicTrackIdentity, getQQMusicUin, isReservedQQMusicPlaylistName, postAuthedMusicu } from './qqMusic'
import { getQQMusicLikedSongsCache, getQQMusicLikedSongsStale, getQQMusicPlaylistsCache, removeQQMusicLikedSongsCache, removeQQMusicLikedSongsStale, saveQQMusicLikedSongsCache, saveQQMusicLikedSongsStale, saveQQMusicPlaylistsCache } from '@/utils/data'
import { clearPlaylistSongsCache, dropCachedPlaylistSongs, getPlaylistSongsCacheVersion } from './qqMusicPlaylistSongsCache'
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
 * musicu 写接口的通用结果判定：req_0.code 和 data.retCode 都为 0 才算成功。
 * 收藏那条另有 result / v_failedPlaylistId，单独判；这里给 PlaylistDetailWrite、
 * PlaylistBaseWrite 共用，避免同样的解析散成几份。
 */
const assertMusicuWriteResult = (body: any, fallback: string, context = '') => {
  const result = body?.req_0
  const code = Number(result?.code ?? -1)
  if (LOGIN_ERROR_CODES.has(code)) throw new Error(global.i18n.t('qq_session_expired'))
  const retCode = Number(result?.data?.retCode ?? -1)
  if (code !== 0 || retCode !== 0) {
    const reason = String(result?.data?.reason ?? result?.message ?? body?.message ?? '').trim()
    // 服务端原因和返回码都带上：只有一句 reason 时没法判断是哪一层拒的
    const detail = `code=${code} retCode=${retCode}${context ? ` ${context}` : ''}`
    throw new Error(`${reason || fallback} (${detail})`)
  }
}

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

// 完整数组只在「我喜欢」页打开期间保留：页面挂载 retain、卸载 release。
// id 集合（心形状态）始终保留，释放数组不影响任何心形显示。
const likedHolds = new Map<string, number>()
const RELEASE_DELAY = 3000
let releaseTimer: ReturnType<typeof setTimeout> | null = null
// 数组已释放时，红心的持久缓存更新走串行队列，避免读-改-写互相覆盖。
// 所有对 @qq_music_liked_songs 的写/删都排进这个队列，换号时才能在旧写之后清理
let likedCacheQueue: Promise<void> = Promise.resolve()
// 账号/会话版本：换号、退出时递增。在途的请求/读改写看到版本变化就放弃，
// 防止旧账号的数据在清理之后又写回公共缓存
let likedSessionVersion = 0
const logLikedCacheError = (error: unknown) => {
  console.warn('[QQMusic] 更新我喜欢缓存失败:', error instanceof Error ? error.message : error)
}

const setLikedSongs = (songs: LX.Music.MusicInfoOnline[] | null) => {
  likedSongs = songs
  likedIds = songs ? new Set(songs.map(song => song.id)) : null
  global.app_event.qqMusicLikedUpdated()
}

const setLikedIds = (ids: Set<string>) => {
  likedIds = ids
  global.app_event.qqMusicLikedUpdated()
}

const cancelScheduledRelease = () => {
  if (!releaseTimer) return
  clearTimeout(releaseTimer)
  releaseTimer = null
}

const maybeReleaseLikedSongs = () => {
  cancelScheduledRelease()
  if (likedHolds.size) return
  releaseTimer = setTimeout(() => {
    releaseTimer = null
    // 只丢完整数组，保留 id 集合；期间如果页面重新打开，retain 会取消这个定时器
    if (!likedHolds.size) likedSongs = null
  }, RELEASE_DELAY)
}

export const retainQQMusicLikedSongs = (reason: string) => {
  cancelScheduledRelease()
  likedHolds.set(reason, (likedHolds.get(reason) ?? 0) + 1)
}

export const releaseQQMusicLikedSongs = (reason: string) => {
  const count = likedHolds.get(reason)
  if (count == null) return
  if (count > 1) likedHolds.set(reason, count - 1)
  else likedHolds.delete(reason)
  maybeReleaseLikedSongs()
}

/**
 * 只加载心形状态需要的 id 集合，不把整份歌曲数组留在内存。
 * 「我喜欢」页需要完整数组时走 loadQQMusicLikedSongsCache。
 */
export const ensureQQMusicLikedIds = async(): Promise<void> => {
  if (likedIds) return
  const version = likedSessionVersion
  // 等换号清理/在途写落定再读，否则可能读到刚被清掉的旧账号缓存
  await likedCacheQueue.catch(() => {})
  if (version !== likedSessionVersion || likedIds != null) return
  const cached = await getQQMusicLikedSongsCache()
  // 读盘期间换号/清理过：这次读到的可能是旧账号数据，丢弃
  if (version !== likedSessionVersion) return
  // 读盘期间可能已经被页面/刷新加载好了
  if (likedIds != null) return
  if (cached.length === 0) {
    // 空缓存也记为「已加载」，否则每个红心组件都会重复读一次存储
    likedIds = new Set()
    return
  }
  setLikedIds(new Set(cached.map(song => song.id)))
}

export const isQQMusicTrackLiked = (id: string | null | undefined) =>
  id ? likedIds?.has(id) ?? false : false

/** 已缓存的「我喜欢」歌曲；还没加载过返回 null。 */
export const getQQMusicLikedSongs = () => likedSongs

/** 只读本地缓存（内存 → 存储），不联网。 */
export const loadQQMusicLikedSongsCache = async(): Promise<LX.Music.MusicInfoOnline[]> => {
  if (likedSongs) return likedSongs
  const version = likedSessionVersion
  // 同上：先等清理/在途写完成，避免读到旧账号的缓存
  await likedCacheQueue.catch(() => {})
  if (version !== likedSessionVersion) return []
  const cached = await getQQMusicLikedSongsCache()
  // 读盘期间换号/清理过：不要拿旧账号的数组填进内存
  if (version !== likedSessionVersion) return []
  if (cached.length) setLikedSongs(cached)
  return cached
}

const doFetch = async() => {
  const version = likedSessionVersion
  try {
    const { cookie } = await getQQMusicSession()
    if (version !== likedSessionVersion) return
    if (!cookie) {
      cancelScheduledRelease()
      setLikedSongs(null)
      likedCacheQueue = likedCacheQueue.catch(() => {}).then(async() => {
        if (version !== likedSessionVersion) return
        await removeQQMusicLikedSongsCache()
        await removeQQMusicLikedSongsStale()
      })
      await likedCacheQueue
      return
    }
    const songs = await getQQMusicPlaylistSongs(cookie, LIKED_DIRID)
    // 拉取期间换号了：这份是旧账号的数据，丢弃
    if (version !== likedSessionVersion) return
    setLikedSongs(songs)
    likedCacheQueue = likedCacheQueue.catch(() => {}).then(async() => {
      if (version !== likedSessionVersion) return
      await saveQQMusicLikedSongsCache(songs)
      if (version !== likedSessionVersion) return
      // 这份就是服务端的，之前标脏的可以清了
      await saveQQMusicLikedSongsStale(false)
    })
    await likedCacheQueue
    // 没有页面占用时（例如「我的」页下拉刷新触发的），整个数组不需要常驻
    maybeReleaseLikedSongs()
  } catch (error) {
    // 失败保留上一次的缓存（标脏那笔也留着，下次进来还会再试），
    // 不要因为一次网络抖动把心形状态全清空
    console.log('[QQMusic] 拉取我喜欢失败:', error)
  }
}

/** 联网拉一次「我喜欢」并落盘。并发调用共用同一次请求。 */
export const refreshQQMusicLikedSongs = async(): Promise<void> => {
  if (!fetchPromise) {
    // finally 里按身份清理：换号时 clear 会把 fetchPromise 置空并允许新请求，
    // 旧请求结束时不能把新请求的 promise 清掉
    let tracked: Promise<void>
    tracked = doFetch().finally(() => {
      if (fetchPromise === tracked) fetchPromise = null
    })
    fetchPromise = tracked
  }
  await fetchPromise
}

/**
 * 收藏/取消后同步更新本地缓存，省掉一次全量重拉。
 *
 * 本地这份是「写入成功、没读回验证」的结果：心形状态和列表就近用它（不然每点一次红心
 * 就要把几百首的「我喜欢」全拉一遍），但会标脏 —— 下次打开「我喜欢」时重拉一次拿服务端
 * 那份替换掉，跟歌单那边「内容变了就丢缓存、下次打开自动刷新」是一个效果。
 */
const applyLiked = (songs: LX.Music.MusicInfoOnline[], musicInfo: LX.Music.MusicInfo, liked: boolean) => liked
  ? (songs.some(song => song.id == musicInfo.id) ? songs : [musicInfo as LX.Music.MusicInfoOnline, ...songs])
  : songs.filter(song => song.id != musicInfo.id)

const markLiked = async(musicInfo: LX.Music.MusicInfo, liked: boolean, version: number) => {
  // 发起写入时的账号已经切走了：这次结果属于旧账号，不要碰新账号的缓存
  if (version !== likedSessionVersion) return

  // 页面开着：整份数组在内存里，直接本地增删
  if (likedSongs) {
    const next = applyLiked(likedSongs, musicInfo, liked)
    setLikedSongs(next)
    // 写操作也进队列：换号清理排在它后面，不会被旧账号的写回写
    likedCacheQueue = likedCacheQueue.catch(() => {}).then(async() => {
      if (version !== likedSessionVersion) return
      await saveQQMusicLikedSongsCache(next)
      if (version !== likedSessionVersion) return
      await saveQQMusicLikedSongsStale(true)
    })
    void likedCacheQueue.catch(logLikedCacheError)
    return
  }

  // 数组已释放：只维护 id 集合和持久缓存，不把整份数组装回内存。
  // 否则从 [] 开始增删会把持久缓存覆盖成一首/空数组。
  try {
    await ensureQQMusicLikedIds()
    if (version !== likedSessionVersion) return
    const ids = new Set(likedIds ?? [])
    if (liked) ids.add(musicInfo.id)
    else ids.delete(musicInfo.id)
    setLikedIds(ids)
    // 串行读改写，避免快速连点/换号时互相覆盖
    likedCacheQueue = likedCacheQueue.catch(() => {}).then(async() => {
      if (version !== likedSessionVersion) return
      // 先标脏：即使下面的读改写失败，下次打开「我喜欢」也会从服务端重拉
      await saveQQMusicLikedSongsStale(true)
      if (version !== likedSessionVersion) return
      const songs = await getQQMusicLikedSongsCache()
      if (version !== likedSessionVersion) return
      await saveQQMusicLikedSongsCache(applyLiked(songs, musicInfo, liked))
    })
    await likedCacheQueue
  } catch (error) {
    logLikedCacheError(error)
  }
}

/** 「我喜欢」那份缓存是不是被本地改过、还没核对过。true 时下次打开那个歌单先重拉 */
export const isQQMusicLikedSongsStale = async() => await getQQMusicLikedSongsStale()

/** 换号/退出时清掉，否则新号会看到上一个号的收藏状态 */
export const clearQQMusicLikedSongs = () => {
  likedSessionVersion++
  const version = likedSessionVersion
  cancelScheduledRelease()
  // 允许新账号重新发起请求；旧请求结束时按身份清理，不会误清新请求
  fetchPromise = null
  setLikedSongs(null)
  // 排到在途写之后：等旧账号排队的读写跑完再删，避免旧数据在清理后回写
  likedCacheQueue = likedCacheQueue.catch(() => {}).then(async() => {
    // 期间又切了一次账号：让最新一次清理负责
    if (version !== likedSessionVersion) return
    await removeQQMusicLikedSongsCache()
    await removeQQMusicLikedSongsStale()
  })
  void likedCacheQueue.catch(logLikedCacheError)
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
  // 在发请求前记下账号版本：请求期间换号的话，回来只更新服务端，不再写本地缓存
  const version = likedSessionVersion
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
  await markLiked(musicInfo, liked, version)
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
  // 把 dirId 也带出来：写不进去时最容易怀疑的就是它，不带就只能再猜一轮
  assertMusicuWriteResult(body, global.i18n.t('qq_playlist_write_failed'), `dirId=${dirId}`)

  // **读回验证**：这个接口会「返回成功但什么都没改」（服务端把「条目不存在」当成幂等成功），
  // 光看返回码会把 no-op 当成成功报给用户。参考实现也是写完读回来验一遍的。
  await assertPlaylistMember(cookie, target.id, target.dirId, songId, add)
  return 'ok'
}

/**
 * 歌单级的增删改。协议照 MusicOne 的 PlaylistBaseWrite：
 * AddPlaylist / EditPlaylist / DelPlaylist，参数带 bFmtUtf8。
 * 只允许操作当前账号自建的歌单；写入前重新拉一次完整列表拿最新的 dirId 并校验归属。
 */
const resolveOwnedQQMusicPlaylist = async(
  cookie: string,
  playlist: Pick<LX.QQMusic.PlaylistInfo, 'id'>,
) => {
  // requireAll：写前校验不能用「只拉到收藏列表」的残缺结果判断归属
  const fresh = await getQQMusicPlaylists(cookie, { requireAll: true })
  const target = fresh.find(item => !item.subscribed && !item.liked && item.id == playlist.id)
  if (!target) throw new Error(global.i18n.t('qq_playlist_not_owned'))
  if (!target.dirId) throw new Error(global.i18n.t('qq_playlist_missing_dir'))
  return { target, fresh }
}

const isSameQQMusicSession = async(cookie: string) => {
  const expected = getQQMusicUin(cookie)
  if (!expected) return false
  const { cookie: current } = await getQQMusicSession()
  return !!current && getQQMusicUin(current) === expected
}

const validateQQMusicPlaylistName = (name: string) => {
  const title = name.trim()
  if (!title) throw new Error(global.i18n.t('qq_playlist_name_required'))
  // 这些名字会被 getQQMusicPlaylists 的归一化过滤掉，写进去也会立刻“消失”
  if (isReservedQQMusicPlaylistName(title)) throw new Error(global.i18n.t('qq_playlist_name_reserved'))
  return title
}

/**
 * 写成功后就地更新「我的歌单」缓存并广播，别让 UI 再整份重拉。
 * 期间换号/退出就放弃：旧账号的列表不能写回公共缓存。
 */
const saveQQMusicPlaylistsAfterEdit = async(cookie: string, next: LX.QQMusic.PlaylistInfo[]) => {
  try {
    if (!await isSameQQMusicSession(cookie)) return
    await saveQQMusicPlaylistsCache(next)
    global.app_event.qqMusicPlaylistsUpdated()
  } catch (error) {
    // 写操作已经成功：缓存更新失败只影响界面刷新时机，不能反过来报操作失败
    console.warn('[QQMusic] 更新歌单缓存失败:', error instanceof Error ? error.message : error)
  }
}

const writeQQMusicPlaylistBase = async(
  cookie: string,
  method: 'AddPlaylist' | 'EditPlaylist' | 'DelPlaylist',
  param: Record<string, unknown>,
) => {
  const body = await postAuthedMusicu(cookie, {
    req_0: {
      module: 'music.musicasset.PlaylistBaseWrite',
      method,
      param: { bFmtUtf8: true, ...param },
    },
  }, { 'User-Agent': QQ_PLAYLIST_WRITE_USER_AGENT })
  assertMusicuWriteResult(body, global.i18n.t('qq_playlist_edit_failed'))
}

/** 新建歌单。写入成功后重拉一次完整列表（新建没有可靠的本地 id，无法就地插入） */
export const createQQMusicPlaylist = async(name: string) => {
  const title = validateQQMusicPlaylistName(name)
  const { cookie } = await getQQMusicSession()
  if (!cookie) throw new Error(global.i18n.t('qq_not_logged_in'))
  await writeQQMusicPlaylistBase(cookie, 'AddPlaylist', { dirName: title, dirShow: 1 })
  try {
    const fresh = await getQQMusicPlaylists(cookie, { requireAll: true })
    await saveQQMusicPlaylistsAfterEdit(cookie, fresh)
  } catch (error) {
    // 歌单已经建好了：刷新失败只影响列表什么时候显示，不能让调用方误报失败
    console.warn('[QQMusic] 新建歌单后刷新列表失败:', error instanceof Error ? error.message : error)
  }
}

/** 重命名自建歌单 */
export const renameQQMusicPlaylist = async(
  playlist: Pick<LX.QQMusic.PlaylistInfo, 'id' | 'name'>,
  name: string,
) => {
  const title = validateQQMusicPlaylistName(name)
  const { cookie } = await getQQMusicSession()
  if (!cookie) throw new Error(global.i18n.t('qq_not_logged_in'))
  const { target, fresh } = await resolveOwnedQQMusicPlaylist(cookie, playlist)
  await writeQQMusicPlaylistBase(cookie, 'EditPlaylist', {
    dirId: target.dirId,
    mask: 1,
    dirNewName: title,
  })
  const next = fresh.map(item => item.id == playlist.id ? { ...item, name: title } : item)
  await saveQQMusicPlaylistsAfterEdit(cookie, next)
}

/** 删除自建歌单。删除后顺手丢掉该歌单的歌曲缓存 */
export const deleteQQMusicPlaylist = async(
  playlist: Pick<LX.QQMusic.PlaylistInfo, 'id' | 'name'>,
) => {
  const { cookie } = await getQQMusicSession()
  if (!cookie) throw new Error(global.i18n.t('qq_not_logged_in'))
  const { target, fresh } = await resolveOwnedQQMusicPlaylist(cookie, playlist)
  await writeQQMusicPlaylistBase(cookie, 'DelPlaylist', {
    dirId: target.dirId,
    dirName: target.name,
  })
  const next = fresh.filter(item => item.id != playlist.id)
  await saveQQMusicPlaylistsAfterEdit(cookie, next)
  // 缓存清理失败不影响删除结果；dropCachedPlaylistSongs 内部已经兜底
  void dropCachedPlaylistSongs(playlist.id)
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
    const fresh = await getQQMusicPlaylists(cookie, { requireAll: true })
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
    // 写接口期间可能换号；带回发起时的版本，切号后不做旧账号的缓存操作
    const cacheVersion = getPlaylistSongsCacheVersion()
    const result = await setQQMusicTrackInPlaylist(musicInfo, playlist, add)
    if (result == 'ok') {
      toast(global.i18n.t(add ? 'qq_playlist_added' : 'qq_playlist_removed', { name: playlist.name }))
      // 歌单内容变了，缓存作废，下次进歌单页会重新取
      void dropCachedPlaylistSongs(playlist.id, cacheVersion)
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
  playlist: Pick<LX.QQMusic.PlaylistInfo, 'id' | 'name'> & Partial<Pick<LX.QQMusic.PlaylistInfo, 'cover' | 'trackCount'>>,
  collected: boolean,
): Promise<boolean> => {
  // 没有数字 id 的歌单压根没发收藏（本地就能判出来），别跟「没登录」共用一条提示
  if (!Number.isFinite(Number(playlist.id)) || Number(playlist.id) <= 0) {
    toast(global.i18n.t('qq_playlist_collect_unsupported'), 'long')
    return false
  }
  try {
    const result = await setQQMusicPlaylistCollected(playlist, collected)
    if (result == 'ok') {
      toast(global.i18n.t(collected ? 'qq_playlist_faved' : 'qq_playlist_unfaved', { name: playlist.name }))
      // 就地更新「我的歌单」缓存：收藏的加进去、取消的拿掉。
      // 不能整份作废 —— 空缓存会被别处当成「这个号真的没有歌单」：添加歌单的选择器会显示
      // 「还没有自建歌单」，推荐流里查收藏状态也查不到，我的页还得等下次重新进才恢复
      const cached = await getQQMusicPlaylistsCache()
      const next = cached.filter(item => item.id != playlist.id)
      if (collected) {
        next.push({
          id: playlist.id,
          name: playlist.name,
          cover: playlist.cover,
          trackCount: playlist.trackCount,
          subscribed: true,
          liked: false,
        })
      }
      await saveQQMusicPlaylistsCache(next)
      // 通知常驻页面（「我的」页）重读一遍，不用等重新进页面
      global.app_event.qqMusicPlaylistsUpdated()
      return true
    }
    // 走到 unsupported 就是没登录（数字 id 上面已经挡过了）
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
      // 心形只需要 id 集合，不要为了它把整份「我喜欢」数组装进内存
      void ensureQQMusicLikedIds().then(() => { setLiked(isQQMusicTrackLiked(id)) }).catch(() => {})
    }
    const update = () => { setLiked(isQQMusicTrackLiked(id)) }
    global.app_event.on('qqMusicLikedUpdated', update)
    return () => { global.app_event.off('qqMusicLikedUpdated', update) }
  }, [id])

  return liked
}
