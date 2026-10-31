type Handler = (active: boolean) => void

let handler: Handler | null = null

/** 首页 PagerView 挂载时注册；卸载时传 null */
export const setHomePagerScrollHandler = (next: Handler | null) => {
  handler = next
}

/**
 * 首页横向滚动块触摸开始/结束时调用。
 *
 * 必须同步：`app_event` 的 emit 是 setImmediate，等回调跑到原生 ViewPager 时，
 * 横滑手势可能已经被它抢走了（表现为切到「我的」页，或内层列表划不动）。
 */
export const setHomePagerHorizontalScroll = (active: boolean) => {
  handler?.(active)
}
