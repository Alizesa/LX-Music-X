import searchAlbumState, { type AlbumItem } from '@/store/search/album/state'
import searchAlbumActions, { type SearchResult } from '@/store/search/album/action'
import musicSdk from '@/utils/musicSdk'
import { restoreSearchResult } from './cache'
import { beginSearchRequest, finishSearchRequest } from './request'

export const setSearchText: typeof searchAlbumActions['setSearchText'] = (text) => {
  searchAlbumActions.setSearchText(text)
}

/**
 * 返回要显示的列表；返回 null 表示这次结果作废（已被更新的请求顶掉，或关键词为空），
 * 调用方拿到 null 时不要动列表——把“作废”和“确实没有结果”混成同一个空数组，
 * 一次作废的响应就会清空界面上的列表。
 * @param isRefresh 跳过缓存，重新请求（下拉刷新用）
 */
export const search = async(text: string, page: number, isRefresh = false): Promise<AlbumItem[] | null> => {
  const listInfo = searchAlbumState.listInfo
  if (!text) return null
  const signal = beginSearchRequest('album')
  try {
    if (page === 1 && !isRefresh && await restoreSearchResult('album', 'tx', text, signal)) return listInfo.list
    if (signal.aborted) return null
    const key = `${page}__${text}`
    if (!isRefresh && listInfo.key == key && listInfo.list.length) return listInfo.list
    return await (musicSdk.tx.musicSearch.searchAlbum(text, page, listInfo.limit, signal) as Promise<SearchResult>).then((result) => {
      if (signal.aborted) return null
      const list = searchAlbumActions.setListInfo(result, page, text)
      listInfo.key = key
      return list
    }).catch((err: any) => {
      if (signal.aborted) return null
      // 失败后别把这个关键词记成已加载，否则重试会直接命中缓存拿不到数据
      if (listInfo.key == key) listInfo.key = null
      throw err
    })
  } finally { finishSearchRequest('album', signal) }
}
