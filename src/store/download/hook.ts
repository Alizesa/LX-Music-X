import { useEffect, useState } from 'react'
import state from './state'
import { getTasks } from '@/core/download'

export const useDownloadTasks = () => {
  const [tasks, setTasks] = useState(state.tasks)
  useEffect(() => {
    let mounted = true
    const refresh = () => {
      void getTasks().then(items => {
        if (!mounted) return
        state.tasks = [...items]
        setTasks(state.tasks)
      })
    }
    refresh()
    global.app_event.on('downloadListUpdate', refresh)
    return () => {
      mounted = false
      global.app_event.off('downloadListUpdate', refresh)
    }
  }, [])
  return tasks
}
