import { useEffect, useState } from 'react'
import BackgroundTimer from 'react-native-background-timer'
import { exitApp } from '@/core/common'
import playerState from '@/store/player/state'
import settingState from '@/store/setting/state'
import { useScreenVisible } from '@/utils/hooks/useScreenVisible'

type Hook = (time: number, isPlayedStop: boolean) => void

const timeoutTools = {
  bgTimeout: null as number | null,
  timeout: null as ReturnType<typeof setInterval> | null,
  startTime: 0,
  time: -1,
  timeHooks: [] as Hook[],
  exit() {
    if (settingState.setting['player.timeoutExitPlayed'] && playerState.isPlay) {
      global.lx.isPlayedStop = true
      this.callHooks()
    } else {
      exitApp('Timeout Exit')
    }
  },
  getTime() {
    return Math.max(this.time - Math.round((performance.now() - this.startTime) / 1000), -1)
  },
  callHooks() {
    const time = this.getTime()
    for (const hook of this.timeHooks) {
      hook(time, global.lx.isPlayedStop)
    }
  },
  clearTimeout() {
    if (this.bgTimeout != null) BackgroundTimer.clearTimeout(this.bgTimeout)
    if (this.timeout != null) clearInterval(this.timeout)
    this.bgTimeout = null
    this.timeout = null
    this.time = -1
    this.callHooks()
  },
  start(time: number) {
    this.clearTimeout()
    this.time = time
    this.startTime = performance.now()
    this.bgTimeout = BackgroundTimer.setTimeout(() => {
      this.clearTimeout()
      this.exit()
    }, time * 1000)
    this.updateTicker()
  },
  updateTicker() {
    if (this.time >= 0 && this.timeHooks.length) {
      this.timeout ??= setInterval(() => { this.callHooks() }, 1000)
    } else if (this.timeout != null) {
      clearInterval(this.timeout)
      this.timeout = null
    }
  },
  addTimeHook(hook: Hook) {
    this.timeHooks.push(hook)
    hook(this.getTime(), global.lx.isPlayedStop)
    this.updateTicker()
  },
  removeTimeHook(hook: Hook) {
    const index = this.timeHooks.indexOf(hook)
    if (index >= 0) this.timeHooks.splice(index, 1)
    this.updateTicker()
  },
}


export const startTimeoutExit = (time: number) => {
  timeoutTools.start(time)
}
export const stopTimeoutExit = () => {
  timeoutTools.clearTimeout()
}

export const getTimeoutExitTime = () => {
  return timeoutTools.time
}

export const useTimeoutExitTimeInfo = () => {
  const [info, setInfo] = useState({ time: 0, isPlayedStop: false })
  const visible = useScreenVisible()
  useEffect(() => {
    if (!visible) return
    const hook: Hook = (time, isPlayedStop) => {
      setInfo({ time, isPlayedStop })
    }
    timeoutTools.addTimeHook(hook)
    return () => { timeoutTools.removeTimeHook(hook) }
  }, [setInfo, visible])

  return info
}

export const onTimeUpdate = (handler: Hook) => {
  timeoutTools.addTimeHook(handler)

  return () => {
    timeoutTools.removeTimeHook(handler)
  }
}


export const cancelTimeoutExit = () => {
  global.lx.isPlayedStop = false
  timeoutTools.callHooks()
}
