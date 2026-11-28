import AsyncStorage from '@react-native-async-storage/async-storage'
import { log } from '@/utils/log'

const partKeyPrefix = '@___PART___'
const partKeyArrPrefix = '@___PART_A___'
const partKeyPrefixRxp = /^@___PART___/
const partKeyArrPrefixRxp = /^@___PART_A___/
const keySplit = ','
const limit = 500000
// Next storage uses one SQL parameter per IN key; older Android SQLite allows 999.
const SQL_KEY_BATCH_SIZE = 500
const partNamespace = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
let partSequence = 0
const obsoletePartsPrefix = '@___OBSOLETE_PARTS___'
// The atomic journal on disk is the source of truth. Never keep a growing map of old manifests in JS.
const JOURNALS_PER_SWEEP = 8
const SWEEP_INTERVAL = 1000
const MAX_RETRY_DELAY = 60_000
let scanNeeded = true
let nextScan = 0
let blockedUntil = 0
let retryDelay = SWEEP_INTERVAL
let journalCursor: string | undefined
let obsoleteRecovery: Promise<void> | null = null

const deferCleanup = (error: unknown) => {
  scanNeeded = true
  const now = Date.now()
  if (now < blockedUntil) return
  blockedUntil = now + retryDelay
  retryDelay = Math.min(MAX_RETRY_DELAY, retryDelay * 2)
  log.error('storage error[cleanup parts]:', error instanceof Error ? error.message : String(error))
}

const selectJournalBatch = async() => {
  // AsyncStorage only exposes getAllKeys; discard its directory array before reading any manifests.
  const all = await AsyncStorage.getAllKeys()
  const start = journalCursor ? all.indexOf(journalCursor) + 1 : 0
  const batch: string[] = []
  for (let i = 0; i < all.length; i++) {
    const key = all[(start + i) % all.length]
    if (!key.startsWith(obsoletePartsPrefix)) continue
    if (batch.length === JOURNALS_PER_SWEEP) return { batch, more: true }
    batch.push(key)
  }
  return { batch, more: false }
}
const recoverObsoleteParts = async() => {
  if (obsoleteRecovery !== null || !scanNeeded || Date.now() < Math.max(nextScan, blockedUntil)) return
  scanNeeded = false
  obsoleteRecovery = (async() => {
    try {
      const { batch, more } = await selectJournalBatch()
      if (more) { scanNeeded = true; nextScan = Date.now() + SWEEP_INTERVAL }
      for (const key of batch) {
        journalCursor = key
        const [[, raw]] = await readStorageValues([key])
        if (raw == null) continue
        const parts = parseData<unknown>(raw, key)
        if (!Array.isArray(parts) || !parts.every(p => typeof p === 'string' && p !== key)) throw new Error('Invalid fragment cleanup journal')
        // Delete the journal last; a partial failure is safe to retry after restart.
        await removeStorageValues([...parts, key])
      }
      if (Date.now() >= blockedUntil) retryDelay = SWEEP_INTERVAL
      if (!scanNeeded) journalCursor = undefined
    } catch (error) { deferCleanup(error) }
  })().finally(() => { obsoleteRecovery = null })
  await obsoleteRecovery
}

// 同一逻辑键的读取、覆盖和删除串行，读旧索引期间不能清理它引用的分片。
const operations = new Map<string, Promise<void>>()
let barrier: Promise<void> = Promise.resolve()
const withKeys = async<T>(keys: readonly string[], work: () => Promise<T>): Promise<T> => {
  const uniqueKeys = [...new Set(keys)]
  const previous = [barrier]
  for (const key of uniqueKeys) {
    const pending = operations.get(key)
    if (pending) previous.push(pending)
  }
  const result = Promise.all(previous).then(work)
  const settled = result.then(() => {}, () => {})
  for (const key of uniqueKeys) operations.set(key, settled)
  void settled.then(() => {
    for (const key of uniqueKeys) if (operations.get(key) === settled) operations.delete(key)
  })
  return result
}
const withAllKeys = async<T>(work: () => Promise<T>): Promise<T> => {
  const result = Promise.all([barrier, ...operations.values()]).then(work)
  barrier = result.then(() => {}, () => {})
  return result
}

const buildData = (key: string, value: any, datas: Array<[string, string]>) => {
  let valueStr = JSON.stringify(value)
  if (valueStr.length <= limit) {
    datas.push([key, valueStr])
    return
  }

  const partKeys = []
  const version = `${partNamespace}_${++partSequence}`
  for (let i = 0; i * limit < valueStr.length; i++) {
    let partKey = `${partKeyArrPrefix}${key}__${version}_${i}`
    partKeys.push(partKey)
    datas.push([partKey, valueStr.substring(i * limit, (i + 1) * limit)])
  }
  datas.push([key, partKeyArrPrefix + JSON.stringify(partKeys)])
}

