import { useCallback, useEffect, useRef, useState } from 'react'
import state from './state'
import { getDownloadCount, getDownloadList, getDownloadTaskItem, releaseDownloadList, retainDownloadList } from '@/core/download'
import { useScreenVisible } from '@/utils/hooks/useScreenVisible'

export const useDownloadCount = () => {
  const [count, setCount] = useState(state.count)
  const visible = useScreenVisible()
  useEffect(() => {
    if (!visible) return
    let mounted = true
    const update = (value: number) => {
      if (!mounted) return
      state.count = value
      setCount(value)
    }
    global.app_event.on('downloadCountUpdate', update)
    void getDownloadCount().then(update).catch((error: unknown) => { console.warn('[Download] count:', error) })
    return () => {
      mounted = false
      global.app_event.off('downloadCountUpdate', update)
    }
  }, [visible])
  return count
}

export const useDownloadTasks = () => {
  const [tasks, setTasks] = useState<LX.Download.DownloadListItem[]>([])
  const [limit, setLimit] = useState(100)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const pending = useRef(false)
  const count = useDownloadCount()
  const total = useRef(count)
  total.current = count
  const windowLimit = useRef(100)
  const loadMoreRef = useRef<(() => void) | null>(null)
  const retryRef = useRef<(() => void) | null>(null)
  const visible = useScreenVisible()
  useEffect(() => {
    if (!visible) return
    let version = 0
    retainDownloadList()
    const read = (offset: number, size: number, append: boolean) => {
      const current = ++version
      pending.current = true
      setLoading(true)
      setError(false)
      void getDownloadList(size, offset).then(items => {
        if (current !== version) return
        setTasks(previous => append ? [...previous, ...items] : items)
        windowLimit.current = offset + size
        setLimit(windowLimit.current)
      }).catch((error: unknown) => {
        if (current === version) setError(true)
        console.warn('[Download] list:', error)
      }).finally(() => {
        if (current !== version) return
        pending.current = false
        setLoading(false)
      })
    }
    const refresh = () => { read(0, windowLimit.current, false) }
    retryRef.current = refresh
    loadMoreRef.current = () => {
      if (pending.current || windowLimit.current >= total.current) return
      read(windowLimit.current, 100, true)
    }
    refresh()
    global.app_event.on('downloadListUpdate', refresh)
    return () => {
      version++
      pending.current = false
      loadMoreRef.current = null
      retryRef.current = null
      global.app_event.off('downloadListUpdate', refresh)
      releaseDownloadList()
    }
  }, [visible])
  const hasMore = limit < count
  const loadMore = useCallback(() => {
    loadMoreRef.current?.()
  }, [])
  const retry = useCallback(() => { retryRef.current?.() }, [])
  return { tasks, count, hasMore, loading, error, loadMore, retry }
}

/** 每个可见下载行只接收自己的进度，不重建历史列表。 */
export const useDownloadItem = (item: LX.Download.DownloadListItem) => {
  const [current, setCurrent] = useState(() => getDownloadTaskItem(item.id) ?? item)
  const visible = useScreenVisible()
  useEffect(() => {
    if (!visible) return
    setCurrent(getDownloadTaskItem(item.id) ?? item)
    const update = (next: LX.Download.DownloadListItem) => {
      if (next.id === item.id) setCurrent(next)
    }
    global.app_event.on('downloadTaskUpdate', update)
    return () => { global.app_event.off('downloadTaskUpdate', update) }
  }, [item, visible])
  return current
}
