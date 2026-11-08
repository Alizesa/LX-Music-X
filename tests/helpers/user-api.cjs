const { load, deferred, flush } = require('./load.cjs')

const Event = load('src/event/Event.ts', {}, { setImmediate }).default
const { createStateEventHub } = load('src/event/stateEvent.ts', { './Event': { default: Event } })
const message = load('src/utils/message.ts')
const song = { id: 'kw_song', source: 'kw', name: 'Song', singer: 'Singer', interval: '03:00', meta: { _qualitys: { '128k': {}, flac: {} } } }

const userApiHarness = async({ scripts = {}, autoReply = true, appGlobal, setting: suppliedSetting } = {}) => {
  const setting = suppliedSetting ?? { 'common.apiSource': '', 'common.apiSourceOrder': '[]' }
  const state = { list: ['user_api_A', 'user_api_B'].map(id => ({ id, name: id, allowShowUpdateAlert: false })), status: {} }
  const globalState = appGlobal ?? { state_event: createStateEventHub(), lx: {}, i18n: { t: key => key } }
  Object.assign(globalState.lx, { qualityList: {}, apis: {}, apiInitPromise: [Promise.resolve(false), true, () => {}] })
  const loads = [], sends = [], destroyed = [], listeners = new Set(), timers = new Map()
  let timerId = 0
  const clock = { setTimeout: fn => { timers.set(++timerId, fn); return timerId }, clearTimeout: id => timers.delete(id) }
  const emit = (runtimeId, action, data) => {
    for (const listener of listeners) listener({ runtimeId, action, data: JSON.stringify(data) })
  }
  const native = {
    loadScript: info => loads.push({ runtimeId: 'main', info }),
    loadScriptForRuntime: (runtimeId, info) => loads.push({ runtimeId, info }),
    sendAction: (action, data) => native.sendActionForRuntime('main', action, data),
    sendActionForRuntime: (runtimeId, action, raw) => {
      const data = JSON.parse(raw)
      sends.push({ runtimeId, action, data })
      if (autoReply && action === 'request') setImmediate(() => emit(runtimeId, 'response', { requestKey: data.requestKey, status: true, result: { data: { url: `https://audio.test/${loads.find(item => item.runtimeId === runtimeId)?.info.id}` } } }))
    },
    destroy: () => destroyed.push('main'), destroyRuntime: id => destroyed.push(id),
  }
  const bridge = load('src/utils/nativeModules/userApi.ts', { 'react-native': {
    NativeModules: { UserApiModule: native }, NativeEventEmitter: class { addListener(name, callback) { listeners.add(callback); return { remove: () => listeners.delete(callback) } } },
  } })
  const data = { getUserApiList: async() => state.list, getUserApiScript: async id => scripts[id] ? scripts[id].promise : `${id} script` }
  const apiProxy = {}
  const core = load('src/core/userApi.ts', {
    '@/store/userApi': { state, action: { setStatus: (status, message) => { state.status = { status, message } }, setUserApiList: list => { state.list = list } } },
    '@/utils/data': data, '@/utils/nativeModules/userApi': bridge, '@/utils/log': {}, './apiSource': apiProxy,
  }, { global: globalState })
  const api = load('src/core/apiSource.ts', {
    '@/utils/musicSdk': { default: { supportQuality: {} } }, './common': { updateSetting: values => { Object.assign(setting, values); globalState.state_event.configUpdated(Object.keys(values), values) } },
    '@/store/setting/state': { default: { setting } }, './userApi': core, '@/utils/musicSdk/api-source-info': { default: [] },
    '@/store/userApi': { state }, '@/utils/apiSourceOrder': load('src/utils/apiSourceOrder.ts'),
  }, { global: globalState, requestAnimationFrame: fn => setImmediate(fn) })
  Object.assign(apiProxy, api)
  const http = []
  const fetchData = () => {
    const result = deferred()
    const request = { request: result.promise, aborted: false, abort() { request.aborted = true; result.reject(new Error(message.requestMsg.cancelRequest)) }, result }
    http.push(request)
    return request
  }
  await load('src/core/init/userApi/index.ts', {
    '@/utils/nativeModules/userApi': bridge, '@/core/userApi': core, '@/store/setting/state': { default: { setting } },
    'react-native-background-timer': { default: clock }, './request': { fetchData }, '@/utils/data': data,
    '@/utils/tools': { tipDialog: async() => {} }, '@/utils/message': message,
  }, { global: globalState }).default(setting)
  const runtime = load('src/core/userApiRuntime.ts', {
    'react-native-background-timer': { default: clock }, '@/store/userApi': { state }, '@/store/setting/state': { default: { setting } },
    '@/utils/data': data, '@/utils': { toOldMusicInfo: music => music }, '@/utils/message': message,
    '@/utils/nativeModules/userApi': bridge, '@/core/init/userApi/request': { fetchData },
  }, { global: globalState })
  const initialize = (entry = loads.at(-1), qualitys = ['128k']) => emit(entry.runtimeId, 'init', { status: true, info: { sources: { kw: { type: 'music', actions: ['musicUrl'], qualitys } } } })
  return { api, core, bridge, runtime, global: globalState, setting, state, loads, sends, destroyed, emit, initialize, http, timers }
}

module.exports = { userApiHarness, song, deferred, flush, message }
