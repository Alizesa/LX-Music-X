import { requestMsg } from './message'

interface Waiter<T> {
  resolve: (value: T) => void
  reject: (error: unknown) => void
}
const observers = new WeakMap<Promise<unknown>, Set<Waiter<any>>>()

// 一个长期未完成的共享 Promise 只持有一个观察者。取消时从集合移除业务回调。
const observe = <T>(promise: Promise<T>) => {
  const current = observers.get(promise)
  if (current) return current as Set<Waiter<T>>
  const waiters = new Set<Waiter<T>>()
  observers.set(promise, waiters)
  const finish = () => { observers.delete(promise); waiters.clear() }
  void promise.then(value => {
    for (const waiter of waiters) waiter.resolve(value)
    finish()
  }, (error: unknown) => {
    for (const waiter of waiters) waiter.reject(error)
    finish()
  })
  return waiters
}

export const waitForPromise = async<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  const waiters = observe(promise)
  if (signal?.aborted) throw new Error(requestMsg.cancelRequest)
  let waiter: Waiter<T>
  let cancel: () => void
  try {
    return await new Promise<T>((resolve, reject) => {
      waiter = { resolve, reject }
      cancel = () => {
        waiters.delete(waiter)
        reject(new Error(requestMsg.cancelRequest))
      }
      waiters.add(waiter)
      signal?.addEventListener('abort', cancel, { once: true })
    })
  } finally {
    waiters.delete(waiter!)
    signal?.removeEventListener('abort', cancel!)
  }
}

export const waitForRequest = async<T>(request: { promise: Promise<T>, cancelHttp: () => void }, signal?: AbortSignal): Promise<T> => {
  const cancel = () => { try { request.cancelHttp() } catch {} }
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  try {
    return await waitForPromise(request.promise, signal)
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}
