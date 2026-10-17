import songlistState, { type TagInfo, type ListDetailInfo, type ListInfo } from '@/store/songlist/state'
import songlistActions from '@/store/songlist/action'
import { deduplicationList, toNewMusicInfo } from '@/utils'
import musicSdk from '@/utils/musicSdk'


interface DetailPageCache { data: ListDetailInfo, sourcePage: number }
type LimitDetailCache = Map<string, DetailPageCache | ListDetailInfo['list']>
type CacheValue = LimitDetailCache | ListInfo

const cache = new Map<string, CacheValue>()
const LIST_LOAD_LIMIT = 30
// 歌单详情缓存的上限：最多留 8 个歌单、合计 3000 首。
// 没有上限的话，搜过/开过多少个歌单，就有多少份完整歌曲信息常驻到进程结束。
const DETAIL_CACHE_MAX = 8
const DETAIL_CACHE_MAX_SONGS = 3000
// 歌单广场列表页（slist__）是小块卡片数据，不参与详情淘汰；
// 仍给一个上限防御，避免分类/分页浏览长期累积
const SLIST_CACHE_MAX = 50
// 正在加载的详情不参与淘汰：getListDetailLimit 的 then 里要校验 listCache 是否
// 还是缓存里的那一个，被淘汰掉会直接返回 undefined。
const loadingDetailKeys = new Set<string>()

// Map 保持插入顺序：删了再塞就排到末尾，淘汰时从头部拿最久没用的
const touchCache = (key: string) => {
  const value = cache.get(key)
  if (value === undefined) return
  cache.delete(key)
  cache.set(key, value)
}

const countCachedSongs = (value: CacheValue | undefined) => {
  if (!(value instanceof Map)) return 0
  let total = 0
  for (const page of value.values()) {
    total += Array.isArray(page) ? page.length : page.data.list.length
  }
  return total
}

const pruneSListCache = () => {
  let count = 0
  for (const key of cache.keys()) {
    if (key.startsWith('slist__')) count++
  }
  while (count > SLIST_CACHE_MAX) {
    let oldest: string | undefined
    for (const key of cache.keys()) {
      if (key.startsWith('slist__')) {
        oldest = key
        break
      }
    }
    if (oldest == null) break
    cache.delete(oldest)
    count--
  }
}

const pruneDetailCache = () => {
  const detailKeys: string[] = []
  let totalSongs = 0
  for (const [key, value] of cache) {
    if (!key.startsWith('sdetail__')) continue
    detailKeys.push(key)
    totalSongs += countCachedSongs(value)
  }
  if (detailKeys.length <= DETAIL_CACHE_MAX && totalSongs <= DETAIL_CACHE_MAX_SONGS) return

  // 最新的那个对应刚访问/正在加载的歌单，无论如何留着，
  // 否则单个超大歌单会刚拿完就被自己挤掉
  const newestKey = detailKeys[detailKeys.length - 1]
  let count = detailKeys.length
  for (const key of detailKeys) {
    if (count <= DETAIL_CACHE_MAX && totalSongs <= DETAIL_CACHE_MAX_SONGS) break
    if (key === newestKey || loadingDetailKeys.has(key)) continue
    totalSongs -= countCachedSongs(cache.get(key))
    cache.delete(key)
    count--
  }
}


/**
 * 获取排序列表
 * @param source
 * @returns
 */
export const getSortList = (source: LX.OnlineSource) => {
  return songlistState.sortList[source]!
}

/**
 * 获取标签列表
 * @param source
 * @returns
 */
export const getTags = async<T extends LX.OnlineSource>(source: T) => {
  if (songlistState.tags[source]) return songlistState.tags[source] as TagInfo<T>
  const info = await (musicSdk[source]?.songList.getTags() as Promise<TagInfo<T>>)
  songlistActions.setTags(info, source)
  return info
}

/**
 * 设置列表加载加载前的基本信息（用于加载失败后的重新加载）
 * @param source
 * @param tagId
 * @param sortId
 */
export const setListInfo: typeof songlistActions.setListInfo = (source, tagId, sortId) => {
  clearList()
  songlistActions.setListInfo(source, tagId, sortId)
}
/**
 * 设置列表信息
 * @param result
 * @param tagId
 * @param sortId
 * @param page
 * @returns
 */
export const setList: typeof songlistActions.setList = (result, tagId, sortId, page) => {
  return songlistActions.setList(result, tagId, sortId, page)
}

export const clearList = () => {
  songlistActions.clearList()
}

/**
 * 获取歌单列表
 * @param source 歌单源
 * @param tabId 类型id
 * @param sortId 排序
 * @param page 页数
 * @param isRefresh 是否跳过缓存
 * @returns
 */
export const getList = async(source: LX.OnlineSource, tabId: string, sortId: string, page: number, isRefresh = false): Promise<ListInfo> => {
  let pageKey = `slist__${source}__${sortId}__${tabId}__${page}`

  let listCache = cache.get(pageKey) as ListInfo
  if (listCache) {
    if (isRefresh) cache.delete(pageKey)
    else {
      touchCache(pageKey)
      return listCache
    }
  }

  return musicSdk[source]?.songList.getList(sortId, tabId, page).then((result: ListInfo) => {
    cache.set(pageKey, result)
    pruneSListCache()
    return result
    // if (pageKey != listInfo.key) return
    // setList(result, tabId, sortId, page)
  })
}


/**
 * 获取歌单详情内单页分页歌曲（用于在本地控制每页大小）
 * @param source 源
 * @param id 歌单id
 * @param page 页数
 * @returns
 */
