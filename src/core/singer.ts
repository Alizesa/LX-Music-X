import singerState, { type SingerRecord, type PageInfo } from '@/store/singer/state'
import singerActions, { type AlbumsResult, type SongsResult } from '@/store/singer/action'
import musicSdk from '@/utils/musicSdk'
import { getDetailCache, saveDetailCache } from './detailCache'
import { appendListPage } from '@/utils/listPage'
import { toNewMusicInfo } from '@/utils'

const pageKeys = new WeakMap<object, string[]>()
const restores = new WeakMap<SingerRecord, Promise<void>>()
const singerVersions = new WeakMap<SingerRecord, { songs: number, albums: number }>()
const detailRequests = new WeakMap<SingerRecord, { version: number, promise: Promise<SingerRecord> }>()
const albumRequests = new WeakMap<SingerRecord, { version: number, promise: Promise<SingerRecord['albums']> }>()
type AlbumSongs = PageInfo<LX.Music.MusicInfoOnline>
const albumSongVersions = new WeakMap<AlbumSongs, number>()
const albumSongRestores = new WeakMap<AlbumSongs, Promise<void>>()
const albumSongRequests = new WeakMap<AlbumSongs, { version: number, promise: Promise<AlbumSongs> }>()
const versionsFor = (record: SingerRecord) => {
  let versions = singerVersions.get(record)
  if (!versions) singerVersions.set(record, versions = { songs: 0, albums: 0 })
  return versions
}
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
const cacheSingerMetadata = (mid: string, record: SingerRecord) => {
  const group = `singer_${mid}`
  saveDetailCache(group, {
    ...record,
    info: { ...record.info },
    songs: metadata(record.songs),
    albums: metadata(record.albums),
    pages: { songs: [...(pageKeys.get(record.songs) ?? [])], albums: [...(pageKeys.get(record.albums) ?? [])] },
  })
}
const cacheSinger = (mid: string, record: SingerRecord, kind: 'songs' | 'albums', result: SongsResult | AlbumsResult, page: number) => {
  cachePage(`singer_${mid}`, kind, record[kind], result, page)
  cacheSingerMetadata(mid, record)
}
const readPages = async<T>(keys: string[], getKey: (item: T) => string, convert: (item: T) => T, replace = false, active = () => true) => {
  let list: T[] = []
  for (const key of keys) {
    if (!active()) return null
    const page = await getDetailCache<{ list: T[] }>(key)
    if (!active()) return null
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
  const { songs: songsVersion, albums: albumsVersion } = versionsFor(record)
  const current = () => singerState.singers[mid] === record
  const restoreSongs = () => current() && versionsFor(record).songs === songsVersion && !record.infoLoaded && !record.songsLoaded
  const restoreAlbums = () => current() && versionsFor(record).albums === albumsVersion && !record.albumsLoaded
  if (!restoreSongs() && !restoreAlbums()) return
  const saved = await getDetailCache<SingerRecord & { pages?: { songs: string[], albums: string[] } }>(`singer_${mid}`)
  if (!current()) return
  if (saved?.info?.mid !== mid) return
  let restored = false
  if (saved.pages) {
    const songs = restoreSongs()
      ? await readPages<LX.Music.MusicInfoOnline>(saved.pages.songs, item => item.id, item => toNewMusicInfo(item) as LX.Music.MusicInfoOnline, false, restoreSongs)
      : null
    const albums = restoreAlbums()
      ? await readPages<SingerRecord['albums']['list'][number]>(saved.pages.albums, item => item.mid, item => item, true, restoreAlbums)
      : null
    if (songs && restoreSongs()) {
      Object.assign(record, { info: saved.info, infoLoaded: saved.infoLoaded, songs: { ...saved.songs, list: songs }, songsLoaded: saved.songsLoaded })
      pageKeys.set(record.songs, saved.pages.songs)
      restored = true
    }
    if (albums && restoreAlbums()) {
      Object.assign(record, { albums: { ...saved.albums, list: albums }, albumsLoaded: saved.albumsLoaded })
      pageKeys.set(record.albums, saved.pages.albums)
      restored = true
    }
  } else if (Array.isArray(saved.songs?.list) && Array.isArray(saved.albums?.list)) {
    if (restoreSongs()) {
      Object.assign(record, { info: saved.info, infoLoaded: saved.infoLoaded, songs: saved.songs, songsLoaded: saved.songsLoaded })
      restoreLegacyPages(`singer_${mid}`, 'songs', record.songs)
      restored = true
    }
    if (restoreAlbums()) {
      Object.assign(record, { albums: saved.albums, albumsLoaded: saved.albumsLoaded })
      restoreLegacyPages(`singer_${mid}`, 'albums', record.albums)
      restored = true
    }
  }
  // 刷新可能已写过另一 tab 的新元信息；补回仍有效的已恢复分页链接。
  const versions = versionsFor(record)
  const changed = versions.songs !== songsVersion || versions.albums !== albumsVersion
  const songsReady = versions.songs === songsVersion || record.infoLoaded || record.songsLoaded
  const albumsReady = versions.albums === albumsVersion || record.albumsLoaded
  if (restored && changed && songsReady && albumsReady) cacheSingerMetadata(mid, record)
}

// 歌曲和专辑共用一份分页快照；同一记录的并发消费者只恢复一次。
const restoreSinger = async(mid: string, record: SingerRecord, kind: 'songs' | 'albums') => {
  if (kind === 'songs' ? record.infoLoaded || record.songsLoaded : record.albumsLoaded) return
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
  const versions = versionsFor(record)
  if (isRefresh) versions.songs++
  const version = versions.songs
  const current = () => singerState.singers[mid] === record && versionsFor(record).songs === version
  if (!isRefresh) {
    const pending = detailRequests.get(record)
    if (pending?.version === version) return pending.promise
    await restoreSinger(mid, record, 'songs')
  }
  if (!current()) return record
  if (record.infoLoaded && !isRefresh) return record
  const pending = detailRequests.get(record)
  if (pending?.version === version) return pending.promise
  const task = (async() => {
    const detail = await musicSdk.tx.singer.getDetail(mid) as SingerDetailResult
    if (!current()) return record
    const result = singerActions.setInfo(mid, detail.info, detail.songs)
    cacheSinger(mid, result, 'songs', detail.songs, 1)
    return result
  })().finally(() => { if (detailRequests.get(record)?.promise === task) detailRequests.delete(record) })
  detailRequests.set(record, { version, promise: task })
  return task
}

/**
 * 歌手歌曲的后续页。第一页和歌手信息在同一个接口里，走 getSingerDetail 一起拿，
 * 免得进页面就发两条请求。
 */
export const getSingerSongs = async(mid: string, page: number, isRefresh = false) => {
  if (page <= 1) return (await getSingerDetail(mid, isRefresh)).songs
  const record = singerActions.getRecord(mid)
  const version = versionsFor(record).songs
  const first = detailRequests.get(record)
  if (first?.version === version) await first.promise
  if (singerState.singers[mid] !== record || versionsFor(record).songs !== version) return record.songs
  const result = await musicSdk.tx.singer.getSongs(mid, page, record.songs.limit) as SongsResult
  if (singerState.singers[mid] !== record || versionsFor(record).songs !== version) return record.songs
  const songs = singerActions.setSongs(mid, result, page)
  cacheSinger(mid, record, 'songs', result, page)
  return songs
}

export const getSingerAlbums = async(mid: string, page: number, isRefresh = false) => {
  const record = singerActions.getRecord(mid)
  const versions = versionsFor(record)
  if (page === 1 && isRefresh) versions.albums++
  const version = versions.albums
  const current = () => singerState.singers[mid] === record && versionsFor(record).albums === version
  const first = albumRequests.get(record)
  if (page > 1 && first?.version === version) await first.promise
  if (!current()) return record.albums
  if (!isRefresh) {
    const pending = albumRequests.get(record)
    if (page === 1 && pending?.version === version) return pending.promise
    await restoreSinger(mid, record, 'albums')
  }
  if (!current()) return record.albums
  if (page == 1 && record.albumsLoaded && !isRefresh) return record.albums
  const pending = albumRequests.get(record)
  if (page === 1 && pending?.version === version) return pending.promise
  const task = (async() => {
    const result = await musicSdk.tx.singer.getAlbums(mid, page, record.albums.limit) as AlbumsResult
    if (!current()) return record.albums
    const albums = singerActions.setAlbums(mid, result, page)
    cacheSinger(mid, record, 'albums', result, page)
    return albums
  })().finally(() => { if (albumRequests.get(record)?.promise === task) albumRequests.delete(record) })
  if (page === 1) albumRequests.set(record, { version, promise: task })
  return task
}

const restoreAlbumSongs = async(mid: string, record: AlbumSongs) => {
  const pending = albumSongRestores.get(record)
  if (pending) return pending
  const version = albumSongVersions.get(record) ?? 0
  const current = () => singerState.albumSongs[mid] === record && (albumSongVersions.get(record) ?? 0) === version && record.page === 0
  const task = (async() => {
    const saved = await getDetailCache<AlbumSongs & { pages?: string[] }>(`album_${mid}`)
    if (!current() || !saved || saved.page <= 0) return
    const list = saved.pages
      ? await readPages<LX.Music.MusicInfoOnline>(saved.pages, item => item.id, item => toNewMusicInfo(item) as LX.Music.MusicInfoOnline, false, current)
      : saved.list
    if (!current() || !Array.isArray(list)) return
    Object.assign(record, saved, { list })
    if (saved.pages) pageKeys.set(record, saved.pages)
    else restoreLegacyPages(`album_${mid}`, 'songs', record)
  })().finally(() => { if (albumSongRestores.get(record) === task) albumSongRestores.delete(record) })
  albumSongRestores.set(record, task)
  return task
}

export const getAlbumSongs = async(mid: string, page: number, isRefresh = false) => {
  const record = singerActions.getAlbumRecord(mid)
  if (page === 1 && isRefresh) albumSongVersions.set(record, (albumSongVersions.get(record) ?? 0) + 1)
  const version = albumSongVersions.get(record) ?? 0
  const current = () => singerState.albumSongs[mid] === record && (albumSongVersions.get(record) ?? 0) === version
  const first = albumSongRequests.get(record)
  if (page > 1 && first?.version === version) await first.promise
  if (!current()) return record
  if (!isRefresh && record.page === 0) {
    const pending = albumSongRequests.get(record)
    if (page === 1 && pending?.version === version) return pending.promise
    await restoreAlbumSongs(mid, record)
  }
  if (!current()) return record
  if (page === 1 && record.page > 0 && !isRefresh) return record
  const pending = albumSongRequests.get(record)
  if (page === 1 && pending?.version === version) return pending.promise
  const task = (async() => {
    const result = await musicSdk.tx.album.getSongs(mid, page, record.limit) as SongsResult
    if (!current()) return record
    const songs = singerActions.setAlbumSongs(mid, result, page)
    const pages = cachePage(`album_${mid}`, 'songs', songs, result, page)
    saveDetailCache(`album_${mid}`, { ...metadata(songs), pages })
    return songs
  })().finally(() => { if (albumSongRequests.get(record)?.promise === task) albumSongRequests.delete(record) })
  if (page === 1) albumSongRequests.set(record, { version, promise: task })
  return task
}