const parseData = <T>(value: string, key?: string): T | null => {
  try {
    return JSON.parse(value)
  } catch (e: any) {
    // 仅 JSON 损坏按缺失处理；存储读取失败必须继续抛出，避免空列表覆盖原数据
    log.error('storage error[parseData]:', key ?? '', e.message)
    return null
  }
}

// 读失败会向上抛（避免空列表覆盖原数据），但 SQLite 锁/IO 抖动往往是瞬时的：
// 先短暂重试几次，别让一次抖动直接把初始化打挂
const READ_RETRY_TIMES = 2
const READ_RETRY_DELAY = 100
const readWithRetry = async<T>(read: () => Promise<T>): Promise<T> => {
  let lastError: unknown
  for (let attempt = 0; attempt <= READ_RETRY_TIMES; attempt++) {
    try {
      return await read()
    } catch (error) {
      lastError = error
      if (attempt < READ_RETRY_TIMES) {
        await new Promise<void>(resolve => { setTimeout(resolve, READ_RETRY_DELAY * (attempt + 1)) })
      }
    }
  }
  throw lastError
}

const readStorageValues = async(keys: readonly string[]): Promise<Array<[string, string | null]>> => {
  const rows: Array<[string, string | null]> = []
  for (let offset = 0; offset < keys.length; offset += SQL_KEY_BATCH_SIZE) {
    const batch = keys.slice(offset, offset + SQL_KEY_BATCH_SIZE)
    const values = await readWithRetry(async() => {
      const reading = AsyncStorage.multiGet(batch)
      // Concurrent multiGet calls otherwise merge back into an oversized native query.
      AsyncStorage.flushGetRequests?.()
      return reading
    })
    rows.push(...values)
  }
  return rows
}

const removeStorageValues = async(keys: readonly string[]) => {
  for (let offset = 0; offset < keys.length; offset += SQL_KEY_BATCH_SIZE) {
    await AsyncStorage.multiRemove(keys.slice(offset, offset + SQL_KEY_BATCH_SIZE))
  }
}

// 1.4.0 之前的数据分片存储方式，存在key的内容与分隔符冲突的问题
// 1.4.0 开始改用数组存储，不再使用分隔符的方式
const handleGetDataOld = async<T>(partKeys: string, key: string): Promise<T | null> => {
  const keys = partKeys.replace(partKeyPrefixRxp, '').split(keySplit)

  return readStorageValues(keys).then(datas => {
    return parseData<T>(datas.map(data => data[1]).join(''), key)
  })
}

const handleGetData = async<T>(partKeys: string, key: string): Promise<T | null> => {
  if (partKeys.startsWith(partKeyPrefix)) return handleGetDataOld<T>(partKeys, key)

  const keys = parseData<unknown>(partKeys.replace(partKeyArrPrefixRxp, ''), key)
  if (!Array.isArray(keys) || !keys.every((key): key is string => typeof key === 'string')) return null
  return readStorageValues(keys).then(datas => {
    return parseData<T>(datas.map(data => data[1]).join(''), key)
  })
}

const getPartKeys = (value: string | null, key: string): string[] => {
  if (value == null) return []
  if (partKeyPrefixRxp.test(value)) return value.replace(partKeyPrefixRxp, '').split(keySplit)
  if (!partKeyArrPrefixRxp.test(value)) return []
  const parsed = parseData<unknown>(value.replace(partKeyArrPrefixRxp, ''), key)
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
}

const replaceData = async(datas: Array<[string, any]>) => {
  if (!datas.length) return
  const unique = [...new Map(datas)]
  const keys = unique.map(([key]) => key)
  return withKeys(keys, async() => {
    await recoverObsoleteParts()
    const values: Array<[string, string]> = []
    for (const [key, value] of unique) buildData(key, value, values)
    const previous = await readStorageValues(keys)
    const oldParts = previous.flatMap(([key, value]) => getPartKeys(value, key))
    const cleanupKey = oldParts.length ? `${obsoletePartsPrefix}${partNamespace}_${++partSequence}` : null
    if (cleanupKey) values.push([cleanupKey, JSON.stringify(oldParts)])
    // Android multiSet 在同一个 SQLite 事务中提交新分片与索引；失败保留旧值。
    await AsyncStorage.multiSet(values)
    if (cleanupKey) {
      if (Date.now() < blockedUntil) { scanNeeded = true; return }
      try { await removeStorageValues([...oldParts, cleanupKey]) } catch (error) { deferCleanup(error) }
    }
  })
}

export const saveData = async(key: string, value: any) => {
  try {
    await replaceData([[key, value]])
  } catch (e: any) {
    log.error('storage error[saveData]:', key, e.message)
    throw e
  }
}

