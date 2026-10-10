export type SearchType = 'music' | 'songlist' | 'singer' | 'album'

/** 只有 tx 源支持搜索的类型（其他的搜不了，切到这些类型时源固定为 tx） */
export const TX_ONLY_SEARCH_TYPES: SearchType[] = ['singer', 'album']

export interface InitState {
  temp_source: 'kw'
  // temp_source: LX.OnlineSource
  searchType: SearchType
  searchText: string
  tipListInfo: {
    text: string
    source: 'kw'
    list: string[]
  }
  historyList: string[]
}

const state: InitState = {
  temp_source: 'kw',
  searchType: 'music',
  searchText: '',
  tipListInfo: {
    text: '',
    source: 'kw',
    list: [],
  },
  historyList: [],
}


export default state
