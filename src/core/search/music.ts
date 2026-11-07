import searchMusicState, { type Source } from '@/store/search/music/state'
import searchMusicActions, { type SearchResult } from '@/store/search/music/action'
import musicSdk from '@/utils/musicSdk'
import { invalidateSearchResult, restoreSearchResult } from './cache'
import { beginSearchRequest, finishSearchRequest } from './request'

export const setSource: typeof searchMusicActions['setSource'] = (source) => {
  searchMusicActions.setSource(source)
}
export const setSearchText: typeof searchMusicActions['setSearchText'] = (text) => {
  searchMusicActions.setSearchText(text)
}
export const setListInfo: typeof searchMusicActions.setListInfo = (result, id, page) => {
  return searchMusicActions.setListInfo(result, id, page)
}

export const clearListInfo: typeof searchMusicActions.clearListInfo = (source) => {
  searchMusicActions.clearListInfo(source)
}


/**
 * 返回要显示的列表；返回 null 表示这次结果作废（已被更新的请求顶掉，或关键词为空），
 * 调用方拿到 null 时不要动列表——空数组是"这一页确实没有结果"，两者被混用的话，
 * 一次作废的响应就会把界面上的列表清成空白页。
 */
export const search = async(text: string, page: number, sourceId: Source, isRefresh = false): Promise<LX.Music.MusicInfoOnline[] | null> => {
  const listInfo = searchMusicState.listInfos[sourceId]!
  if (!text) return null
  const signal = beginSearchRequest('music')
  try {
    if (page === 1 && !isRefresh && await restoreSearchResult('music', sourceId, text, signal)) return listInfo.list
    if (signal.aborted) return null
    const key = `${page}__${text}`
    if (sourceId == 'all') {
      let task = []
      let hadSuccess = false
      let requestError: Error | null = null
      for (const source of searchMusicState.sources) {
        if (source == 'all') continue
        const sdk = musicSdk[source]?.musicSearch
        const request = source === 'tx'
          ? musicSdk.tx.musicSearch.search(text, page, searchMusicState.listInfos.all.limit, signal)
          : sdk?.search(text, page, searchMusicState.listInfos.all.limit)
        task.push(((request as Promise<SearchResult>) ?? Promise.reject(new Error('source not found: ' + source))).then(result => {
          hadSuccess = true
          return result
        }).catch((error: any) => {
          requestError = error instanceof Error ? error : new Error(String(error))
          console.log(error)
          return {
            allPage: 1,
            limit: 30,
            list: [],
            source,
            total: 0,
          }
        }))
      }
      return await Promise.all(task).then((results: SearchResult[]) => {
        if (signal.aborted) return null
        // 全部请求失败不能当成空结果，否则刷新会错误删除仍可恢复的缓存。
        if (!hadSuccess) throw requestError ?? new Error('Search failed')
        setSearchText(text)
        setSource(sourceId)
        const list = setListInfo(results, page, text)
        listInfo.key = key
        if (page === 1) invalidateSearchResult('music', sourceId)
        return list
      })
    } else {
      if (!isRefresh && listInfo?.key == key && listInfo?.list.length) return listInfo?.list
      const sdk = musicSdk[sourceId]?.musicSearch
      const request = sourceId === 'tx' ? musicSdk.tx.musicSearch.search(text, page, listInfo.limit, signal) : sdk?.search(text, page, listInfo.limit)
      return await (request?.then((data: SearchResult) => {
        if (signal.aborted) return null
        setSearchText(text)
        const list = setListInfo(data, page, text)
        listInfo.key = key
        if (page === 1) invalidateSearchResult('music', sourceId)
        return list
      }) ?? Promise.reject(new Error('source not found: ' + sourceId))).catch((err: any) => {
        if (signal.aborted) return null
        if (listInfo.list.length && page == 1) clearListInfo(sourceId)
        throw err
      })
    }
  } finally { finishSearchRequest('music', signal) }
}
