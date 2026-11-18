// QQ's catalog bounds requests independently of any individual script's capabilities.
const QQ_QUALITIES: LX.Quality[] = ['flac24bit', 'flac', '320k', '128k']

const isAvailable = (info?: { size: string | null }): boolean => {
  if (!info) return false
  // Account playlist metadata can confirm availability without a formatted size.
  if (info.size == null || info.size.trim() === '') return true
  const size = Number.parseFloat(info.size)
  return Number.isFinite(size) && size > 0
}

export const getDownloadQuality = (musicInfo: LX.Music.MusicInfoOnline, requested: LX.Quality): LX.Quality => {
  if (musicInfo.source !== 'tx') return requested
  const preferred = requested === '192k' ? '128k'
    : requested === 'ape' || requested === 'wav' ? 'flac' : requested
  const highest = QQ_QUALITIES.find(quality => isAvailable(musicInfo.meta._qualitys?.[quality]))
  // 只有超过 QQ 曲库最高音质时才降档；未知上限或取链失败都不能降低用户选择。
  const requestedIndex = QQ_QUALITIES.indexOf(preferred)
  return highest && requestedIndex >= 0 && requestedIndex < QQ_QUALITIES.indexOf(highest) ? highest : preferred
}
