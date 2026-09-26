import searchSingerState, { type SingerItem } from '@/store/search/singer/state'
import searchSingerActions, { type SearchResult } from '@/store/search/singer/action'
import musicSdk from '@/utils/musicSdk'

export const setSearchText: typeof searchSingerActions['setSearchText'] = (text) => {
  searchSingerActions.setSearchText(text)
}

/**
 * 返回要显示的列表；返回 null 表示这次结果作废（已被更新的请求顶掉，或关键词为空），
 * 调用方拿到 null 时不要动列表——把“作废”和“确实没有结果”混成同一个空数组，
 * 一次作废的响应就会清空界面上的列表。
 * @param isRefresh 跳过缓存，重新请求（下拉刷新用）
 */
export const search = async(text: string, page: number, isRefresh = false): Promise<SingerItem[] | null> => {
  const listInfo = searchSingerState.listInfo
  if (!text) return null
  const key = `${page}__${text}`
  if (!isRefresh && listInfo.key == key && listInfo.list.length) return listInfo.list
  listInfo.key = key
  return (musicSdk.tx.musicSearch.searchSinger(text, page, listInfo.limit) as Promise<SearchResult>).then((result) => {
    if (key != listInfo.key) return null
    return searchSingerActions.setListInfo(result, page, text)
  }).catch((err: any) => {
    // 失败后别把这个关键词记成已加载，否则重试会直接命中缓存拿不到数据
    if (listInfo.key == key) listInfo.key = null
    throw err
  })
}
