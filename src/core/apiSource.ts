// import { setUserApi as setUserApiAction } from '@renderer/utils/ipc'
import musicSdk from '@/utils/musicSdk'
// import apiSourceInfo from '@renderer/utils/musicSdk/api-source-info'
import { updateSetting } from './common'
import settingState from '@/store/setting/state'
import { destroyUserApi, setUserApi, setUserApiStatus } from './userApi'
import apiSourceInfo from '@/utils/musicSdk/api-source-info'
import { state as userApiState } from '@/store/userApi'
import { resolveApiSourceOrder } from '@/utils/apiSourceOrder'

export const getApiSourceOrder = () => resolveApiSourceOrder(
  settingState.setting['common.apiSourceOrder'],
  settingState.setting['common.apiSource'],
  userApiState.list,
)

export const setApiSourceOrder = (ids: string[]) => {
  const order = [...new Set(ids)].filter(id => userApiState.list.some(api => api.id == id))
  updateSetting({ 'common.apiSourceOrder': JSON.stringify(order) })
  if (settingState.setting['common.apiSource'] != (order[0] ?? '')) setApiSource(order[0] ?? '')
}


let sourceGeneration = 0
export const setApiSource = (apiId: string) => {
  // 每次选择都有自己的初始化 Promise；释放旧等待者，避免 A→B→A 复用旧初始化。
  if (!global.lx.apiInitPromise[1]) global.lx.apiInitPromise[2](false)
  const generation = ++sourceGeneration
  global.lx.apiInitPromise[0] = new Promise(resolve => {
    global.lx.apiInitPromise[1] = false
    global.lx.apiInitPromise[2] = (result: boolean) => {
      if (generation !== sourceGeneration) return
      global.lx.apiInitPromise[1] = true
      resolve(result)
    }
  })
  if (apiId != settingState.setting['common.apiSource']) updateSetting({ 'common.apiSource': apiId })
  if (/^user_api/.test(apiId)) {
    setUserApi(apiId).catch(err => {
      if (generation !== sourceGeneration) return
      if (!global.lx.apiInitPromise[1]) global.lx.apiInitPromise[2](false)
      setUserApiStatus(false, err instanceof Error ? err.message : String(err))
      console.log(err)
      let api = apiSourceInfo.find(api => !api.disabled)
      if (!api) return
      if (api.id != settingState.setting['common.apiSource']) setApiSource(api.id)
    })
  } else {
    // @ts-expect-error
    global.lx.qualityList = musicSdk.supportQuality[apiId] ?? {}
    destroyUserApi()
    if (!global.lx.apiInitPromise[1]) global.lx.apiInitPromise[2](true)
    // apiSource.value = apiId
    // void setUserApiAction(apiId)
  }

  global.state_event.apiSourceUpdated(apiId)
}

