import { throwIfAborted } from '@/utils/abort'

/** 保留各音源的 retryNum 参数约定，每次业务调用独立携带取消信号。 */
export const withRequestSignal = <T extends object>(sdk: T, signal?: AbortSignal): T => {
  throwIfAborted(signal)
  if (!signal) return sdk
  return Object.assign(Object.create(sdk) as T, { requestSignal: signal })
}
