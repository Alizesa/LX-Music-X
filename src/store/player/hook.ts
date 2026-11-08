import { isActive } from '@/utils/tools'
import { useEffect, useState } from 'react'
import state, { type InitState } from './state'
import { useScreenVisible } from '@/utils/hooks/useScreenVisible'

const events = {
  musicInfo: 'playerMusicInfoChanged',
  playMusicInfo: 'playMusicInfoChanged',
  playInfo: 'playInfoChanged',
  statusText: 'playStateTextChanged',
  isPlay: 'playStateChanged',
  progress: 'playProgressChanged',
} as const

const snapshot = <K extends keyof typeof events>(key: K): InitState[K] => {
  const value = state[key]
  // 部分 store 字段就地更新，React 需要独立快照才能识别变化。
  return typeof value === 'object' ? { ...value } : value
}

/** 所有播放 UI 都随页面显隐订阅；回来时一次补齐隐藏期间的最新状态。 */
const usePlayerValue = <K extends keyof typeof events>(key: K, autoUpdate = true) => {
  const [value, update] = useState(() => snapshot(key))
  const visible = useScreenVisible()
  useEffect(() => {
    if (!autoUpdate || !visible) return
    const handleUpdate = () => {
      if (key !== 'progress' || isActive()) update(snapshot(key))
    }
    handleUpdate()
    const event = events[key]
    global.state_event.on(event, handleUpdate)
    return () => { global.state_event.off(event, handleUpdate) }
  }, [key, autoUpdate, visible])
  return value
}

export const usePlayerMusicInfo = () => usePlayerValue('musicInfo')
export const usePlayMusicInfo = () => usePlayerValue('playMusicInfo')
export const usePlayInfo = () => usePlayerValue('playInfo')
export const useStatusText = () => usePlayerValue('statusText')
export const useIsPlay = () => usePlayerValue('isPlay')
export const useProgress = (autoUpdate = true) => usePlayerValue('progress', autoUpdate)
