import { sizeFormate } from '../../index'

const QUALITY_SIZES = [
  ['128k', 'size_128mp3'],
  ['320k', 'size_320mp3'],
  ['flac', 'size_flac'],
  ['flac24bit', 'size_hires'],
]

export const buildMusicQuality = (file) => {
  const types = []
  const _types = {}
  for (const [type, key] of QUALITY_SIZES) {
    const raw = file?.[key]
    if (typeof raw !== 'number' && typeof raw !== 'string') continue
    const bytes = Number(raw)
    if (!Number.isFinite(bytes) || bytes <= 0) continue
    const size = sizeFormate(bytes)
    types.push({ type, size })
    _types[type] = { size }
  }
  return { types, _types }
}
