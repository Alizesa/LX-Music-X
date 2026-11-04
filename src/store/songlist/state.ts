export declare interface ListInfoItem {
  play_count?: string
  id: string
  author: string
  name: string
  time?: string
  img?: string
  // grade: basic.favorcnt / 10,
  desc?: string
  source: LX.OnlineSource
  total?: string
}

export declare interface ListDetailInfo {
  list: LX.Music.MusicInfoOnline[]
  source: LX.OnlineSource
  // desc: string | null
  total: number
  page: number
  limit: number
  maxPage: number
  key: string | null
  id: string
  info: {
    name?: string
    img?: string
    desc?: string
    author?: string
    play_count?: string
  }
}

export type Source = LX.OnlineSource
export interface InitState {
  listDetailInfo: ListDetailInfo
}


const state: InitState = {
  listDetailInfo: {
    list: [],
    id: '',
    // desc: null,
    total: 0,
    page: 1,
    limit: 30,
    maxPage: 1,
    key: null,
    source: 'kw',
    info: {},
  },
}


export default state

