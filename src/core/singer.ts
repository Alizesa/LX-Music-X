import singerState, { type SingerRecord, type PageInfo } from '@/store/singer/state'
import singerActions, { type AlbumsResult, type SongsResult } from '@/store/singer/action'
import musicSdk from '@/utils/musicSdk'
import { getDetailCache, saveDetailCache } from './detailCache'
import { appendListPage } from '@/utils/listPage'
import { toNewMusicInfo } from '@/utils'

const pageKeys = new WeakMap<object, string[]>()
const restores = new WeakMap<SingerRecord, Promise<void>>()
const metadata = <T>(info: PageInfo<T>) => {
  const { list, ...meta } = info
  return meta
}
const cachePage = (group: string, kind: string, info: object, result: { list: unknown[] }, page: number) => {
  const key = `${group}::${kind}:${page}`
  const keys = page === 1 ? [] : (pageKeys.get(info) ?? [])
  if (!keys.includes(key)) keys.push(key)
  pageKeys.set(info, keys)
  saveDetailCache(key, result)
  return [...keys]
}
const cacheSinger = (mid: string, record: SingerRecord, kind: 'songs' | 'albums', result: SongsResult | AlbumsResult, page: number) => {
  const group = `singer_${mid}`
  cachePage(group, kind, record[kind], result, page)
  saveDetailCache(group, {
    ...record,
    info: { ...record.info },
    songs: metadata(record.songs),
    albums: metadata(record.albums),
    pages: { songs: [...(pageKeys.get(record.songs) ?? [])], albums: [...(pageKeys.get(record.albums) ?? [])] },
  })
}
const readPages = async<T>(keys: string[], getKey: (item: T) => string, convert: (item: T) => T, replace = false) => {
  let list: T[] = []
  for (const key of keys) {
    const page = await getDetailCache<{ list: T[] }>(key)
    if (!Array.isArray(page?.list)) return null
    list = appendListPage(list, page.list.map(convert), false, getKey, replace)
  }
  return list
}
const restoreLegacyPages = (group: string, kind: string, info: PageInfo<unknown>) => {
  if (!info.list.length) return
  const key = `${group}::${kind}:legacy`
  saveDetailCache(key, { list: [...info.list] })
  pageKeys.set(info, [key])
}
const restoreSingerCache = async(mid: string, record: SingerRecord) => {
  if (record.infoLoaded || record.songsLoaded || record.albumsLoaded) return
  const saved = await getDetailCache<SingerRecord & { pages?: { songs: string[], albums: string[] } }>(`singer_${mid}`)
  if (singerState.singers[mid] !== record || record.infoLoaded || record.songsLoaded || record.albumsLoaded) return
  if (saved?.info?.mid !== mid) return
  if (saved.pages) {
    const songs = await readPages<LX.Music.MusicInfoOnline>(saved.pages.songs, item => item.id, item => toNewMusicInfo(item) as LX.Music.MusicInfoOnline)
    const albums = await readPages<SingerRecord['albums']['list'][number]>(saved.pages.albums, item => item.mid, item => item, true)
    if (!songs || !albums || singerState.singers[mid] !== record || record.infoLoaded || record.songsLoaded || record.albumsLoaded) return
    Object.assign(record, { ...saved, songs: { ...saved.songs, list: songs }, albums: { ...saved.albums, list: albums } })
    pageKeys.set(record.songs, saved.pages.songs)
    pageKeys.set(record.albums, saved.pages.albums)
  } else if (Array.isArray(saved.songs?.list) && Array.isArray(saved.albums?.list)) {
    Object.assign(record, saved)
    restoreLegacyPages(`singer_${mid}`, 'songs', record.songs)
    restoreLegacyPages(`singer_${mid}`, 'albums', record.albums)
  }
}

// 歌曲和专辑共用一份分页快照；同一记录的并发消费者只恢复一次。
const restoreSinger = async(mid: string, record: SingerRecord) => {
  const pending = restores.get(record)
  if (pending) return pending
  const task = restoreSingerCache(mid, record).finally(() => { restores.delete(record) })
  restores.set(record, task)
  return task
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
  cacheSinger(mid, result, 'songs', detail.songs, 1)
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
  cacheSinger(mid, record, 'songs', result, page)
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
  cacheSinger(mid, record, 'albums', result, page)
  return albums
}

export const getAlbumSongs = async(mid: string, page: number, isRefresh = false) => {
  const record = singerActions.getAlbumRecord(mid)
  if (!isRefresh && record.page === 0) {
    const saved = await getDetailCache<PageInfo<LX.Music.MusicInfoOnline> & { pages?: string[] }>(`album_${mid}`)
    if (singerState.albumSongs[mid] !== record) return record
    if (record.page === 0 && saved && saved.page > 0) {
      const list = saved.pages
        ? await readPages<LX.Music.MusicInfoOnline>(saved.pages, item => item.id, item => toNewMusicInfo(item) as LX.Music.MusicInfoOnline)
        : saved.list
      if (singerState.albumSongs[mid] !== record) return record
      if (record.page === 0 && Array.isArray(list)) {
        Object.assign(record, saved, { list })
        if (saved.pages) pageKeys.set(record, saved.pages)
        else restoreLegacyPages(`album_${mid}`, 'songs', record)
      }
    }
  }
  if (page === 1 && record.page > 0 && !isRefresh) return record
  const result = await musicSdk.tx.album.getSongs(mid, page, record.limit) as SongsResult
  if (singerState.albumSongs[mid] !== record) return record
  const songs = singerActions.setAlbumSongs(mid, result, page)
  const pages = cachePage(`album_${mid}`, 'songs', songs, result, page)
  saveDetailCache(`album_${mid}`, { ...metadata(songs), pages })
  return songs
}
