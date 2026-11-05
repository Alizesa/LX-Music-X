import { temporaryDirectoryPath, readDir, unlink, extname } from '@/utils/fs'
import { readPic as _readPic, writeMetadata, writePic, writeLyric } from 'react-native-local-media-metadata'
import { NativeModules } from 'react-native'
export {
  type MusicMetadata,
  type MusicMetadataFull,
  readMetadata,
  writeMetadata,
  writePic,
  readLyric,
  writeLyric,
} from 'react-native-local-media-metadata'

let cleared = false
const picCachePath = temporaryDirectoryPath + '/local-media-metadata'

export const writeDownloadMetadata = async(path: string, metadata: { name: string, singer: string, albumName: string }, picPath: string | null, lyric: string | null) => {
  const native = NativeModules.LocalMediaMetadata as {
    writeTags?: (path: string, metadata: object, picPath: string | null, lyric: string | null) => Promise<void>
  }
  if (native.writeTags) return native.writeTags(path, metadata, picPath, lyric)
  // 开发时旧 APK 配新 bundle 仍可工作；新 APK 走一次原生提交。
  await writeMetadata(path, metadata, true)
  if (picPath) await writePic(path, picPath)
  if (lyric) await writeLyric(path, lyric)
}

export const scanAudioFiles = async(dirPath: string) => {
  const files = await readDir(dirPath)
  return files.filter(file => {
    if (file.mimeType?.startsWith('audio/')) return true
    if (extname(file?.name ?? '') === 'ogg') return true
    return false
  }).map(file => file)
}

const clearPicCache = async() => {
  await unlink(picCachePath)
  cleared = true
}

export const readPic = async(dirPath: string): Promise<string> => {
  if (!cleared) await clearPicCache()
  return _readPic(dirPath, picCachePath)
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


