import { useEffect, useState, useRef } from 'react'
import TrackPlayer, { State, Event } from 'react-native-track-player'

/** Get current playback state and subsequent updatates  */
export const usePlaybackState = () => {
  const [state, setState] = useState(State.None)

  useEffect(() => {
    async function setPlayerState() {
      const playerState = await TrackPlayer.getState()
      setState(playerState)
    }

    void setPlayerState()

    const sub = TrackPlayer.addEventListener(Event.PlaybackState, data => {
      setState(data.state as State)
    })

    return () => { sub.remove() }
  }, [])

  return state
}

/**
 * Attaches a handler to the given TrackPlayer events and performs cleanup on unmount
 * @param events - TrackPlayer events to subscribe to
 * @param handler - callback invoked when the event fires
 */
// export const useTrackPlayerEvents = (events, handler) => {
//   const savedHandler = useRef()

//   useEffect(() => {
//     savedHandler.current = handler
//   }, [handler])

//   useEffect(() => {
//     // eslint-disable-next-line no-undef
//     if (__DEV__) {
//       const allowedTypes = Object.values(Event)
//       const invalidTypes = events.filter(type => !allowedTypes.includes(type))
//       if (invalidTypes.length) {
//         console.warn(
//           'One or more of the events provided to useTrackPlayerEvents is ' +
//             `not a valid TrackPlayer event: ${invalidTypes.join("', '")}. ` +
//             'A list of available events can be found at ' +
//             'https://react-native-kit.github.io/react-native-track-player/documentation/#events',
//         )
//       }
//     }

//     const subs = events.map(event =>
//       TrackPlayer.addEventListener(event, payload => savedHandler.current({ ...payload, type: event })),
//     )

//     return () => subs.forEach(sub => sub.remove())
//   }, [events])
// }

const pollTrackPlayerStates = [
  State.Playing,
  State.Buffering,
] as const
/**
 * Poll for track progress for the given interval (in miliseconds)
 * @param updateInterval - ms interval
 */
export function useProgress(updateInterval: number) {
  const [state, setState] = useState({ position: 0, duration: 0, buffered: 0 })
  const playerState = usePlaybackState()
  const stateRef = useRef(state)
  const isUnmountedRef = useRef(true)
  useEffect(() => {
    isUnmountedRef.current = false
    return () => {
      isUnmountedRef.current = true
    }
  }, [])

  const getProgress = async() => {
    const [position, duration, buffered] = await Promise.all([
      TrackPlayer.getPosition(),
      TrackPlayer.getDuration(),
      TrackPlayer.getBufferedPosition(),
    ])
    // After the asynchronous code is executed, if the component has been uninstalled, do not update the status
    if (isUnmountedRef.current) return

    if (
      position === stateRef.current.position &&
      duration === stateRef.current.duration &&
      buffered === stateRef.current.buffered
    ) return

    const state = { position, duration, buffered }
    stateRef.current = state
    setState(state)
  }

  useEffect(() => {
    // @ts-expect-error
    if (!pollTrackPlayerStates.includes(playerState)) return

    void getProgress()

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    const poll = setInterval(getProgress, updateInterval || 1000)
    return () => { clearInterval(poll) }
  }, [playerState, updateInterval])

  return state
}

// 多个页面上的播放栏会同时用这个 Hook。状态和轮询统一成模块级单例，
// 页面只做订阅，避免每个播放栏各开一个 interval。
let bufferProgress = 0
const bufferListeners = new Set<(progress: number) => void>()
let bufferInterval: ReturnType<typeof setInterval> | null = null
let bufferSub: { remove: () => void } | null = null
let bufferTracking = false
let bufferDuration = 0
let bufferPreBuffered = 0

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
  if (!bufferTracking) return
  const buffered = await (bufferDuration ? TrackPlayer.getBufferedPosition() : Promise.all([TrackPlayer.getBufferedPosition(), TrackPlayer.getDuration()]).then(([buffered, _duration]) => {
    bufferDuration = _duration
    return buffered
  }))
  if (!bufferTracking) return
  if (buffered > 0 && buffered == bufferDuration) clearBufferInterval()
  if (buffered == bufferPreBuffered) return
  bufferPreBuffered = buffered
  notifyBufferProgress(bufferDuration ? (buffered / bufferDuration) : 0)
}
const startBufferInterval = () => {
  if (!bufferTracking) return
  clearBufferInterval()
  bufferInterval = setInterval(updateBuffer, 1000)
  void updateBuffer()
}
const stopBufferTracking = () => {
  bufferTracking = false
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
        clearBufferInterval()
        notifyBufferProgress(0)
        break
      case State.Paused:
      case State.Stopped:
        // 不在缓冲中了，停止轮询；恢复播放/再次缓冲会重新启动
        clearBufferInterval()
        break
      case State.Buffering:
        bufferDuration = 0
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
  void TrackPlayer.getState().then((state) => {
    if (bufferTracking && state == State.Buffering) startBufferInterval()
  })
}

export function useBufferProgress() {
  const [progress, setProgress] = useState(bufferProgress)

  useEffect(() => {
    bufferListeners.add(setProgress)
    setProgress(bufferProgress)
    if (bufferListeners.size === 1) startBufferTracking()
    return () => {
      bufferListeners.delete(setProgress)
      if (bufferListeners.size === 0) stopBufferTracking()
    }
  }, [])

  return progress
}
