import { probeRemoteAudio, type RemoteAudioInfo } from '@/utils/nativeModules/remoteAudio'
import { throwIfAborted } from '@/utils/abort'

// Keep the transfer identical to the response inspected by playback and RemoteAudioProbe.
export const DOWNLOAD_AUDIO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 10; Pixel 3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Mobile Safari/537.36',
  'Accept-Encoding': 'identity',
}

class DownloadAudioError extends Error {
  code: string
  // A download format restriction does not make this URL invalid for normal playback.
  isAudioProbeFailure = true
  constructor(reason: string) {
    super(`Download audio validation failed (${reason})`)
    this.code = reason
  }
}

const MIME_EXTENSIONS: Record<string, LX.Download.FileExt> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4a-latm': 'm4a',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/aac-adts': 'aac',
  'audio/ogg': 'ogg',
  'audio/vorbis': 'ogg',
  'audio/opus': 'opus',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ape': 'ape',
  'audio/x-ape': 'ape',
}

export const validateDownloadMedia = (quality: LX.Quality, media: RemoteAudioInfo): LX.Download.MediaInfo => {
  if (media.reason != null || !media.readable) throw new DownloadAudioError(media.reason ?? 'unreadable')
  if (media.hasVideo) throw new DownloadAudioError('not_audio')
  const mime = media.mime?.toLowerCase() ?? ''
  const codecExtension = MIME_EXTENSIONS[mime]
  if (!codecExtension) throw new DownloadAudioError('format_mismatch')
  const lossless = ['flac', 'wav', 'ape'].includes(codecExtension)
  // MP4 reports audio sample bytes, excluding artwork. Without that, total bytes give a conservative upper bound.
  const payloadBytes = (media.contentLength ?? 0) - Math.max(0, media.audioOffset ?? 0)
  const bitRate = Number.isFinite(media.bitRate) && media.bitRate! > 0 ? media.bitRate!
    : payloadBytes > 0 && (media.durationMs ?? 0) > 0 ? payloadBytes * 8000 / media.durationMs! : 0
  if (!lossless && (quality === '128k' || quality === '320k') && !(bitRate > 0)) throw new DownloadAudioError('bitrate_unavailable')
  if ((quality === '128k' && bitRate > 160000) || (quality === '320k' && (bitRate > 384000 || (bitRate > 0 && bitRate <= 160000)))) {
    throw new DownloadAudioError('quality_mismatch')
  }
  const highResolution = (media.bitDepth ?? 0) > 16 || (media.sampleRate ?? 0) > 48000
  if ((quality === '128k' || quality === '320k') ? lossless
    : quality === 'flac' ? codecExtension !== 'flac' || highResolution || !(media.bitDepth! > 0 && media.sampleRate! > 0)
      : quality === 'flac24bit' ? codecExtension !== 'flac' || !highResolution
        : codecExtension !== quality) throw new DownloadAudioError('quality_mismatch')
  // A codec MIME is not a filename container: AAC/Opus/FLAC can live inside MP4.
  const extension = media.headerKind === 'mp4' ? 'm4a' : media.headerKind === 'ogg' ? 'ogg' : codecExtension
  const mimeType = extension === 'm4a' ? 'audio/mp4' : extension === 'ogg' ? 'audio/ogg' : mime
  const contentLength = media.contentLength
  return {
    extension,
    mimeType,
    ...(Number.isSafeInteger(contentLength) && contentLength! > 0 ? { contentLength } : {}),
  }
}

export const inspectDownloadMedia = async(musicInfo: LX.Music.MusicInfoOnline, quality: LX.Quality,
  url: string, media: RemoteAudioInfo | undefined, signal: AbortSignal): Promise<LX.Download.MediaInfo | undefined> => {
  throwIfAborted(signal)
  if (!media) {
    // Non-QQ songs keep their existing path; QQ cross-platform matches still need verification.
    if (musicInfo.source !== 'tx') return
    media = await probeRemoteAudio(url, true, { signal })
    throwIfAborted(signal)
    if (media.reason != null || !media.readable) throw new DownloadAudioError(media.reason ?? 'unreadable')
    const expected = (musicInfo.interval?.split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0) ?? 0) * 1000
    const actual = media.durationMs ?? 0
    if (!(expected > 0 && actual > 0)) throw new DownloadAudioError('duration_unavailable')
    if (Math.abs(expected - actual) > Math.max(2000, expected / 50)) throw new DownloadAudioError('duration_mismatch')
  }
  return validateDownloadMedia(quality, media)
}
