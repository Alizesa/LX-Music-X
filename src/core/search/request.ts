const requests = new Map<string, AbortController>()
let settled = () => {}
export const onSearchSettled = (callback: () => void) => { settled = callback }
export const isSearchPending = (kind: string) => requests.has(kind)

/** 聚合搜索共用一次取消信号；不会取消播放器换源等独立调用。 */
export const beginSearchRequest = (kind: string) => {
  for (const request of requests.values()) request.abort()
  requests.clear()
  const controller = new AbortController()
  requests.set(kind, controller)
  return controller.signal
}

export const finishSearchRequest = (kind: string, signal: AbortSignal) => {
  if (requests.get(kind)?.signal !== signal) return
  requests.delete(kind)
  settled()
}
