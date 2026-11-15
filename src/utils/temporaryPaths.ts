import { NativeModules } from 'react-native'

const cache = NativeModules.CacheModule as {
  protectCachePath?: (path: string) => boolean
  unprotectCachePath?: (path: string) => boolean
} | undefined

// Register before starting I/O; native cache deletion uses the same lock.
// Paths outside the app's cache directories do not need this protection.
export const retainTemporaryPath = (path: string): (() => void) => {
  const retained = cache?.protectCachePath?.(path) === true
  let released = false
  return () => {
    if (released) return
    released = true
    if (retained) cache?.unprotectCachePath?.(path)
  }
}

export const withTemporaryPaths = async<T>(paths: string[], operation: () => Promise<T>): Promise<T> => {
  const releases: Array<() => void> = []
  try {
    for (const path of paths) releases.push(retainTemporaryPath(path))
    return await operation()
  } finally {
    for (let index = releases.length - 1; index >= 0; index--) releases[index]()
  }
}
