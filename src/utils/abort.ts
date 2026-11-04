import { requestMsg } from './message'

export const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new Error(requestMsg.cancelRequest)
}

/** 取消只结束当前等待者；是否同时终止底层请求由调用方决定。 */
export const withAbort = async<T>(promise: Promise<T>, signal?: AbortSignal, cancel?: () => void): Promise<T> => {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      try { cancel?.() } catch {}
      reject(new Error(requestMsg.cancelRequest))
    }
    signal.addEventListener('abort', onAbort)
    // 始终订阅原始 promise，取消后的迟到拒绝也不会成为未处理异常。
    promise.then(value => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }, error => {
      signal.removeEventListener('abort', onAbort)
      reject(error)
    })
    if (signal.aborted) onAbort()
  })
}
