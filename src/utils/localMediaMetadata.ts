import { temporaryDirectoryPath, readDir, unlink, extname } from '@/utils/fs'
import { readPic as _readPic, readMetadata as _readMetadata, readLyric as _readLyric, writeMetadata as _writeMetadata, writePic as _writePic, writeLyric as _writeLyric } from 'react-native-local-media-metadata'
import { NativeModules } from 'react-native'
import { retainTemporaryPath, withTemporaryPaths } from './temporaryPaths'
export {
  type MusicMetadata,
  type MusicMetadataFull,
} from 'react-native-local-media-metadata'

let cleared = false
const picCachePath = temporaryDirectoryPath + '/local-media-metadata'
const metadataTempPath = temporaryDirectoryPath + '/local-media-metadata-temp-file'
let clearPicCachePromise: Promise<void> | null = null

export const readMetadata = async(...args: Parameters<typeof _readMetadata>): ReturnType<typeof _readMetadata> => withTemporaryPaths([metadataTempPath], async() => _readMetadata(...args))
export const readLyric = async(...args: Parameters<typeof _readLyric>): ReturnType<typeof _readLyric> => withTemporaryPaths([metadataTempPath], async() => _readLyric(...args))
export const writeMetadata = async(...args: Parameters<typeof _writeMetadata>): ReturnType<typeof _writeMetadata> => withTemporaryPaths([metadataTempPath], async() => _writeMetadata(...args))
export const writePic = async(...args: Parameters<typeof _writePic>): ReturnType<typeof _writePic> => withTemporaryPaths([metadataTempPath, args[1]], async() => _writePic(...args))
export const writeLyric = async(...args: Parameters<typeof _writeLyric>): ReturnType<typeof _writeLyric> => withTemporaryPaths([metadataTempPath], async() => _writeLyric(...args))

export const writeDownloadMetadata = async(path: string, metadata: { name: string, singer: string, albumName: string }, picPath: string | null, lyric: string | null) => withTemporaryPaths([metadataTempPath, ...(picPath ? [picPath] : [])], async() => {
  const native = NativeModules.LocalMediaMetadata as {
    writeTags?: (path: string, metadata: object, picPath: string | null, lyric: string | null) => Promise<void>
  }
  if (native.writeTags) return native.writeTags(path, metadata, picPath, lyric)
  // 开发时旧 APK 配新 bundle 仍可工作；新 APK 走一次原生提交。
  await writeMetadata(path, metadata, true)
  if (picPath) await writePic(path, picPath)
  if (lyric) await writeLyric(path, lyric)
})

export const scanAudioFiles = async(dirPath: string) => {
  const files = await readDir(dirPath)
  return files.filter(file => {
    if (file.mimeType?.startsWith('audio/')) return true
    if (extname(file?.name ?? '') === 'ogg') return true
    return false
  }).map(file => file)
}

const clearPicCache = async(): Promise<void> => {
  if (cleared) return Promise.resolve()
  if (clearPicCachePromise) return clearPicCachePromise
  // Local song objects keep generated cover paths for the lifetime of this
  // session. Only this directory stays protected after its cold cleanup.
  const release = retainTemporaryPath(picCachePath)
  clearPicCachePromise = unlink(picCachePath).then(() => { cleared = true }).finally(() => {
    if (!cleared) release()
    clearPicCachePromise = null
  })
  return clearPicCachePromise
}

export const readPic = async(dirPath: string): Promise<string> => {
  await clearPicCache()
  return withTemporaryPaths([metadataTempPath], async() => _readPic(dirPath, picCachePath))
}

// export interface MusicMetadata {
//   type: 'mp3' | 'flac' | 'ogg' | 'wav'
//   bitrate: string
//   interval: number
//   size: number
//   ext: 'mp3' | 'flac' | 'ogg' | 'wav'
//   albumName: string
//   singer: string
//   name: string
// }
// export const readMetadata = async(filePath: string): Promise<MusicMetadata | null> => {
//   return LocalMediaModule.readMetadata(filePath)
// }

// export const readPic = async(filePath: string): Promise<string> => {
//   return LocalMediaModule.readPic(filePath)
// }

// export const readLyric = async(filePath: string): Promise<string> => {
//   return LocalMediaModule.readLyric(filePath)
// }


