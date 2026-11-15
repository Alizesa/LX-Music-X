const { load, flush } = require('./load.cjs')

const constants = load('src/config/constant.ts')
const historyKey = constants.storageDataPrefix.playHistory
const summaryKey = historyKey + '_summary'
const harness = initial => {
  const values = new Map(initial)
  const reads = []; const writes = []; const decoded = []
  const native = {
    getItem: async key => { reads.push(key); return values.get(key) ?? null },
    multiGet: async keys => keys.map(key => [key, values.get(key) ?? null]),
    multiSet: async entries => { writes.push(entries); entries.forEach(([key, value]) => values.set(key, value)) },
    multiRemove: async keys => { keys.forEach(key => values.delete(key)) },
    getAllKeys: async() => [...values.keys()],
  }
  const storage = load('src/plugins/storage.ts', {
    '@react-native-async-storage/async-storage': { default: native },
    '@/utils/log': { log: { error() {} } },
  }, {
    JSON: {
      stringify: JSON.stringify,
      parse: value => { const parsed = JSON.parse(value); if (Array.isArray(parsed)) decoded.push(new WeakRef(parsed)); return parsed },
    },
  })
  const scheduled = load('src/utils/scheduledTask.ts')
  let sequence = 0
  const tasks = new Map()
  const clock = { setTimeout: callback => { tasks.set(++sequence, callback); return sequence }, clearTimeout: id => tasks.delete(id) }
  const createData = () => load('src/utils/data.ts', {
    '@/plugins/storage': storage,
    '@/config/constant': constants,
    './legacyList': {},
    './common': { throttle: (fn, ms) => scheduled.createScheduledTask(fn, ms, false, clock) },
    './nativeModules/secureStorage': {},
  })
  const run = async() => {
    for (const [id, callback] of [...tasks]) { tasks.delete(id); callback() }
    await flush()
  }
  return { api: createData(), createData, native, values, reads, writes, decoded, run, tasks }
}
const item = (id, source = 'kw', extra = {}) => ({ musicInfo: { id, source, name: `Song ${id}`, meta: extra }, playedAt: 1 })
module.exports = { harness, historyKey, summaryKey, item }
