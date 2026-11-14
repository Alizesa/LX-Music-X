import {
  getBrowseDetailCache, getBrowseDetailCacheIndex, saveBrowseDetailCache,
  saveBrowseDetailCacheIndex, removeBrowseDetailCaches,
} from '@/utils/data'

const MAX_ENTRIES = 32
const TTL = 30 * 60_000
const MAX_PENDING_BYTES = 2 * 1024 * 1024
const MAX_PENDING_ENTRIES = 32
const pending = new Map<string, { value: unknown, bytes: number }>()
const invalidated = new Set<string>()
let pendingBytes = 0
let activeBytes = 0
let writes: Promise<void> | null = null
const groupKey = (key: string) => key.split('::')[0]

const sizeOf = (value: unknown, seen = new WeakSet<object>(), depth = 0): number => {
  if (typeof value === 'string') return value.length * 3 + 8
  if (!value || typeof value !== 'object') return 8
  if (seen.has(value)) return 0
  if (depth > 32) return MAX_PENDING_BYTES + 1
  seen.add(value)
  let bytes = 32
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    bytes += key.length * 3 + sizeOf((value as Record<string, unknown>)[key], seen, depth + 1)
    if (bytes > MAX_PENDING_BYTES) break
  }
  return bytes
}

const drain = async() => {
  while (pending.size) {
    const [key, snapshot] = pending.entries().next().value!
    pending.delete(key)
    pendingBytes -= snapshot.bytes
    activeBytes = snapshot.bytes
    const group = groupKey(key)
    try {
      const index = await getBrowseDetailCacheIndex()
      await saveBrowseDetailCache(key, snapshot.value)
      delete index[group]
      index[group] = Date.now()
      const keep = Object.entries(index).reverse()
        .filter(([, time]) => Number.isFinite(time) && Date.now() - time < TTL)
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_ENTRIES)
      const next = Object.fromEntries(keep)
      const removed = Object.keys(index).filter(id => !Object.prototype.hasOwnProperty.call(next, id))
      await removeBrowseDetailCaches(removed)
      await saveBrowseDetailCacheIndex(next)
      invalidated.delete(key)
    } catch (error) {
      await removeBrowseDetailCaches([group]).catch(() => {})
      console.warn('[DetailCache] save:', error instanceof Error ? error.message : error)
    } finally {
      activeBytes = 0
    }
  }
}
const scheduleWrite = () => {
  if (writes !== null || !pending.size) return
  writes = Promise.resolve().then(drain).finally(() => {
    writes = null
    scheduleWrite()
  })
}

/** 明细落盘后页面即可释放整表；只保留最近 32 个快照，不常驻其内容。 */
export const saveDetailCache = (key: string, value: unknown) => {
  const old = pending.get(key)
  if (old) { pending.delete(key); pendingBytes -= old.bytes }
  const bytes = sizeOf(value)
  if (bytes + activeBytes > MAX_PENDING_BYTES) { invalidated.add(key); return }
  while (pending.size && (pending.size >= MAX_PENDING_ENTRIES || pendingBytes + activeBytes + bytes > MAX_PENDING_BYTES)) {
    const [oldKey, snapshot] = pending.entries().next().value!
    pending.delete(oldKey)
    pendingBytes -= snapshot.bytes
    invalidated.add(oldKey)
  }
  pending.set(key, { value, bytes })
  pendingBytes += bytes
  scheduleWrite()
}

export const getDetailCache = async<T>(key: string): Promise<T | null> => {
  for (let current = writes; current; current = writes) await current
  try {
    if (invalidated.has(key)) return null
    const time = (await getBrowseDetailCacheIndex())[groupKey(key)]
    if (!Number.isFinite(time) || Date.now() - time >= TTL) return null
    return await getBrowseDetailCache<T>(key)
  } catch (error) {
    console.warn('[DetailCache] read:', error instanceof Error ? error.message : error)
    return null
  }
}
