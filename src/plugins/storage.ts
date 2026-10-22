import AsyncStorage from '@react-native-async-storage/async-storage'
import { log } from '@/utils/log'

const partKeyPrefix = '@___PART___'
const partKeyArrPrefix = '@___PART_A___'
const partKeyPrefixRxp = /^@___PART___/
const partKeyArrPrefixRxp = /^@___PART_A___/
const keySplit = ','
const limit = 500000

const buildData = (key: string, value: any, datas: Array<[string, string]>) => {
  let valueStr = JSON.stringify(value)
  if (valueStr.length <= limit) {
    datas.push([key, valueStr])
    return
  }

  const partKeys = []
  for (let i = 0, len = Math.floor(valueStr.length / limit); i <= len; i++) {
    let partKey = `${partKeyArrPrefix}${key}${i}`
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

// 1.4.0 之前的数据分片存储方式，存在key的内容与分隔符冲突的问题
// 1.4.0 开始改用数组存储，不再使用分隔符的方式
const handleGetDataOld = async<T>(partKeys: string, key: string): Promise<T | null> => {
  const keys = partKeys.replace(partKeyPrefixRxp, '').split(keySplit)

  return readWithRetry(async() => AsyncStorage.multiGet(keys)).then(datas => {
    return parseData<T>(datas.map(data => data[1]).join(''), key)
  })
}

const handleGetData = async<T>(partKeys: string, key: string): Promise<T | null> => {
  if (partKeys.startsWith(partKeyPrefix)) return handleGetDataOld<T>(partKeys, key)

  const keys = parseData<unknown>(partKeys.replace(partKeyArrPrefixRxp, ''), key)
  if (!Array.isArray(keys) || !keys.every((key): key is string => typeof key === 'string')) return null
  return readWithRetry(async() => AsyncStorage.multiGet(keys)).then(datas => {
    return parseData<T>(datas.map(data => data[1]).join(''), key)
  })
}

export const saveData = async(key: string, value: any) => {
  const datas: Array<[string, string]> = []
  buildData(key, value, datas)

  try {
    await removeData(key)
    await AsyncStorage.multiSet(datas)
  } catch (e: any) {
    // saving error
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
    await AsyncStorage.setItem(key, JSON.stringify(value))
  } catch (e: any) {
    log.error('storage error[saveDataDirect]:', key, e.message)
    throw e
  }
}

export const getData = async<T = unknown>(key: string): Promise<T | null> => {
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
}

export const removeData = async(key: string) => {
  let value: string | null
  try {
    value = await AsyncStorage.getItem(key)
  } catch (e: any) {
    // error reading value
    log.error('storage error[removeData]:', key, e.message)
    throw e
  }
  if (value) {
    if (partKeyPrefixRxp.test(value)) {
      let partKeys = value.replace(partKeyPrefixRxp, '').split(keySplit)
      partKeys.push(key)
      try {
        await AsyncStorage.multiRemove(partKeys)
      } catch (e: any) {
        // remove error
        log.error('storage error[removeData]:', key, e.message)
        throw e
      }
      return
    } else if (partKeyArrPrefixRxp.test(value)) {
      let partKeys: string[] = []
      try {
        const parsed: unknown = JSON.parse(value.replace(partKeyArrPrefixRxp, ''))
        if (Array.isArray(parsed)) partKeys = parsed.filter((item): item is string => typeof item === 'string')
      } catch (e: any) {
        // 引用本身损坏（例如写入途中被杀）：分片 key 已无从得知，只删主 key
        log.error('storage error[removeData parse]:', key, e.message)
      }
      partKeys.push(key)
      try {
        await AsyncStorage.multiRemove(partKeys)
      } catch (e: any) {
        // remove error
        log.error('storage error[removeData]:', key, e.message)
        throw e
      }
      return
    }
  }

  try {
    await AsyncStorage.removeItem(key)
  } catch (e: any) {
    // remove error
    log.error('storage error[removeData]:', key, e.message)
    throw e
  }
}

export const getAllKeys = async() => {
  let keys
  try {
    keys = await AsyncStorage.getAllKeys()
  } catch (e: any) {
    // read key error
    log.error('storage error[getAllKeys]:', e.message)
    throw e
  }

  return keys
}


export const getDataMultiple = async<T extends readonly string[]>(keys: T) => {
  type RawData = { [K in keyof T]: [T[K], string | null] }
  let datas: RawData
  try {
    datas = await readWithRetry(async() => AsyncStorage.multiGet(keys)) as RawData
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
}

export const saveDataMultiple = async(datas: Array<[string, any]>) => {
  const allData: Array<[string, string]> = []
  for (const [key, value] of datas) {
    buildData(key, value, allData)
  }
  try {
    await removeDataMultiple(datas.map(k => k[0]))
    await AsyncStorage.multiSet(allData)
  } catch (e: any) {
    // save error
    log.error('storage error[saveDataMultiple]:', e.message)
    throw e
  }
}


export const removeDataMultiple = async(keys: string[]) => {
  if (!keys.length) return
  const datas = await AsyncStorage.multiGet(keys)
  let allKeys = []
  for (const [key, value] of datas) {
    allKeys.push(key)
    if (value) {
      if (partKeyPrefixRxp.test(value)) {
        allKeys.push(...value.replace(partKeyPrefixRxp, '').split(keySplit))
      } else if (partKeyArrPrefixRxp.test(value)) {
        try {
          const parsed: unknown = JSON.parse(value.replace(partKeyArrPrefixRxp, ''))
          if (Array.isArray(parsed)) {
            allKeys.push(...parsed.filter((item): item is string => typeof item === 'string'))
          }
        } catch (e: any) {
          // 坏引用：主 key 已在上面加入 allKeys，分片 key 无从得知，跳过
          log.error('storage error[removeDataMultiple parse]:', key, e.message)
        }
      }
    }
  }
  try {
    await AsyncStorage.multiRemove(allKeys)
  } catch (e: any) {
    // remove error
    log.error('storage error[removeDataMultiple]:', e.message)
    throw e
  }
}

export const clearAll = async() => {
  try {
    await AsyncStorage.clear()
  } catch (e: any) {
    // clear error
    log.error('storage error[clearAll]:', e.message)
    throw e
  }
}

export { useAsyncStorage } from '@react-native-async-storage/async-storage'
