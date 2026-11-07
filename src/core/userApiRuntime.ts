import BackgroundTimer from 'react-native-background-timer'
import { state as userApiState } from '@/store/userApi'
import settingState from '@/store/setting/state'
import { getUserApiScript } from '@/utils/data'
import { toOldMusicInfo } from '@/utils'
import { requestMsg } from '@/utils/message'
import { destroy, loadScript, onScriptAction, sendAction, supportsIsolatedUserApi } from '@/utils/nativeModules/userApi'
import { fetchData } from '@/core/init/userApi/request'

const qualities: LX.Quality[] = ['flac24bit', 'flac', '320k', '128k']
let nextRuntimeId = 0

const selectQuality = (preferred: LX.Quality, supported: LX.Quality[], musicInfo: LX.Music.MusicInfoOnline, allowFallback: boolean) => {
  if (!allowFallback) {
    if (!supported.includes(preferred)) throw new Error('Unsupported music quality')
    return preferred
  }
  const quality = qualities.slice(Math.max(0, qualities.indexOf(preferred)))
    .find(item => supported.includes(item) && (item == '128k' || musicInfo.meta._qualitys[item]))
  if (!quality) throw new Error('Unsupported music quality')
  return quality
}

/** 常用音源复用已有运行环境；备用音源按请求隔离，结束时释放脚本和全部 HTTP 请求。 */
export const requestUserApiMusicUrl = async(apiId: string, musicInfo: LX.Music.MusicInfoOnline, preferredQuality: LX.Quality,
  onCancel?: (cancel: () => void) => void, allowQualityFallback = true): Promise<{ url: string, type: LX.Quality }> => {
  let disposed = false
  let cancelRequest: (() => void) | undefined
  let removeListener: (() => void) | undefined
  let runtimeId: string | undefined
  const httpRequests = new Map<string, ReturnType<typeof fetchData>>()
  let rejectCancelled: (error: Error) => void = () => {}
  const cancelled = new Promise<never>((resolve, reject) => { rejectCancelled = reject })
  const assertActive = () => { if (disposed) throw new Error(requestMsg.cancelRequest) }
  const cancel = (message: string) => {
    if (disposed) return
    disposed = true
    try { cancelRequest?.() } catch {}
    rejectCancelled(new Error(message))
  }
  onCancel?.(() => { cancel(requestMsg.cancelRequest) })
  const timeout = BackgroundTimer.setTimeout(() => { cancel('Source request timeout') }, 12_000)

  const work = async() => {
    assertActive()
    if (apiId == settingState.setting['common.apiSource']) {
      if (!await global.lx.apiInitPromise[0]) throw new Error('Source initialization failed')
      assertActive()
      if (apiId != settingState.setting['common.apiSource']) throw new Error(requestMsg.cancelRequest)
      const api = global.lx.apis[musicInfo.source]
      if (!api?.getMusicUrl) throw new Error('Unsupported music source')
      const type = selectQuality(preferredQuality, global.lx.qualityList[musicInfo.source] ?? [], musicInfo, allowQualityFallback)
      const request = api.getMusicUrl(toOldMusicInfo(musicInfo), type)
      cancelRequest = request.canceleFn
      const result = await request.promise
      assertActive()
      return { url: result.url, type }
    }

    if (!supportsIsolatedUserApi()) throw new Error('Isolated music sources require an updated app')
    const info = userApiState.list.find(api => api.id == apiId)
    if (!info) throw new Error('Source was removed')
    const script = await getUserApiScript(apiId)
    assertActive()
    const id = runtimeId = `music_url_${++nextRuntimeId}`
    const requestKey = `${id}_url`
    let resolveInit: (info: LX.UserApi.UserApiInfo) => void = () => {}
    let rejectInit: (error: Error) => void = () => {}
    let resolveUrl: (url: string) => void = () => {}
    let rejectUrl: (error: Error) => void = () => {}
    const initialized = new Promise<LX.UserApi.UserApiInfo>((resolve, reject) => { resolveInit = resolve; rejectInit = reject })
    removeListener = onScriptAction(event => {
      if (disposed) return
      switch (event.action) {
        case 'init':
          if (event.data.status) resolveInit(event.data.info)
          else rejectInit(new Error(event.data.errorMessage || 'Source initialization failed'))
          break
        case 'request': {
          const { requestKey, url, options } = event.data
          httpRequests.get(requestKey)?.abort()
          const request = fetchData(url, options)
          httpRequests.set(requestKey, request)
          void request.request.then(response => {
            if (!disposed && httpRequests.get(requestKey) === request) sendAction('response', { requestKey, error: null, response }, id)
          }).catch((error: Error) => {
            if (!disposed && httpRequests.get(requestKey) === request) sendAction('response', { requestKey, error: error.message, response: null }, id)
          }).finally(() => {
            if (httpRequests.get(requestKey) === request) httpRequests.delete(requestKey)
          })
          break
        }
        case 'cancelRequest':
          httpRequests.get(event.data)?.abort()
          httpRequests.delete(event.data)
          break
        case 'response':
          if (event.data.requestKey != requestKey) break
          if (event.data.status) resolveUrl(event.data.result?.data?.url as string)
          else rejectUrl(new Error(event.data.errorMessage ?? 'Source request failed'))
          break
      }
    }, id)
    loadScript({ ...info, script }, id)
    const initializedInfo = await initialized
    assertActive()
    const source = initializedInfo.sources?.[musicInfo.source]
    if (!source?.actions.includes('musicUrl')) throw new Error('Unsupported music source')
    const type = selectQuality(preferredQuality, source.qualitys, musicInfo, allowQualityFallback)
    const result = new Promise<string>((resolve, reject) => { resolveUrl = resolve; rejectUrl = reject })
    cancelRequest = () => { sendAction('cancelRequest', requestKey, id) }
    sendAction('request', { requestKey, data: { source: musicInfo.source, action: 'musicUrl', info: { type, musicInfo: toOldMusicInfo(musicInfo) } } }, id)
    const url = await result
    assertActive()
    return { url, type }
  }

  return Promise.race([work(), cancelled]).finally(() => {
    disposed = true
    BackgroundTimer.clearTimeout(timeout)
    try { removeListener?.() } catch {}
    for (const request of httpRequests.values()) {
      try { request.abort() } catch {}
    }
    httpRequests.clear()
    if (runtimeId) {
      try { destroy(runtimeId) } catch {}
    }
  })
}
