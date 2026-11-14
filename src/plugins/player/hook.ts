import { useEffect, useState } from 'react'
import { useScreenVisible } from '@/utils/hooks/useScreenVisible'
import TrackPlayer, { State, Event } from 'react-native-track-player'

// 多个页面上的播放栏会同时用这个 Hook。状态和轮询统一成模块级单例，
// 页面只做订阅，避免每个播放栏各开一个 interval。
let bufferProgress = 0
const bufferListeners = new Set<(progress: number) => void>()
let bufferInterval: ReturnType<typeof setInterval> | null = null
let bufferSub: { remove: () => void } | null = null
let bufferTracking = false
let bufferDuration = 0
let bufferPreBuffered = 0
let bufferGeneration = 0
let pendingBufferGeneration: number | null = null

const notifyBufferProgress = (progress: number) => {
  bufferProgress = progress
  for (const listener of bufferListeners) listener(progress)
}
const clearBufferInterval = () => {
  if (!bufferInterval) return
  clearInterval(bufferInterval)
  bufferInterval = null
}
const updateBuffer = async() => {
  const generation = bufferGeneration
  if (!bufferTracking || pendingBufferGeneration === generation) return
  pendingBufferGeneration = generation
  try {
    const [buffered, duration] = await Promise.all([
      TrackPlayer.getBufferedPosition(),
      bufferDuration || TrackPlayer.getDuration(),
    ])
    if (!bufferTracking || generation !== bufferGeneration) return
    // generation 同时校验停止/重启和换曲，旧请求不能写回新一轮缓存。
    // eslint-disable-next-line require-atomic-updates
    bufferDuration = duration
    if (buffered > 0 && buffered >= duration) clearBufferInterval()
    if (buffered == bufferPreBuffered) return
    bufferPreBuffered = buffered
    notifyBufferProgress(duration ? Math.min(1, buffered / duration) : 0)
  } catch {
    // 播放器尚未就绪时，下一次可见/播放事件会重新同步。
  } finally {
    if (pendingBufferGeneration === generation) pendingBufferGeneration = null
  }
}
const startBufferInterval = () => {
  if (!bufferTracking) return
  clearBufferInterval()
  bufferInterval = setInterval(updateBuffer, 1000)
  void updateBuffer()
}
const stopBufferTracking = () => {
  bufferTracking = false
  bufferGeneration++
  clearBufferInterval()
  bufferSub?.remove()
  bufferSub = null
  bufferDuration = 0
  bufferPreBuffered = 0
  bufferProgress = 0
}
const startBufferTracking = () => {
  if (bufferTracking) return
  bufferTracking = true
  bufferSub = TrackPlayer.addEventListener(Event.PlaybackState, data => {
    if (!bufferTracking) return
    switch (data.state) {
      case State.None:
        bufferGeneration++
        bufferDuration = 0
        bufferPreBuffered = 0
        clearBufferInterval()
        notifyBufferProgress(0)
        break
      case State.Paused:
      case State.Stopped:
        bufferGeneration++
        // 不在缓冲中了，停止轮询；恢复播放/再次缓冲会重新启动
        clearBufferInterval()
        break
      case State.Buffering:
        bufferGeneration++
        bufferDuration = 0
        bufferPreBuffered = 0
        startBufferInterval()
        break
      case State.Playing:
        // 暂停/停止时轮询被停掉了，恢复播放后要重新启动；
        // 已经缓冲满的话没必要再轮询
        if (!bufferInterval && (bufferDuration === 0 || bufferPreBuffered < bufferDuration)) startBufferInterval()
        break
    }
  })
  void updateBuffer()
  const generation = bufferGeneration
  void TrackPlayer.getState().then((state) => {
    if (bufferTracking && generation === bufferGeneration && (state == State.Buffering || state == State.Playing)) startBufferInterval()
  }).catch(() => {})
}

export function useBufferProgress() {
  const [progress, setProgress] = useState(bufferProgress)
  const visible = useScreenVisible()

  useEffect(() => {
    if (!visible) return
    bufferListeners.add(setProgress)
    setProgress(bufferProgress)
    if (bufferListeners.size === 1) startBufferTracking()
    return () => {
      bufferListeners.delete(setProgress)
      if (bufferListeners.size === 0) stopBufferTracking()
    }
  }, [visible])

  return progress
}
