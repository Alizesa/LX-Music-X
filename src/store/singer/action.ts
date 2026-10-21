import { deduplicationList, toNewMusicInfo } from '@/utils'
import state, { createSingerRecord, type AlbumItem, type PageInfo, type SingerInfo, type SingerRecord } from './state'

// 歌手/专辑详情是按 mid 缓存的，没有上限时浏览得越多留得越多。
// 按最近访问淘汰，当前打开页面 retain 住的记录不参与。
const SINGER_CACHE_MAX = 8
const ALBUM_CACHE_MAX = 8
const SONG_CACHE_MAX = 2000
const singerHolds = new Map<string, number>()
const albumHolds = new Map<string, number>()
const singerOrder = new Map<string, true>()
const albumOrder = new Map<string, true>()
let pruneTimer: ReturnType<typeof setTimeout> | null = null

const touchSinger = (mid: string) => {
  singerOrder.delete(mid)
  singerOrder.set(mid, true)
}
const touchAlbum = (mid: string) => {
  albumOrder.delete(mid)
  albumOrder.set(mid, true)
}

const pruneSingerCache = (force = false) => {
  const ids = [...singerOrder.keys()].filter(mid => state.singers[mid] != null)
  if (!ids.length) return
  let count = ids.length
  let totalSongs = ids.reduce((sum, mid) => sum + state.singers[mid].songs.list.length, 0)
  if (!force && count <= SINGER_CACHE_MAX && totalSongs <= SONG_CACHE_MAX) return
  const newest = ids[ids.length - 1]
  for (const mid of ids) {
    if (!force && count <= SINGER_CACHE_MAX && totalSongs <= SONG_CACHE_MAX) break
    if ((!force && mid === newest) || (singerHolds.get(mid) ?? 0) > 0) continue
    totalSongs -= state.singers[mid].songs.list.length
    delete state.singers[mid]
    singerOrder.delete(mid)
    count--
  }
}

const pruneAlbumCache = (force = false) => {
  const ids = [...albumOrder.keys()].filter(mid => state.albumSongs[mid] != null)
  if (!ids.length) return
  let count = ids.length
  let totalSongs = ids.reduce((sum, mid) => sum + state.albumSongs[mid].list.length, 0)
  if (!force && count <= ALBUM_CACHE_MAX && totalSongs <= SONG_CACHE_MAX) return
  const newest = ids[ids.length - 1]
  for (const mid of ids) {
    if (!force && count <= ALBUM_CACHE_MAX && totalSongs <= SONG_CACHE_MAX) break
    if ((!force && mid === newest) || (albumHolds.get(mid) ?? 0) > 0) continue
    totalSongs -= state.albumSongs[mid].list.length
    delete state.albumSongs[mid]
    albumOrder.delete(mid)
    count--
  }
}

// 延迟淘汰：避免页面刚拿到记录、还没渲染完就被别的访问挤掉
const schedulePrune = () => {
  if (pruneTimer) return
  pruneTimer = setTimeout(() => {
    pruneTimer = null
    pruneSingerCache()
    pruneAlbumCache()
  }, 3000)
}

/** 后台/设置页清理：强制淘汰所有没有被页面 hold 的记录 */
export const releaseIdleSingerCaches = () => {
  pruneSingerCache(true)
  pruneAlbumCache(true)
}

export const retainSingerRecord = (mid: string) => {
  singerHolds.set(mid, (singerHolds.get(mid) ?? 0) + 1)
}
export const releaseSingerRecord = (mid: string) => {
  const count = singerHolds.get(mid)
  if (count == null) return
  if (count > 1) singerHolds.set(mid, count - 1)
  else singerHolds.delete(mid)
  schedulePrune()
}
export const retainAlbumRecord = (mid: string) => {
  albumHolds.set(mid, (albumHolds.get(mid) ?? 0) + 1)
}
export const releaseAlbumRecord = (mid: string) => {
  const count = albumHolds.get(mid)
  if (count == null) return
  if (count > 1) albumHolds.set(mid, count - 1)
  else albumHolds.delete(mid)
  schedulePrune()
}

