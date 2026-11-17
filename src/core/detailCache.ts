import {
  getBrowseDetailCache, getBrowseDetailCacheIndex, saveBrowseDetailCache,
  saveBrowseDetailCacheIndex, removeBrowseDetailCaches,
} from '@/utils/data'

const MAX_ENTRIES = 32
const TTL = 30 * 60_000
const MAX_PENDING_BYTES = 2 * 1024 * 1024
const MAX_PENDING_ENTRIES = 32
const pending = new Map<string, { value: unknown, bytes: number, revision: number, onSaved?: (saved: boolean) => void }>()
const invalidated = new Map<string, number>()
const cleanupPending = new Set<string>()
// 写入/丢弃新快照后，在途读取也不能回传此前拿到的旧值。
const readers = new Map<string, Set<{ current: boolean }>>()
let revision = 0
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
  while (pending.size || cleanupPending.size) {
    if (cleanupPending.size) {
      const key = cleanupPending.values().next().value!
      cleanupPending.delete(key)
      // 已有更新的快照等待写入时，由该写入替换旧值。
      if (pending.has(key)) continue
      const invalidRevision = invalidated.get(key)
      if (invalidRevision == null) continue
      try {
        await removeBrowseDetailCaches([key], { includePages: false })
        if (invalidated.get(key) === invalidRevision) invalidated.delete(key)
      } catch (error) {
        // 清理失败仍保留失效标记；不能把旧磁盘值重新当作有效缓存。
        console.warn('[DetailCache] invalidate:', error instanceof Error ? error.message : error)
      }
      continue
    }
    const [key, snapshot] = pending.entries().next().value!
    pending.delete(key)
    pendingBytes -= snapshot.bytes
    activeBytes = snapshot.bytes
    const group = groupKey(key)
    let saved = false
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
      saved = true
      if ((invalidated.get(key) ?? 0) <= snapshot.revision) {
        invalidated.delete(key)
        cleanupPending.delete(key)
      }
    } catch (error) {
      await removeBrowseDetailCaches([group]).catch(() => {})
      console.warn('[DetailCache] save:', error instanceof Error ? error.message : error)
    } finally {
      activeBytes = 0
      snapshot.onSaved?.(saved && !invalidated.has(key) && !pending.has(key))
    }
  }
}
const scheduleWrite = () => {
  if (writes !== null || (!pending.size && !cleanupPending.size)) return
  writes = Promise.resolve().then(drain).finally(() => {
    writes = null
    scheduleWrite()
  })
}

/** 明细落盘后页面即可释放整表；只保留最近 32 个快照，不常驻其内容。 */
const enqueueDetailCache = (key: string, value: unknown, onSaved?: (saved: boolean) => void) => {
  for (const reader of readers.get(key) ?? []) reader.current = false
  const currentRevision = ++revision
  const old = pending.get(key)
  if (old) { pending.delete(key); pendingBytes -= old.bytes; old.onSaved?.(false) }
  const bytes = sizeOf(value)
  if (bytes + activeBytes > MAX_PENDING_BYTES) {
    invalidated.set(key, currentRevision)
    cleanupPending.add(key)
    scheduleWrite()
    onSaved?.(false)
    return
  }
  while (pending.size && (pending.size >= MAX_PENDING_ENTRIES || pendingBytes + activeBytes + bytes > MAX_PENDING_BYTES)) {
    const [oldKey, snapshot] = pending.entries().next().value!
    pending.delete(oldKey)
    pendingBytes -= snapshot.bytes
    invalidated.set(oldKey, snapshot.revision)
    cleanupPending.add(oldKey)
    snapshot.onSaved?.(false)
  }
  pending.set(key, { value, bytes, revision: currentRevision, onSaved })
  pendingBytes += bytes
  scheduleWrite()
}

export const saveDetailCache = (key: string, value: unknown) => { enqueueDetailCache(key, value) }

/** Stream dependent pages through the bounded writer before publishing their cursor. */
export const saveDetailCacheAndWait = async(key: string, value: unknown, isCurrent: () => boolean): Promise<boolean> => {
  for (let current = writes; current; current = writes) await current
  if (!isCurrent()) return false
  return new Promise(resolve => { enqueueDetailCache(key, value, resolve) })
}

export const getDetailCache = async<T>(key: string): Promise<T | null> => {
  for (let current = writes; current; current = writes) await current
  const reader = { current: true }
  let currentReaders = readers.get(key)
  if (!currentReaders) readers.set(key, currentReaders = new Set())
  currentReaders.add(reader)
  try {
    if (invalidated.has(key)) return null
    const time = (await getBrowseDetailCacheIndex())[groupKey(key)]
    if (!reader.current || !Number.isFinite(time) || Date.now() - time >= TTL) return null
    const value = await getBrowseDetailCache<T>(key)
    return reader.current ? value : null
  } catch (error) {
    console.warn('[DetailCache] read:', error instanceof Error ? error.message : error)
    return null
  } finally {
    currentReaders.delete(reader)
    if (!currentReaders.size) readers.delete(key)
  }
}
