import singerState, { type SingerRecord, type PageInfo } from '@/store/singer/state'
import singerActions, { type AlbumsResult, type SongsResult } from '@/store/singer/action'
import musicSdk from '@/utils/musicSdk'
import { getDetailCache, saveDetailCache } from './detailCache'

const cacheSinger = (mid: string, record: SingerRecord) => {
  saveDetailCache(`singer_${mid}`, {
    ...record, info: { ...record.info }, songs: { ...record.songs }, albums: { ...record.albums },
  })
}
const restoreSinger = async(mid: string, record: SingerRecord) => {
  if (record.infoLoaded || record.songsLoaded || record.albumsLoaded) return
  const saved = await getDetailCache<SingerRecord>(`singer_${mid}`)
  if (singerState.singers[mid] !== record || record.infoLoaded || record.songsLoaded || record.albumsLoaded) return
  if (saved?.info?.mid === mid && Array.isArray(saved.songs?.list) && Array.isArray(saved.albums?.list)) Object.assign(record, saved)
}

interface SingerDetailResult {
  info: Parameters<typeof singerActions.setInfo>[1]
  songs: SongsResult
}

/**
 * 歌手信息 + 简介 + 第一页歌曲。三块数据在同一个接口里，所以只用一条请求，
 * 拿到后一起写进 store，第二次进同一个歌手页直接读缓存。
 */
export const getSingerDetail = async(mid: string, isRefresh = false) => {
  const record = singerActions.getRecord(mid)
  if (!isRefresh) await restoreSinger(mid, record)
  if (singerState.singers[mid] !== record) return record
  if (record.infoLoaded && !isRefresh) return record
  const detail = await musicSdk.tx.singer.getDetail(mid) as SingerDetailResult
  // 请求回来时页面可能已经切走了（记录被重新建过），这时别写回旧对象
  if (singerState.singers[mid] !== record) return record
  const result = singerActions.setInfo(mid, detail.info, detail.songs)
  cacheSinger(mid, result)
  return result
}

/**
 * 歌手歌曲的后续页。第一页和歌手信息在同一个接口里，走 getSingerDetail 一起拿，
 * 免得进页面就发两条请求。
 */
export const getSingerSongs = async(mid: string, page: number, isRefresh = false) => {
  if (page <= 1) return (await getSingerDetail(mid, isRefresh)).songs
  const record = singerActions.getRecord(mid)
  const result = await musicSdk.tx.singer.getSongs(mid, page, record.songs.limit) as SongsResult
  if (singerState.singers[mid] !== record) return record.songs
  const songs = singerActions.setSongs(mid, result, page)
  cacheSinger(mid, record)
  return songs
}

export const getSingerAlbums = async(mid: string, page: number, isRefresh = false) => {
  const record = singerActions.getRecord(mid)
  if (!isRefresh) await restoreSinger(mid, record)
  if (singerState.singers[mid] !== record) return record.albums
  if (page == 1 && record.albumsLoaded && !isRefresh) return record.albums
  const result = await musicSdk.tx.singer.getAlbums(mid, page, record.albums.limit) as AlbumsResult
  if (singerState.singers[mid] !== record) return record.albums
  const albums = singerActions.setAlbums(mid, result, page)
  cacheSinger(mid, record)
  return albums
}

export const getAlbumSongs = async(mid: string, page: number, isRefresh = false) => {
  const record = singerActions.getAlbumRecord(mid)
  if (!isRefresh && record.page === 0) {
    const saved = await getDetailCache<PageInfo<LX.Music.MusicInfoOnline>>(`album_${mid}`)
    if (singerState.albumSongs[mid] !== record) return record
    if (record.page === 0 && saved && Array.isArray(saved.list) && saved.page > 0) Object.assign(record, saved)
  }
  if (page === 1 && record.page > 0 && !isRefresh) return record
  const result = await musicSdk.tx.album.getSongs(mid, page, record.limit) as SongsResult
  if (singerState.albumSongs[mid] !== record) return record
  const songs = singerActions.setAlbumSongs(mid, result, page)
  saveDetailCache(`album_${mid}`, { ...songs })
  return songs
}