export interface SongsResult {
  list: LX.Music.MusicInfoOnline[]
  total: number
  allPage: number
  limit: number
  source: 'tx'
}

export interface AlbumsResult {
  list: AlbumItem[]
  total: number
  allPage: number
  limit: number
  source: 'tx'
}

const getRecord = (mid: string, name = ''): SingerRecord => {
  const record = state.singers[mid]
  if (record) {
    touchSinger(mid)
    return record
  }
  touchSinger(mid)
  schedulePrune()
  return (state.singers[mid] = createSingerRecord(mid, name))
}

/** 翻页时接口偶尔把同一条重复给回来，按 id/mid 去一下重 */
const dedupeBy = <T, K>(getKey: (item: T) => K) => (list: T[]) => {
  return [...new Map(list.map(item => [getKey(item), item])).values()]
}
const dedupeAlbums = dedupeBy<AlbumItem, string>(item => item.mid)
const toMusicList = (list: LX.Music.MusicInfoOnline[]) => {
  return deduplicationList(list.map(music => toNewMusicInfo(music) as LX.Music.MusicInfoOnline))
}
/** 歌曲结果要先转成新结构，去重才有 id 可用 */
const mapSongs = (result: SongsResult): SongsResult => ({ ...result, list: toMusicList(result.list) })

/**
 * @param result 本页的原始数据
 * @param page 页数，1 表示重新开始
 * @param dedupe 拼接后去重，单页列表不需要
 */
const setPageInfo = <T, R extends { list: T[], total: number, limit: number, allPage: number }>(
  info: PageInfo<T>, result: R, page: number, dedupe?: (list: T[]) => T[],
) => {
  const merged = page == 1 ? [...result.list] : [...info.list, ...result.list]
  info.list = dedupe ? dedupe(merged) : merged
  if (page == 1 || (result.total && result.list.length)) info.total = result.total
  else info.total = result.limit * page
  info.limit = result.limit
  info.page = page
  info.maxPage = result.allPage

  return info
}

export default {
  getRecord(mid: string, name = '') {
    return getRecord(mid, name)
  },
  /** 歌手信息与第一页歌曲来自同一个接口，一起写入 */
  setInfo(mid: string, info: SingerInfo, songs: SongsResult) {
    const record = getRecord(mid, info.name)
    record.info = { ...info }
    record.infoLoaded = true
    setPageInfo<LX.Music.MusicInfoOnline, SongsResult>(record.songs, mapSongs(songs), 1, deduplicationList)
    record.songsLoaded = true

    return record
  },
  setSongs(mid: string, result: SongsResult, page: number) {
    const record = getRecord(mid)
    setPageInfo<LX.Music.MusicInfoOnline, SongsResult>(record.songs, mapSongs(result), page, deduplicationList)
    record.songsLoaded = true

    return record.songs
  },
  setAlbums(mid: string, result: AlbumsResult, page: number) {
    const record = getRecord(mid)
    setPageInfo<AlbumItem, AlbumsResult>(record.albums, result, page, dedupeAlbums)
    record.albumsLoaded = true

    return record.albums
  },
  setAlbumSongs(mid: string, result: SongsResult, page: number) {
    let info = state.albumSongs[mid]
    if (!info) {
      info = state.albumSongs[mid] = {
        list: [],
        total: 0,
        page: 0,
        maxPage: 1,
        limit: result.limit,
      }
      schedulePrune()
    }
    touchAlbum(mid)
    setPageInfo(info, mapSongs(result), page, deduplicationList)

    return info
  },
  clearAlbumSongs(mid: string) {
    delete state.albumSongs[mid]
    albumOrder.delete(mid)
  },
}
