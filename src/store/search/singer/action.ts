import state, { type SingerItem } from './state'
import { appendListPage } from '@/utils/listPage'

export interface SearchResult {
  list: SingerItem[]
  total: number
  allPage: number
  limit: number
  source: 'tx'
}

export default {
  setListInfo(result: SearchResult, page: number, text: string) {
    const listInfo = state.listInfo
    listInfo.list = appendListPage(listInfo.list, result.list, page === 1, item => item.mid, true)
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
