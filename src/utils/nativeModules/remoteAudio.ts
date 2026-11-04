import { NativeModules } from 'react-native'

export interface RemoteAudioInfo {
  readable: boolean
  durationMs?: number
  mime?: string
}

interface CachedProbe {
  info: RemoteAudioInfo
  expires: number
}

// 预加载和点播复用同一份媒体检查；不持久保存含签名的地址。
const cache = new Map<string, CachedProbe>()
const pending = new Map<string, Promise<RemoteAudioInfo>>()

export const probeRemoteAudio = async(url: string, inspectDuration: boolean): Promise<RemoteAudioInfo> => {
  const key = `${inspectDuration ? 'duration' : 'readable'}:${url}`
  const cached = cache.get(key)
  if (cached && cached.expires > Date.now()) return cached.info
  const running = pending.get(key)
  if (running) return running
  const request = (async(): Promise<RemoteAudioInfo> => {
    try {
      const info: RemoteAudioInfo = await NativeModules.UtilsModule.probeRemoteAudio(url, inspectDuration)
      if (info.readable && (!inspectDuration || (info.durationMs ?? 0) > 0)) {
        cache.delete(key)
        cache.set(key, { info, expires: Date.now() + 60_000 })
        if (cache.size > 32) cache.delete(cache.keys().next().value!)
      }
      return info
    } catch {
      return { readable: false }
    }
  })()
  pending.set(key, request)
  try {
    return await request
  } finally {
    pending.delete(key)
  }
}
