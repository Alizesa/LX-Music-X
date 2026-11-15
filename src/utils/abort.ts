import { requestMsg } from './message'
import { waitForPromise } from '@/utils/abortable'

export const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new Error(requestMsg.cancelRequest)
}

/** 取消只结束当前等待者；是否同时终止底层请求由调用方决定。 */
export const withAbort = async<T>(promise: Promise<T>, signal?: AbortSignal, cancel?: () => void): Promise<T> => {
  if (!signal) return promise
  const onAbort = () => { try { cancel?.() } catch {} }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  try {
    return await waitForPromise(promise, signal)
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
