import { type AlbumItem } from '@/store/singer/state'

// 搜索结果里的专辑和歌手详情页专辑标签里的专辑结构一致，直接用同一个类型，
// 这样两个地方能共用同一套封面网格组件
export type { AlbumItem }

export declare interface ListInfo {
  list: AlbumItem[]
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
    limit: 30,
    key: null,
  },
}

export default state
