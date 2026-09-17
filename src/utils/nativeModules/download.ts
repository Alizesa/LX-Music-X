import { NativeEventEmitter, NativeModules, type NativeModule } from 'react-native'

interface DownloadNativeModule extends NativeModule {
  enqueue: (taskId: string, url: string, treeUri: string, fileName: string, mimeType: string, headers: Record<string, string>) => Promise<string>
  pause: (nativeId: string) => Promise<void>
  remove: (nativeId: string, taskId: string, deletePartial: boolean) => Promise<void>
  getState: (nativeId: string) => Promise<NativeDownloadState | null>
}

const DownloadModule = NativeModules.DownloadModule as DownloadNativeModule
const emitter = new NativeEventEmitter(DownloadModule)

export interface NativeDownloadState {
  taskId?: string
  nativeId: string
  status: 'waiting' | 'run' | 'pause' | 'completed' | 'error'
  downloaded: number
  total: number
  filePath?: string
  fileName?: string
  error?: string
}

export const enqueueDownload = async(options: {
  taskId: string
  url: string
  treeUri: string
  fileName: string
  mimeType: string
  headers?: Record<string, string>
}): Promise<string> => DownloadModule.enqueue(
  options.taskId,
  options.url,
  options.treeUri,
  options.fileName,
  options.mimeType,
  options.headers ?? {},
)

export const pauseDownload = async(nativeId: string): Promise<void> => DownloadModule.pause(nativeId)

export const removeDownload = async(nativeId: string | undefined, taskId: string, deletePartial: boolean): Promise<void> =>
  DownloadModule.remove(nativeId ?? '', taskId, deletePartial)

export const getDownloadState = async(nativeId: string): Promise<NativeDownloadState | null> => DownloadModule.getState(nativeId)

export const onDownloadUpdate = (handler: (state: NativeDownloadState) => void) => {
  const subscription = emitter.addListener('lx-download-update', handler)
  return () => { subscription.remove() }
}
