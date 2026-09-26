import state, { type SingerItem } from './state'

export interface SearchResult {
  list: SingerItem[]
  total: number
  allPage: number
  limit: number
  source: 'tx'
}

/** 去重按 mid，翻页时接口偶尔会把同一个歌手重复给回来 */
const deduplication = (list: SingerItem[]) => {
  return [...new Map(list.map(item => [item.mid, item])).values()]
}

export default {
  setSearchText(searchText: string) {
    state.searchText = searchText
  },
  setListInfo(result: SearchResult, page: number, text: string) {
    const listInfo = state.listInfo
    listInfo.list = deduplication(page == 1 ? result.list : [...listInfo.list, ...result.list])
    if (page == 1 || (result.total && result.list.length)) listInfo.total = result.total
    else listInfo.total = result.limit * page
    listInfo.maxPage = result.allPage
    listInfo.page = page
    listInfo.limit = result.limit
    state.searchText = text

    return listInfo.list
  },
  clearListInfo() {
    const listInfo = state.listInfo
    listInfo.list = []
    listInfo.page = 0
    listInfo.maxPage = 0
    listInfo.total = 0
  },
}
