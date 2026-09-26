import { deduplicationList, toNewMusicInfo } from '@/utils'
import state, { createSingerRecord, type AlbumItem, type PageInfo, type SingerInfo, type SingerRecord } from './state'

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
  return state.singers[mid] ?? (state.singers[mid] = createSingerRecord(mid, name))
}

/** 翻页时接口偶尔把同一条重复给回来，按 id/mid 去一下重 */
const dedupeBy = <T, K>(getKey: (item: T) => K) => (list: T[]) => {
  return [...new Map(list.map(item => [getKey(item), item])).values()]
}
const dedupeAlbums = dedupeBy<AlbumItem, string>(item => item.mid)
const toMusicList = (list: LX.Music.MusicInfoOnline[]) => {
  return deduplicationList(list.map(music => toNewMusicInfo(music) as LX.Music.MusicInfoOnline))
}

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
  /** 歌手信息与热门歌曲来自同一个接口，一起写入 */
  setInfo(mid: string, info: SingerInfo, songs: LX.Music.MusicInfoOnline[]) {
    const record = getRecord(mid, info.name)
    record.info = { ...info }
    record.infoLoaded = true
    record.songs.list = toMusicList(songs)
    // 热门歌曲接口不支持翻页，一次就是全部
    record.songs.total = record.songs.list.length
    record.songs.page = 1
    record.songs.maxPage = 1
    record.songsLoaded = true

    return record
  },
  setAlbums(mid: string, result: AlbumsResult, page: number) {
    const record = getRecord(mid)
    setPageInfo<AlbumItem, AlbumsResult>(record.albums, result, page, dedupeAlbums)
    record.albumsLoaded = true

    return record.albums
  },
  setAlbumSongs(mid: string, result: SongsResult, page: number) {
    const info = state.albumSongs[mid] ?? (state.albumSongs[mid] = {
      list: [],
      total: 0,
      page: 0,
      maxPage: 1,
      limit: result.limit,
    })
    // 歌曲结果要先转成新结构才能去重（id 是转换后才有的）
    setPageInfo(info, { ...result, list: toMusicList(result.list) }, page, deduplicationList)

    return info
  },
  clearAlbumSongs(mid: string) {
    delete state.albumSongs[mid]
  },
}
