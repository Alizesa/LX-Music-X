import singerState from '@/store/singer/state'
import singerActions, { type AlbumsResult, type SongsResult } from '@/store/singer/action'
import musicSdk from '@/utils/musicSdk'

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
  if (record.infoLoaded && !isRefresh) return record
  const detail = await musicSdk.tx.singer.getDetail(mid) as SingerDetailResult
  // 请求回来时页面可能已经切走了（记录被重新建过），这时别写回旧对象
  if (singerState.singers[mid] !== record) return record
  return singerActions.setInfo(mid, detail.info, detail.songs)
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
  return singerActions.setSongs(mid, result, page)
}

export const getSingerAlbums = async(mid: string, page: number, isRefresh = false) => {
  const record = singerActions.getRecord(mid)
  if (page == 1 && record.albumsLoaded && !isRefresh) return record.albums
  const result = await musicSdk.tx.singer.getAlbums(mid, page, record.albums.limit) as AlbumsResult
  if (singerState.singers[mid] !== record) return record.albums
  return singerActions.setAlbums(mid, result, page)
}

export const getAlbumSongs = async(mid: string, page: number, isRefresh = false) => {
  const cached = singerState.albumSongs[mid]
  if (page == 1 && cached?.list.length && !isRefresh) return cached
  const result = await musicSdk.tx.album.getSongs(mid, page, cached?.limit ?? 30) as SongsResult
  return singerActions.setAlbumSongs(mid, result, page)
}