/**
 * 小值直写：不做分片，也不走 remove→set。
 * 仅用于确定不会超过 500k 的小对象（例如歌单歌曲索引），单 key setItem 是原子的。
 */
export const saveDataDirect = async(key: string, value: any) => {
  try {
    await withKeys([key], async() => AsyncStorage.setItem(key, JSON.stringify(value)))
  } catch (e: any) {
    log.error('storage error[saveDataDirect]:', key, e.message)
    throw e
  }
}

/** 确定小于分片上限的独立记录，批量原子替换各 key，不先删除旧值。 */
export const saveDataMultipleDirect = async(datas: Array<[string, unknown]>) => {
  if (!datas.length) return
  await withKeys(datas.map(([key]) => key), async() => {
    const values: Array<[string, string]> = datas.map(([key, value]) => {
      const json = JSON.stringify(value)
      if (json.length > limit) throw new Error('Direct storage value is too large: ' + key)
      return [key, json]
    })
    await AsyncStorage.multiSet(values)
  })
}

export const removeDataMultipleDirect = async(keys: string[]) => {
  if (keys.length) await withKeys(keys, async() => removeStorageValues(keys))
}

export const getData = async<T = unknown>(key: string): Promise<T | null> => withKeys([key], async() => {
  await recoverObsoleteParts()
  let value: string | null
  try {
    value = await readWithRetry(async() => AsyncStorage.getItem(key))
  } catch (e: any) {
    // error reading value
    log.error('storage error[getData]:', key, e.message)
    throw e
  }
  if (value == null) return null
  if (partKeyPrefixRxp.test(value) || partKeyArrPrefixRxp.test(value)) {
    return handleGetData<T>(value, key)
  }
  return parseData<T>(value, key)
})

export const removeData = async(key: string) => {
  try {
    await removeDataMultiple([key])
  } catch (e: any) {
    // remove error
    log.error('storage error[removeData]:', key, e.message)
    throw e
  }
}

export const getAllKeys = async() => withAllKeys(async() => {
  let keys
  try {
    keys = await AsyncStorage.getAllKeys()
  } catch (e: any) {
    // read key error
    log.error('storage error[getAllKeys]:', e.message)
    throw e
  }

  return keys
})


export const getDataMultiple = async<T extends readonly string[]>(keys: T) => withKeys(keys, async() => {
  type RawData = { [K in keyof T]: [T[K], string | null] }
  let datas: RawData
  try {
    datas = await readStorageValues(keys) as RawData
  } catch (e: any) {
    // read error
    log.error('storage error[getDataMultiple]:', e.message)
    throw e
  }
  const promises: Array<Promise<unknown>> = []
  for (const [key, value] of datas) {
    if (value == null || value === '') {
      promises.push(Promise.resolve(value))
      continue
    }
    if (partKeyPrefixRxp.test(value) || partKeyArrPrefixRxp.test(value)) {
      promises.push(handleGetData(value, key))
      continue
    }
    promises.push(Promise.resolve(parseData(value, key)))
  }
  return Promise.all(promises).then(values => {
    return datas.map(([key], index) => ([key, values[index]])) as { [K in keyof T]: [T[K], unknown] }
  })
})

export const saveDataMultiple = async(datas: Array<[string, any]>) => {
  try {
    await replaceData(datas)
  } catch (e: any) {
    // save error
    log.error('storage error[saveDataMultiple]:', e.message)
    throw e
  }
}


export const removeDataMultiple = async(keys: string[]) => {
  if (!keys.length) return
  try {
    await withKeys(keys, async() => {
      const datas = await readStorageValues(keys)
      let batch: string[] = []
      for (const [key, value] of datas) {
        const group = [...new Set([...getPartKeys(value, key), key])]
        if (batch.length + group.length > SQL_KEY_BATCH_SIZE) {
          await removeStorageValues(batch)
          batch = []
        }
        if (group.length > SQL_KEY_BATCH_SIZE) {
          // Remove the index last so a failed oversized deletion retains all paths for retry.
          await removeStorageValues(group)
        } else batch.push(...group)
      }
      // Keep each logical value and its fragments in one transaction whenever they fit.
      await removeStorageValues(batch)
    })
  } catch (e: any) {
    // remove error
    log.error('storage error[removeDataMultiple]:', e.message)
    throw e
  }
}

export const clearAll = async() => withAllKeys(async() => {
  try {
    await AsyncStorage.clear()
    scanNeeded = false
    nextScan = blockedUntil = 0
    retryDelay = SWEEP_INTERVAL
    journalCursor = undefined
  } catch (e: any) {
    // clear error
    log.error('storage error[clearAll]:', e.message)
    throw e
  }
})

export { useAsyncStorage } from '@react-native-async-storage/async-storage'
