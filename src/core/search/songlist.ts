import searchSonglistState, { type Source, type ListInfoItem } from '@/store/search/songlist/state'
import searchSonglistActions, { type SearchResult } from '@/store/search/songlist/action'
import musicSdk from '@/utils/musicSdk'
import { invalidateSearchResult, restoreSearchResult } from './cache'
import { beginSearchRequest, finishSearchRequest } from './request'

export const setSource: typeof searchSonglistActions['setSource'] = (source) => {
  searchSonglistActions.setSource(source)
}
export const setSearchText: typeof searchSonglistActions['setSearchText'] = (text) => {
  searchSonglistActions.setSearchText(text)
}
const setListInfo: typeof searchSonglistActions.setListInfo = (result, page, text) => {
  return searchSonglistActions.setListInfo(result, page, text)
}

export const clearListInfo: typeof searchSonglistActions.clearListInfo = (source) => {
  searchSonglistActions.clearListInfo(source)
}


/**
 * 返回要显示的列表；返回 null 表示这次结果作废（已被更新的请求顶掉，或关键词为空），
 * 调用方拿到 null 时不要动列表——把"作废"和"确实没有结果"混成同一个空数组，
 * 一次作废的响应就会清空界面上的列表。
 */
export const search = async(text: string, page: number, sourceId: Source, isRefresh = false): Promise<ListInfoItem[] | null> => {
  const listInfo = searchSonglistState.listInfos[sourceId]!
  if (!text) return null
  const signal = beginSearchRequest('songlist')
  try {
    if (page === 1 && !isRefresh && await restoreSearchResult('songlist', sourceId, text, signal)) return listInfo.list
    if (signal.aborted) return null
    const key = `${page}__${sourceId}__${text}`
    if (!isRefresh && listInfo.key == key && listInfo.list.length) return listInfo.list
    if (sourceId == 'all') {
      let task = []
      let hadSuccess = false
      let requestError: Error | null = null
      for (const source of searchSonglistState.sources) {
        if (source == 'all' || (page > 1 && page > (searchSonglistState.maxPages[source]!))) continue
        task.push(((musicSdk[source]?.songList.search(text, page, searchSonglistState.listInfos.all.limit) as Promise<SearchResult>) ?? Promise.reject(new Error('source not found: ' + source))).then(result => {
          hadSuccess = true
          return result
        }).catch((error: any) => {
          requestError = error instanceof Error ? error : new Error(String(error))
          console.log(error)
          return {
            list: [],
            total: 0,
            limit: searchSonglistState.listInfos.all.limit,
            source,
          }
        }))
      }
      return await Promise.all(task).then((results: SearchResult[]) => {
        if (signal.aborted) return null
        // 翻页跳过已结束的音源时可以没有请求；已发出的请求全失败则保留旧结果。
        if (task.length && !hadSuccess) throw requestError ?? new Error('Search failed')
        setSearchText(text)
        setSource(sourceId)
        const list = setListInfo(results, page, text)
        listInfo.key = key
        if (page === 1) invalidateSearchResult('songlist', sourceId)
        return list
      })
    } else {
      if (!isRefresh && listInfo?.key == key && listInfo?.list.length) return listInfo?.list
      return await ((musicSdk[sourceId]?.songList.search(text, page, listInfo.limit) as Promise<SearchResult>).then((data: SearchResult) => {
        if (signal.aborted) return null
        setSearchText(text)
        const list = setListInfo(data, page, text)
        listInfo.key = key
        if (page === 1) invalidateSearchResult('songlist', sourceId)
        return list
      }) ?? Promise.reject(new Error('source not found: ' + sourceId))).catch((err: any) => {
        if (signal.aborted) return null
        if (listInfo.list.length && page == 1) clearListInfo(sourceId)
        throw err
      })
    }
  } finally { finishSearchRequest('songlist', signal) }
}
