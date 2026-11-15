import { NativeEventEmitter, NativeModules } from 'react-native'

const { UserApiModule } = NativeModules

const loadedScripts = new Map<string, { info: LX.UserApi.UserApiInfo, nativeId: string, generation: number }>()
let nextGeneration = 0
export const supportsIsolatedUserApi = () => typeof UserApiModule.loadScriptForRuntime == 'function'
export const getScriptGeneration = (runtimeId = 'main') => loadedScripts.get(runtimeId)?.generation ?? 0
export const loadScript = (info: LX.UserApi.UserApiInfo & { script: string }, runtimeId = 'main') => {
  if (loadedScripts.has(runtimeId)) destroy(runtimeId)
  const generation = ++nextGeneration
  // 主音源也使用独立代次，旧线程排队中的 init/response 不能冒充新脚本。
  const nativeId = runtimeId === 'main' && supportsIsolatedUserApi() ? `main_${generation}` : runtimeId
  loadedScripts.set(runtimeId, { info, nativeId, generation })
  const data = {
    id: info.id,
    name: info.name,
    description: info.description,
    version: info.version ?? '',
    author: info.author ?? '',
    homepage: info.homepage ?? '',
    script: info.script,
  }
  if (nativeId == 'main') UserApiModule.loadScript(data)
  else UserApiModule.loadScriptForRuntime(nativeId, data)
}

/** 取消的 handler 无法结束时重建上下文，保留用户选择代次，换 native ID 隔离迟到事件。 */
export const restartScriptContext = (runtimeId = 'main') => {
  const previous = loadedScripts.get(runtimeId)
  const info = previous?.info as (LX.UserApi.UserApiInfo & { script?: string }) | undefined
  if (!previous || !info || typeof info.script !== 'string' || !supportsIsolatedUserApi()) return false
  const nativeId = `${runtimeId}_${++nextGeneration}`
  loadedScripts.set(runtimeId, { ...previous, nativeId })
  if (previous.nativeId === 'main') UserApiModule.destroy()
  else UserApiModule.destroyRuntime(previous.nativeId)
  UserApiModule.loadScriptForRuntime(nativeId, {
    id: info.id,
    name: info.name,
    description: info.description,
    version: info.version ?? '',
    author: info.author ?? '',
    homepage: info.homepage ?? '',
    script: info.script,
  })
  return true
}

export interface SendResponseParams {
  requestKey: string
  error: string | null
  response: {
    statusCode: number
    statusMessage: string
    headers: Record<string, string>
    body: any
  } | null
}
export interface SendActions {
  request: LX.UserApi.UserApiRequestParams
  response: SendResponseParams
  /** App → 脚本：取消一个在途请求，值是 requestKey */
  cancelRequest: string
}
export const sendAction = <T extends keyof SendActions>(action: T, data: SendActions[T], runtimeId = 'main') => {
  const nativeId = loadedScripts.get(runtimeId)?.nativeId
  if (!nativeId) return
  if (nativeId == 'main') UserApiModule.sendAction(action, JSON.stringify(data))
  else UserApiModule.sendActionForRuntime(nativeId, action, JSON.stringify(data))
}

// export const clearAppCache = CacheModule.clearAppCache as () => Promise<void>

export interface InitParams {
  status: boolean
  errorMessage: string
  info: LX.UserApi.UserApiInfo
}

export interface ResponseParams {
  status: boolean
  errorMessage?: string
  requestKey: string
  result: any
}
export interface UpdateInfoParams {
  name: string
  log: string
  updateUrl: string
}
export interface RequestParams {
  requestKey: string
  parentRequestKey?: string | null
  url: string
  options: {
    method: string
    data: any
    timeout: number
    headers: any
    binary: boolean
  }
}
export type CancelRequestParams = string

export interface Actions {
  init: InitParams
  request: RequestParams
  cancelRequest: CancelRequestParams
  response: ResponseParams
  requestSettled: string
  showUpdateAlert: UpdateInfoParams
  log: string
}
export type ActionsEvent = { [K in keyof Actions]: { action: K, data: Actions[K] } }[keyof Actions]

export const onScriptAction = (handler: (event: ActionsEvent) => void, runtimeId = 'main'): () => void => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  const eventEmitter = new NativeEventEmitter(UserApiModule)
  const eventListener = eventEmitter.addListener('api-action', event => {
    const script = loadedScripts.get(runtimeId)
    if (!script || (event.runtimeId ?? 'main') != script.nativeId) return
    const loadScriptInfo = script.info
    if (event.data) event.data = JSON.parse(event.data as string)
    if (event.action == 'init') {
      if (event.data.info) event.data.info = { ...loadScriptInfo, ...event.data.info }
      else event.data.info = { ...loadScriptInfo }
    } else if (event.action == 'showUpdateAlert') {
      if (!loadScriptInfo?.allowShowUpdateAlert) return
    }
    handler(event as ActionsEvent)
  })

  return () => {
    eventListener.remove()
  }
}

export const destroy = (runtimeId = 'main') => {
  const nativeId = loadedScripts.get(runtimeId)?.nativeId ?? runtimeId
  loadedScripts.delete(runtimeId)
  if (nativeId == 'main') UserApiModule.destroy()
  else UserApiModule.destroyRuntime(nativeId)
}
