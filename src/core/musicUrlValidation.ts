import { discardRedirectedAudioProbe, probeRemoteAudio, type RemoteAudioInfo } from '@/utils/nativeModules/remoteAudio'
import { throwIfAborted } from '@/utils/abort'
import { playbackLog, type PlaybackLogContext } from '@/utils/playbackLog'

export { discardRedirectedAudioProbe }

export const getMusicDurationMs = (interval: string | null | undefined): number => {
  if (!interval || !/^\d+(?::[0-5]?\d){1,2}$/.test(interval)) return 0
  const durationMs = interval.split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0) * 1000
  return Number.isFinite(durationMs) ? durationMs : 0
}

export const musicAudioFailure = (media: RemoteAudioInfo, expectedMs: number, expectedMime?: string): string | undefined => {
  if (media.reason) return media.reason
  if (!media.readable) return 'unreadable'
  if (media.hasVideo) return 'not_audio'
  if (!media.mime) return 'metadata_unavailable'
  if (!media.mime.startsWith('audio/')) return 'not_audio'
  const actualMs = media.durationMs ?? 0
  if (!Number.isFinite(expectedMs) || !Number.isFinite(actualMs) || !(expectedMs > 0 && actualMs > 0)) return 'duration_unavailable'
  // 2 秒或歌曲时长的 2%，取较大值；短歌曲也按自身时长核对。
  if (Math.abs(actualMs - expectedMs) > Math.max(2000, expectedMs / 50)) return 'duration_mismatch'
  if (expectedMime && media.mime !== expectedMime) return 'format_mismatch'
}

class MusicAudioError extends Error {
  code: string
  isAudioProbeFailure: boolean
  constructor(reason: string) {
    super(reason === 'duration_mismatch' ? 'Music audio is incomplete'
      : reason === 'timeout' ? 'Music audio probe timed out'
        : reason === 'duration_unavailable' || reason === 'metadata_unavailable' ? 'Music audio duration unavailable'
          : `Music audio probe failed (${reason})`)
    this.code = reason
    // 探测能力或预算不足不能证明音源坏了，后台预加载不能因此冷却前台音源。
    this.isAudioProbeFailure = ['timeout', 'byte_limit', 'metadata_limit', 'invalid_metadata', 'metadata_error', 'metadata_unavailable',
      'duration_unavailable', 'native_error', 'native_unavailable', 'busy', 'range_unsupported', 'invalid_range'].includes(reason)
  }
}

/** 所有平台、代理与缓存共用完整性检查，接受链接和预读音频前必须完成。 */
export const validateMusicUrl = async(
  musicInfo: LX.Music.MusicInfo,
  url: string,
  onCancel?: (cancel: () => void) => void,
  isRefresh = false,
  trace?: PlaybackLogContext & { apiId?: string },
  expectedMusicInfo: LX.Music.MusicInfo = musicInfo,
): Promise<RemoteAudioInfo | undefined> => {
  if (!/^https?:\/\//i.test(url)) return
  const controller = new AbortController()
  try {
    onCancel?.(() => { controller.abort() })
    throwIfAborted(controller.signal)
    // 原曲有时长时始终按原曲核对；原曲缺失时才使用匹配歌曲的时长。
    const expectedMusic = getMusicDurationMs(expectedMusicInfo.interval) ? expectedMusicInfo : musicInfo
    const expectedMs = getMusicDurationMs(expectedMusic.interval)
    if (!expectedMs) {
      playbackLog('url.audio_check', () => ({ ...trace, musicId: musicInfo.id, musicSource: musicInfo.source, expectedMs, reason: 'duration_unavailable', accepted: false }))
      throw new MusicAudioError('duration_unavailable')
    }
    const startedAt = Date.now()
    const media = await probeRemoteAudio(url, true, { signal: controller.signal, isRefresh })
    throwIfAborted(controller.signal)
    // 脚本的音质标签不代表容器格式，完整 AAC/M4A 等音频也可以正常播放。
    const reason = musicAudioFailure(media, expectedMs)
    playbackLog('url.audio_check', () => ({
      ...trace,
      musicId: musicInfo.id,
      musicSource: musicInfo.source,
      url,
      expectedMs,
      expectedMusic: { id: expectedMusic.id, name: expectedMusic.name, singer: expectedMusic.singer, album: expectedMusic.meta.albumName },
      probe: media,
      reason: reason ?? 'complete',
      accepted: !reason,
      elapsedMs: Date.now() - startedAt,
    }))
    if (reason) {
      const error = new MusicAudioError(reason)
      // 中转地址下次可能换一份音频，失败只说明当前目标不可用。
      if (media.resolvedUrl && media.resolvedUrl !== url) {
        discardRedirectedAudioProbe(url, media)
        error.isAudioProbeFailure = true
      }
      // 替代版本本身完整，只是与原曲不符时，不能全局禁用这个文件或冷却替代歌曲。
      if (reason === 'duration_mismatch' && !musicAudioFailure(media, getMusicDurationMs(musicInfo.interval))) error.isAudioProbeFailure = true
      throw error
    }
    return media
  } finally {
    controller.abort()
  }
}
