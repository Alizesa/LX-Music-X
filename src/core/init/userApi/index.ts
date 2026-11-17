import { getScriptGeneration, restartScriptContext, type InitParams, onScriptAction, sendAction, type ResponseParams, type UpdateInfoParams, type RequestParams } from '@/utils/nativeModules/userApi'
import { log, setUserApiList, setUserApiStatus } from '@/core/userApi'
import settingState from '@/store/setting/state'
import BackgroundTimer from 'react-native-background-timer'
import { fetchData } from './request'
import { getUserApiList } from '@/utils/data'
import { confirmDialog, openUrl, tipDialog } from '@/utils/tools'
import { requestMsg } from '@/utils/message'
import { waitForPromise } from '@/utils/abortable'


export default async(setting: LX.AppSetting, { suppressDialogs = () => false }: { suppressDialogs?: () => boolean } = {}) => {
  // 读失败可安全重试，不能留下半套重复监听。
  const userApis = await getUserApiList()
  const userApiRequestMap = new Map<string, { resolve: (value: ResponseParams['result']) => void, reject: (error: Error) => void, timeout: number | null, onDispatch?: () => void, generation: number, data: LX.UserApi.UserApiRequestParams | null }>()
  const scriptRequestMap = new Map<string, { request: Promise<any>, abort: () => void, generation: number, parentRequestKey: string | null, controller: AbortController }>()
  let activeRequestKey: string | null = null
  let restarting = false
  let restartGeneration: number | null = null
  let cancelDeadline: number | null = null
  let restartDeadline: number | null = null
  const clearDeadline = (timeout: number | null) => { if (timeout !== null) BackgroundTimer.clearTimeout(timeout) }
  const clearRestartDeadline = () => { clearDeadline(restartDeadline); restartDeadline = null }
  const clearCancelDeadline = () => {
    if (cancelDeadline !== null) BackgroundTimer.clearTimeout(cancelDeadline)
    cancelDeadline = null
  }
  const failPending = (error: Error) => {
    for (const [key, request] of userApiRequestMap) {
      userApiRequestMap.delete(key)
      clearDeadline(request.timeout)
      request.reject(error)
    }
  }
  const dispatchNext = () => {
    if (activeRequestKey !== null || restarting) return
    for (const [key, request] of userApiRequestMap) {
      if (!request.data) continue
      if (request.generation !== getScriptGeneration()) {
        userApiRequestMap.delete(key)
        clearDeadline(request.timeout)
        request.reject(new Error(requestMsg.cancelRequest))
        continue
      }
      activeRequestKey = key
      const data = request.data
      request.data = null
      try {
        request.timeout = BackgroundTimer.setTimeout(() => { cancelUserApiRequest(key, new Error('request timeout')) }, 20_000)
        request.onDispatch?.()
        request.onDispatch = undefined
        sendAction('request', data)
      } catch (error) {
        activeRequestKey = null
        userApiRequestMap.delete(key)
        clearDeadline(request.timeout)
        request.reject(error instanceof Error ? error : new Error(String(error)))
        continue
      }
      break
    }
  }

  const cancelRequest = (requestKey: string, message: string) => {
    const target = scriptRequestMap.get(requestKey)
    if (!target) return
    scriptRequestMap.delete(requestKey)
    target.controller.abort()
    target.abort()
  }
  /** App → 脚本的请求取消：清超时、通知脚本抑制迟到响应，并让调用方立刻 reject */
  const cancelUserApiRequest = (requestKey: string, error = new Error(requestMsg.cancelRequest)) => {
    const target = userApiRequestMap.get(requestKey)
    if (!target) return
    userApiRequestMap.delete(requestKey)
    clearDeadline(target.timeout)
    if (activeRequestKey === requestKey) {
      for (const [key, request] of scriptRequestMap) if (request.parentRequestKey === requestKey) cancelRequest(key, 'parent canceled')
      try { if (target.generation === getScriptGeneration()) sendAction('cancelRequest', requestKey) } catch {}
      clearCancelDeadline()
      const generation = target.generation
      cancelDeadline = BackgroundTimer.setTimeout(() => {
        cancelDeadline = null
        if (activeRequestKey !== requestKey || generation !== getScriptGeneration()) return
        activeRequestKey = null
        restarting = true
        restartGeneration = generation
        // 主环境一次只处理一个业务请求；尚未分派的消费者没有 HTTP，可安全摘掉旧上下文的初始化工作。
        for (const key of scriptRequestMap.keys()) cancelRequest(key, 'context restart')
        try {
          if (restartScriptContext()) {
            restartDeadline = BackgroundTimer.setTimeout(() => {
              restartDeadline = null
              if (!restarting || generation !== getScriptGeneration()) return
              restarting = false
              global.lx.apis = {}
              const error = new Error('Source recovery timeout')
              setUserApiStatus(false, error.message)
              failPending(error)
            }, 12_000)
            return
          }
          throw new Error('Canceled source requires an updated app')
        } catch (error) {
          restarting = false
          global.lx.apis = {}
          const failure = error instanceof Error ? error : new Error(String(error))
          setUserApiStatus(false, failure.message)
          failPending(failure)
        }
      }, 100)
    }
    target.reject(error)
  }
  const sendScriptRequest = (requestKey: string, url: string, options: RequestParams['options'], parentRequestKey: string | null = activeRequestKey) => {
    if (parentRequestKey !== null && (parentRequestKey !== activeRequestKey || !userApiRequestMap.has(parentRequestKey))) return
    const generation = getScriptGeneration()
    const req = { ...fetchData(url, options), generation, parentRequestKey, controller: new AbortController() }
    const isCurrent = () => generation === getScriptGeneration() && scriptRequestMap.get(requestKey) === req
    waitForPromise(req.request, req.controller.signal).then(response => {
      if (!isCurrent()) return
      sendAction('response', {
        error: null,
        requestKey,
        response,
      })
    }).catch(err => {
      if (!isCurrent()) return
      sendAction('response', {
        error: err.message,
        requestKey,
        response: null,
      })
    }).finally(() => {
      if (scriptRequestMap.get(requestKey) === req) scriptRequestMap.delete(requestKey)
    })
    scriptRequestMap.set(requestKey, req)
  }
  const sendUserApiRequest = async(data: LX.UserApi.UserApiRequestParams, onDispatch?: () => void) => {
    const generation = getScriptGeneration()
    const requestPromise = new Promise<ResponseParams['result']>((resolve, reject) => {
      userApiRequestMap.set(data.requestKey, {
        resolve,
        reject,
        generation,
        data,
        timeout: null,
        onDispatch,
      })
      dispatchNext()
    })
    return requestPromise
  }
  const handleUserApiResponse = ({ status, result, requestKey, errorMessage }: ResponseParams) => {
    const target = userApiRequestMap.get(requestKey)
    if (!target) return
    userApiRequestMap.delete(requestKey)
    clearDeadline(target.timeout)
    if (target.generation !== getScriptGeneration()) target.reject(new Error(requestMsg.cancelRequest))
    else if (status) target.resolve(result)
    else target.reject(new Error(errorMessage ?? 'failed'))
  }
  const handleStateChange = ({ status, errorMessage, info }: InitParams) => {
    // console.log(status, message, info)
    if (!info || info.id !== settingState.setting['common.apiSource']) return
    setUserApiStatus(status, errorMessage)
    if (status) {
      if (info.sources) {
        let apis: any = {}
        let qualitys: LX.QualityList = {}
        for (const [source, { actions, type, qualitys: sourceQualitys }] of Object.entries(info.sources)) {
          if (type != 'music') continue
          apis[source as LX.Source] = {}
          for (const action of actions) {
            switch (action) {
              case 'musicUrl':
                apis[source].getMusicUrl = (songInfo: LX.Music.MusicInfo, type: LX.Quality) => {
                  const requestKey = `request__${Math.random().toString().substring(2)}`
                  let dispatched = false
                  let onDispatch: (() => void) | undefined
                  return {
                    onDispatch(callback: () => void) {
                      if (dispatched) callback()
                      else onDispatch = callback
                    },
                    canceleFn() {
                      cancelUserApiRequest(requestKey)
                    },
                    promise: sendUserApiRequest({
                      requestKey,
                      data: {
                        source,
                        action: 'musicUrl',
                        info: {
                          type,
                          musicInfo: songInfo,
                        },
                      },
                      // eslint-disable-next-line @typescript-eslint/promise-function-async
                    }, () => {
                      dispatched = true
                      onDispatch?.()
                      onDispatch = undefined
                    }).then(res => {
                      // console.log(res)
                      return { type, url: res.data.url }
                    }).catch(err => {
                      console.log(err.message)
                      throw err
                    }),
                  }
                }
                break
              case 'lyric':
                apis[source].getLyric = (songInfo: LX.Music.MusicInfo) => {
                  const requestKey = `request__${Math.random().toString().substring(2)}`
                  return {
                    canceleFn() {
                      cancelUserApiRequest(requestKey)
                    },
                    promise: sendUserApiRequest({
                      requestKey,
                      data: {
                        source,
                        action: 'lyric',
                        info: {
                          type,
                          musicInfo: songInfo,
                        },
                      },
                      // eslint-disable-next-line @typescript-eslint/promise-function-async
                    }).then(res => {
                      // console.log(res)
                      return res.data
                    }).catch(async err => {
                      console.log(err.message)
                      return Promise.reject(err)
                    }),
                  }
                }
                break
              case 'pic':
                apis[source].getPic = (songInfo: LX.Music.MusicInfo) => {
                  const requestKey = `request__${Math.random().toString().substring(2)}`
                  return {
                    canceleFn() {
                      cancelUserApiRequest(requestKey)
                    },
                    promise: sendUserApiRequest({
                      requestKey,
                      data: {
                        source,
                        action: 'pic',
                        info: {
                          type,
                          musicInfo: songInfo,
                        },
                      },
                      // eslint-disable-next-line @typescript-eslint/promise-function-async
                    }).then(res => {
                      // console.log(res)
                      return res.data
                    }).catch(async err => {
                      console.log(err.message)
                      return Promise.reject(err)
                    }),
                  }
                }
                break
              default:
                break
            }
          }
          qualitys[source as LX.Source] = sourceQualitys
        }
        global.lx.qualityList = qualitys
        global.lx.apis = apis
      }
    } else {
      if (errorMessage && !suppressDialogs()) {
        void tipDialog({
          message: `${global.i18n.t('user_api__init_failed_alert', { name: info.name })}\n${errorMessage}`,
          // selection: true,
          btnText: global.i18n.t('ok'),
        })
      }
    }
    if (!global.lx.apiInitPromise[1]) global.lx.apiInitPromise[2](status)
    if (restarting) {
      clearRestartDeadline()
      restarting = false
      if (status) dispatchNext()
      else {
        global.lx.apis = {}
        failPending(new Error(errorMessage || 'Source restart failed'))
      }
    }
  }
  const showUpdateAlert = ({ name, log, updateUrl }: UpdateInfoParams) => {
    if (suppressDialogs()) return
    if (updateUrl) {
      void confirmDialog({
        message: `${global.i18n.t('user_api_update_alert', { name })}\n${log}`,
        // selection: true,
        // showCancel: true,
        confirmButtonText: global.i18n.t('user_api_update_alert_open_url'),
        cancelButtonText: global.i18n.t('close'),
      }).then(confirm => {
        if (!confirm) return
        setTimeout(() => {
          void openUrl(updateUrl)
        }, 300)
      })
    } else {
      void tipDialog({
        message: `${global.i18n.t('user_api_update_alert', { name })}\n${log}`,
        // selection: true,
        btnText: global.i18n.t('ok'),
      })
    }
  }

  global.state_event.on('apiSourceUpdated', () => {
    const generation = getScriptGeneration()
    if (generation !== restartGeneration) {
      clearRestartDeadline()
      restarting = false
    }
    for (const [key, request] of userApiRequestMap) {
      if (request.generation === generation) continue
      userApiRequestMap.delete(key)
      clearDeadline(request.timeout)
      request.reject(new Error(requestMsg.cancelRequest))
    }
    if (activeRequestKey && !userApiRequestMap.has(activeRequestKey)) {
      activeRequestKey = null
      clearCancelDeadline()
      restarting = false
    }
    for (const [key, request] of scriptRequestMap) {
      if (request.generation === generation) continue
      scriptRequestMap.delete(key)
      request.controller.abort()
      try { request.abort() } catch {}
    }
  })

  onScriptAction((event) => {
    // console.log('script actuon: ', event)
    switch (event.action) {
      case 'init':
        if ((event as unknown as { errorMessage?: string }).errorMessage) event.data.errorMessage = (event as unknown as { errorMessage: string }).errorMessage
        handleStateChange(event.data)
        break
      case 'response':
        handleUserApiResponse(event.data)
        break
      case 'request':
        sendScriptRequest(event.data.requestKey, event.data.url, event.data.options, event.data.parentRequestKey === undefined ? activeRequestKey : event.data.parentRequestKey)
        break
      case 'requestSettled':
        if (activeRequestKey === event.data) {
          activeRequestKey = null
          clearCancelDeadline()
          dispatchNext()
        }
        break
      case 'cancelRequest':
        cancelRequest(event.data, 'request canceled')
        break
      case 'showUpdateAlert':
        showUpdateAlert(event.data)
        break
      case 'log':
        switch ((event as unknown as { type: keyof typeof log }).type) {
          case 'log':
          case 'info':
            log.info((event as unknown as { log: string }).log)
            break
          case 'error':
            log.error((event as unknown as { log: string }).log)
            break
          case 'warn':
            log.warn((event as unknown as { log: string }).log)
            break
          default:
            break
        }
        break
      default:
        break
    }
  })

  setUserApiList(userApis)
}
