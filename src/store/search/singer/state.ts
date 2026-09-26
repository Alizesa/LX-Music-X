export declare interface SingerItem {
  id: string | number
  mid: string
  name: string
  picUrl: string
  /** 专辑数 */
  albumSize: number
  /** 歌曲数 */
  songSize: number
  source: 'tx'
}

export declare interface ListInfo {
  list: SingerItem[]
  total: number
  page: number
  maxPage: number
  limit: number
  key: string | null
}

export interface InitState {
  searchText: string
  listInfo: ListInfo
}

const state: InitState = {
  searchText: '',
  listInfo: {
    list: [],
    total: 0,
    page: 0,
    maxPage: 1,
    limit: 20,
    key: null,
  },
}

export default state
