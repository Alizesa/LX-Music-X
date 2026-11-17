// QQ's catalog bounds requests independently of any individual script's capabilities.
const QQ_QUALITIES: LX.Quality[] = ['flac24bit', 'flac', '320k', '128k']

const isAvailable = (info?: { size: string | null }): boolean => {
  if (!info) return false
  // Account playlist metadata can confirm availability without a formatted size.
  if (info.size == null || info.size.trim() === '') return true
  const size = Number.parseFloat(info.size)
  return Number.isFinite(size) && size > 0
}

export const getDownloadQualityOrder = (musicInfo: LX.Music.MusicInfoOnline, requested: LX.Quality): LX.Quality[] => {
  if (musicInfo.source !== 'tx') return [requested]
  const preferred = requested === '192k' ? '128k'
    : requested === 'ape' || requested === 'wav' ? 'flac' : requested
  const start = QQ_QUALITIES.indexOf(preferred)
  const order = QQ_QUALITIES.slice(Math.max(0, start)).filter(quality => isAvailable(musicInfo.meta._qualitys?.[quality]))
  // Old/imported songs with no reliable catalog data start conservatively at standard quality.
  return order.length ? order : ['128k']
}
