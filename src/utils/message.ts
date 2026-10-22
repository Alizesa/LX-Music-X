export const requestMsg = {
  fail: '请求异常😮，可以多试几次，若还是不行就换一首吧。。。',
  unachievable: '哦No😱...接口无法访问了！',
  timeout: '请求超时',
  // unachievable: '哦No😱...接口无法访问了！已帮你切换到临时接口，重试下看能不能播放吧~',
  notConnectNetwork: '无法连接到服务器',
  cancelRequest: '取消http请求',
  tooManyRequests: '服务器繁忙',
} as const

/** 取链被主动取消（不是失败）。各源可能 reject Error 或普通对象，统一按 message 判断 */
export const isRequestCancelled = (error: unknown): boolean =>
  (error as { message?: unknown } | null | undefined)?.message === requestMsg.cancelRequest
