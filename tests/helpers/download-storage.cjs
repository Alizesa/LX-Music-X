const { load } = require('./load.cjs')
const constants = load('src/config/constant.ts')

const indexKey = '@download_active_index'
const itemPrefix = '@download_active_item__'
const legacyKey = constants.storageDataPrefix.downloadTasksActive
const keyFor = id => itemPrefix + encodeURIComponent(id)
const harness = (initial = []) => {
  const values = new Map(initial)
  const writes = []
  const native = {
    getItem: async key => values.get(key) ?? null,
    multiGet: async keys => keys.map(key => [key, values.get(key) ?? null]),
    setItem: async(key, value) => { values.set(key, value) },
    multiSet: async items => { writes.push(items.map(item => [...item])); items.forEach(([key, value]) => values.set(key, value)) },
    multiRemove: async keys => { keys.forEach(key => values.delete(key)) },
    getAllKeys: async() => [...values.keys()],
  }
  const storage = load('src/plugins/storage.ts', {
    '@react-native-async-storage/async-storage': { default: native }, '@/utils/log': { log: { error() {} } },
  })
  const createData = () => load('src/utils/data.ts', {
    '@/plugins/storage': storage,
    '@/config/constant': constants,
    './legacyList': {},
    './common': { throttle: () => () => {} },
    './nativeModules/secureStorage': {},
  })
  return { data: createData(), createData, storage, native, values, writes }
}

module.exports = { harness, indexKey, itemPrefix, legacyKey, keyFor, constants }
