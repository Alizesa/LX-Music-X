export declare interface SingerInfo {
  id: string
  mid: string
  name: string
  /** 英文名等别名 */
  otherName: string
  fans: number
  brief: string
  totalSong: number
  totalAlbum: number
  totalMv: number
}

export declare interface AlbumItem {
  id: string
  mid: string
  name: string
  author: string
  img: string
  publishDate: string
  albumType: string
  source: 'tx'
}

export declare interface PageInfo<T> {
  list: T[]
  total: number
  page: number
  maxPage: number
  limit: number
}

/** 歌手详情页的跳转参数，id 用于共享元素动画 */
export declare interface SingerDetailParams {
  id: string
  mid: string
  name: string
  picUrl?: string
}

/** 专辑详情页的跳转参数 */
export declare interface AlbumDetailParams {
  id: string
  mid: string
  name: string
  author: string
  img: string
  publishDate?: string
}

export declare interface SingerRecord {
  info: SingerInfo
  infoLoaded: boolean
  /** 热门歌曲，接口不支持翻页 */
  songs: PageInfo<LX.Music.MusicInfoOnline>
  songsLoaded: boolean
  albums: PageInfo<AlbumItem>
  albumsLoaded: boolean
}

export interface InitState {
  /** 按歌手 mid 缓存，来回切页不用重新请求 */
  singers: Record<string, SingerRecord>
  /** 专辑歌曲，按专辑 mid 缓存 */
  albumSongs: Record<string, PageInfo<LX.Music.MusicInfoOnline>>
}

export const createSingerRecord = (mid: string, name = ''): SingerRecord => ({
  info: {
    id: '',
    mid,
    name,
    otherName: '',
    fans: 0,
    brief: '',
    totalSong: 0,
    totalAlbum: 0,
    totalMv: 0,
  },
  infoLoaded: false,
  songs: { list: [], total: 0, page: 0, maxPage: 1, limit: 50 },
  songsLoaded: false,
  albums: { list: [], total: 0, page: 0, maxPage: 1, limit: 20 },
  albumsLoaded: false,
})

const state: InitState = {
  singers: {},
  albumSongs: {},
}

export default state