const getListDetailLimit = async(source: LX.OnlineSource, id: string, page: number): Promise<ListDetailInfo> => {
  const listKey = `sdetail__${source}__${id}`
  const prevPageKey = `sdetail__${source}__${id}__${page - 1}`
  const tempListKey = `sdetail__${source}__${id}__temp`

  let listCache = cache.get(listKey) as LimitDetailCache
  if (!listCache) cache.set(listKey, listCache = new Map())
  else touchCache(listKey)
  let sourcePage = 0
  {
    const prevPageData = listCache.get(prevPageKey) as DetailPageCache
    if (prevPageData) sourcePage = prevPageData.sourcePage
  }

  loadingDetailKeys.add(listKey)
  return (musicSdk[source]?.songList.getListDetail(id, sourcePage + 1).then((result: ListDetailInfo) => {
    if (listCache !== cache.get(listKey)) return
    result.list = deduplicationList(result.list.map(m => toNewMusicInfo(m)) as LX.Music.MusicInfoOnline[])
    let p = page
    const tempList = listCache.get(tempListKey) as ListDetailInfo['list']
    if (tempList) {
      listCache.delete(tempListKey)
      listCache.set(`sdetail__${source}__${id}__${p}`, {
        data: {
          ...result,
          list: [...tempList, ...result.list.splice(0, LIST_LOAD_LIMIT - tempList.length)],
          page: p,
          limit: LIST_LOAD_LIMIT,
        },
        sourcePage,
      })
      p++
    }
    sourcePage++
    do {
      if (result.list.length < LIST_LOAD_LIMIT && sourcePage < Math.ceil(result.total / result.limit)) {
        listCache.set(tempListKey, result.list.splice(0, LIST_LOAD_LIMIT))
        break
      }
      listCache.set(`sdetail__${source}__${id}__${p}`, {
        data: {
          ...result,
          list: result.list.splice(0, LIST_LOAD_LIMIT),
          page: p,
          limit: LIST_LOAD_LIMIT,
        },
        sourcePage,
      })
      p++
    } while (result.list.length > 0)
    return (listCache.get(`sdetail__${source}__${id}__${page}`) as DetailPageCache).data
  }) ?? Promise.reject(new Error('source not found'))).finally(() => {
    loadingDetailKeys.delete(listKey)
    pruneDetailCache()
  })
}

/**
 * 设置列表加载加载前的基本信息（用于加载失败后的重新加载）
 * @param source
 * @param tagId
 * @param sortId
 */
export const setListDetailInfo: typeof songlistActions.setListDetailInfo = (source, id) => {
  clearListDetail()
  songlistActions.setListDetailInfo(source, id)
}
export const setListDetail: typeof songlistActions.setListDetail = (result, id, page) => {
  return songlistActions.setListDetail(result, id, page)
}

export const clearListDetail = () => {
  songlistActions.clearListDetail()
}

/**
 * 详情缓存被淘汰后，靠「前一页缓存里的 sourcePage」递进的关系就断了：
 * 直接取第 N 页会把源的第一页当成第 N 页返回。这里从第 1 页重新推进到 page - 1。
 * 只有长期没打开、缓存已被淘汰的歌单继续往下翻时才会走到这里。
 */
const ensurePreviousPages = async(source: LX.OnlineSource, id: string, page: number) => {
  if (page <= 1) return
  const listKey = `sdetail__${source}__${id}`
  for (let p = 1; p < page; p++) {
    const listCache = cache.get(listKey) as LimitDetailCache | undefined
    if (listCache?.get(`${listKey}__${p}`)) continue
    await getListDetailLimit(source, id, p)
  }
}

/**
 * 获取歌单内单页歌曲
 * @param id 歌单id
 * @param source 歌单源
 * @param isRefresh 是否跳过缓存
 * @returns
 */
export const getListDetail = async(id: string, source: LX.OnlineSource, page: number, isRefresh = false): Promise<ListDetailInfo> => {
  const listKey = `sdetail__${source}__${id}`
  const pageKey = `sdetail__${source}__${id}__${page}`

  let listCache = cache.get(listKey) as LimitDetailCache
  if (!listCache || isRefresh) {
    cache.set(listKey, listCache = new Map())
  } else {
    touchCache(listKey)
  }

  let pageCache = listCache.get(pageKey) as DetailPageCache
  if (pageCache) return pageCache.data

  await ensurePreviousPages(source, id, page)
  return getListDetailLimit(source, id, page)
}

/**
 * 获取歌单内全部歌曲
 * @param id 歌单id
 * @param source 歌单源
 * @param isRefresh 是否跳过缓存
 * @returns
 */
export const getListDetailAll = async(source: LX.OnlineSource, id: string, isRefresh = false): Promise<LX.Music.MusicInfoOnline[]> => {
  // console.log(tabId)
  const listKey = `sdetail__${source}__${id}`
  let listCache = cache.get(listKey) as LimitDetailCache
  if (!listCache || isRefresh) {
    cache.set(listKey, listCache = new Map())
  } else {
    touchCache(listKey)
  }

  const loadData = async(page: number): Promise<ListDetailInfo> => {
    const pageKey = `sdetail__${source}__${id}__${page}`
    let pageCache = listCache.get(pageKey) as DetailPageCache
    if (pageCache) return pageCache.data
    return getListDetailLimit(source, id, page)
  }
  const first = await loadData(1)
  if (first.total <= first.limit) return deduplicationList(first.list)

  // 迭代追加，避免递归 [...result1, ...result2] 在大歌单上做 O(n²) 的引用拷贝
  const all: LX.Music.MusicInfoOnline[] = [...first.list]
  const maxPage = Math.ceil(first.total / first.limit)
  for (let page = 2; page <= maxPage; page++) {
    const data = await loadData(page)
    all.push(...data.list)
  }
  return deduplicationList(all)
}
