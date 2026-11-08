interface TimerApi<Id> {
  setTimeout: (callback: () => void, delay: number) => Id
  clearTimeout: (id: Id) => void
}

export type ScheduledTask<Args extends any[]> = ((...args: Args) => void) & { cancel: () => void }

/** 两种计时器共用尾调用；执行或取消后立即释放参数里的列表、歌曲等对象。 */
export const createScheduledTask = <Args extends any[], Id>(
  fn: (...args: Args) => void | Promise<void>, delay: number, restart: boolean, timers: TimerApi<Id>,
): ScheduledTask<Args> => {
  let timer: Id | null = null
  let pending: Args | null = null
  const task = ((...args: Args) => {
    pending = args
    if (timer !== null) {
      if (!restart) return
      timers.clearTimeout(timer)
    }
    timer = timers.setTimeout(() => {
      timer = null
      const args = pending
      pending = null
      if (args) void fn(...args)
    }, delay)
  }) as ScheduledTask<Args>
  task.cancel = () => {
    if (timer !== null) timers.clearTimeout(timer)
    timer = null
    pending = null
  }
  return task
}
