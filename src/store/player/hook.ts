import { isActive } from '@/utils/tools'
import { useEffect, useState } from 'react'
import state, { type InitState } from './state'
import { useScreenVisible } from '@/utils/hooks/useScreenVisible'

export const usePlayerMusicInfo = () => {
  const [value, update] = useState(state.musicInfo)
  const visible = useScreenVisible()

  useEffect(() => {
    if (!visible) return
    update(state.musicInfo)
    global.state_event.on('playerMusicInfoChanged', update)
    return () => {
      global.state_event.off('playerMusicInfoChanged', update)
    }
  }, [visible])

  return value
}

export const usePlayMusicInfo = () => {
  const [value, update] = useState(state.playMusicInfo)

  useEffect(() => {
    global.state_event.on('playMusicInfoChanged', update)
    return () => {
      global.state_event.off('playMusicInfoChanged', update)
    }
  }, [])

  return value
}

export const usePlayInfo = () => {
  const [value, update] = useState(state.playInfo)

  useEffect(() => {
    global.state_event.on('playInfoChanged', update)
    return () => {
      global.state_event.off('playInfoChanged', update)
    }
  }, [])

  return value
}

export const useStatusText = () => {
  const [value, update] = useState(state.statusText)

  useEffect(() => {
    global.state_event.on('playStateTextChanged', update)
    return () => {
      global.state_event.off('playStateTextChanged', update)
    }
  }, [])

  return value
}

export const useIsPlay = () => {
  const [value, update] = useState(state.isPlay)

  useEffect(() => {
    global.state_event.on('playStateChanged', update)
    return () => {
      global.state_event.off('playStateChanged', update)
    }
  }, [])

  return value
}

export const useProgress = (autoUpdate = true) => {
  const [value, update] = useState(state.progress)
  const visible = useScreenVisible()

  useEffect(() => {
    if (!autoUpdate || !visible) return
    const handleUpdate = (progress: InitState['progress']) => {
      if (isActive()) update(progress)
    }
    update(state.progress)
    global.state_event.on('playProgressChanged', handleUpdate)
    return () => {
      global.state_event.off('playProgressChanged', handleUpdate)
    }
  }, [autoUpdate, visible])

  return value
}
