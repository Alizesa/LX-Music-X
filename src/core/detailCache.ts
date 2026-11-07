import {
  getBrowseDetailCache, getBrowseDetailCacheIndex, saveBrowseDetailCache,
  saveBrowseDetailCacheIndex, removeBrowseDetailCaches,
} from '@/utils/data'

const MAX_ENTRIES = 32
const TTL = 30 * 60_000
const pending = new Map<string, unknown>()
const queued = new Set<string>()
let writes: Promise<void> = Promise.resolve()

/** 明细落盘后页面即可释放整表；只保留最近 32 个快照，不常驻其内容。 */
export const saveDetailCache = (key: string, value: unknown) => {
  // 慢存储下同一详情只排入最新快照，避免每次翻页都在队列里保留一份旧数组。
  pending.set(key, value)
  if (queued.has(key)) return
  queued.add(key)
  writes = writes.then(async() => {
    queued.delete(key)
    const snapshot = pending.get(key)
    pending.delete(key)
    const index = await getBrowseDetailCacheIndex()
    try {
      await saveBrowseDetailCache(key, snapshot)
      delete index[key]
      index[key] = Date.now()
      const keep = Object.entries(index).reverse()
        .filter(([, time]) => Number.isFinite(time) && Date.now() - time < TTL)
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_ENTRIES)
      const next = Object.fromEntries(keep)
      const removed = Object.keys(index).filter(id => !Object.prototype.hasOwnProperty.call(next, id))
      await removeBrowseDetailCaches(removed)
      await saveBrowseDetailCacheIndex(next)
    } catch (error) {
      // 索引写入失败时不要留下无法被容量限制找到的快照。
      await removeBrowseDetailCaches([key]).catch(() => {})
      throw error
    }
  }).catch((error: unknown) => {
    console.warn('[DetailCache] save:', error instanceof Error ? error.message : error)
  })
}

export const getDetailCache = async<T>(key: string): Promise<T | null> => {
  await writes
  try {
    const time = (await getBrowseDetailCacheIndex())[key]
    if (!Number.isFinite(time) || Date.now() - time >= TTL) return null
    return await getBrowseDetailCache<T>(key)
  } catch (error) {
    console.warn('[DetailCache] read:', error instanceof Error ? error.message : error)
    return null
  }
}
