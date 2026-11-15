import { AppState } from 'react-native'
import { initializeMusicRuntime, initializeRuntimeSettings } from './init/musicRuntime'
import { preparePendingDownloads } from './download'
import { finishDownloadQueueDispatch } from '@/utils/nativeModules/download'
import { waitForPromise } from '@/utils/abortable'
import { releaseIdleCaches } from './cacheLifecycle'
import { releaseIdleLocalListCache } from './localList'

export const runDownloadQueueDispatch = async({ workId }: { workId: string }): Promise<void> => {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, 75_000)
  try {
    const work = (async() => {
      const setting = await initializeRuntimeSettings()
      await initializeMusicRuntime(setting)
      await preparePendingDownloads(controller.signal, () => AppState.currentState !== 'active')
    })()
    await waitForPromise(work, controller.signal)
    await finishDownloadQueueDispatch(workId, true)
  } catch (error) {
    await finishDownloadQueueDispatch(workId, false).catch((error: unknown) => { console.warn('[Download] dispatch acknowledgment:', error) })
    throw error
  } finally {
    clearTimeout(timer)
    if (AppState.currentState !== 'active') {
      try { releaseIdleCaches(); releaseIdleLocalListCache() } catch (error) { console.warn('[Download] idle cache release:', error) }
    }
  }
}
