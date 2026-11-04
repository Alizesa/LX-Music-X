import { getQQMusicSession, getQQMusicUin, postAuthedMusicu, QQMusicSessionExpiredError } from './qqMusic'
import { probeRemoteAudio } from '@/utils/nativeModules/remoteAudio'
import { isRequestCancelled } from '@/utils/message'

// QQ 的取票接口按文件名前缀区分音质，扩展名跟着前缀走
const QUALITY_SPEC: Partial<Record<LX.Quality, { prefix: string, extension: string }>> = {
  '128k': { prefix: 'M500', extension: 'mp3' },
  '320k': { prefix: 'M800', extension: 'mp3' },
  flac: { prefix: 'F000', extension: 'flac' },
  flac24bit: { prefix: 'RS01', extension: 'flac' },
}

// 逐档往下试的顺序。QQ 只有这四档，覆盖足够
const FALLBACK_ORDER: LX.Quality[] = ['flac24bit', 'flac', '320k', '128k']

/**
 * 试链顺序：从 maxQuality 这一档开始往下，首选档（没超过上限的话）排最前。
 *
 * 每档最多请求 App / 网页两张票，所以这个上限是有意义的：没开会员的账号只有标准音质，
 * 把 maxQuality 传成 '128k' 时这里只剩一档，不会再白试上面那三档。
 */
const buildTryOrder = (preferredQuality: LX.Quality | undefined, maxQuality: LX.Quality): LX.Quality[] => {
  const ceiling = Math.max(0, FALLBACK_ORDER.indexOf(maxQuality))
  const allowed = FALLBACK_ORDER.slice(ceiling)
  if (!preferredQuality || !QUALITY_SPEC[preferredQuality] || !allowed.includes(preferredQuality)) return allowed
  return [preferredQuality, ...allowed.filter(quality => quality != preferredQuality)]
}

// 固定 guid，和 tx SDK 的 comm 用同一个
const GUID = '1F70E520B2EAA7D25E11760783C53CA9'

// src 表示可能重定向到试听，仍须检查真实媒体时长。
const TRIAL_RXP = /[?&]src=/i

const buildFilenames = (prefix: string, extension: string, songMid: string, mediaMid: string): string[] =>
  mediaMid
    ? [`${prefix}${mediaMid}.${extension}`, `${prefix}${mediaMid}${mediaMid}.${extension}`]
    : [`${prefix}${songMid}${songMid}.${extension}`, `${prefix}${songMid}.${extension}`]

const normalizeUrl = (value: string) => value.startsWith('//') ? `https:${value}` : value.replace(/^http:/i, 'https:')

/** 保留全部 CDN 和 wifiurl 候选，首个地址失效时仍能在账号内回退。 */
const buildUrlCandidates = (purls: string[], sips: string[]): string[] => {
  const bases = sips.map(value => normalizeUrl(value.trim())).filter(value => /^https:\/\//i.test(value))
  const urls = new Set<string>()
  for (const purl of purls) {
    const normalized = normalizeUrl(purl)
    const absolute = /^https:\/\//i.test(normalized)
    if (absolute) urls.add(normalized)
    const path = absolute ? normalized.replace(/^https:\/\/[^/]+\//i, '') : normalized.replace(/^\/+/, '')
    for (const base of bases) urls.add(`${base.replace(/\/+$/, '')}/${path}`)
  }
  return [...urls]
}

const getDurationMs = (interval: string | null): number => {
  if (!interval || !/^\d+(?::\d{1,2}){1,2}$/.test(interval)) return 0
  return interval.split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0) * 1000
}

const pickUrl = async(data: any, quality: LX.Quality, expectedMs: number): Promise<string | null> => {
  const list: any[] = Array.isArray(data?.midurlinfo) ? data.midurlinfo : []
  const sips: string[] = Array.isArray(data?.sip) ? data.sip.filter((item: unknown) => typeof item === 'string') : []
  const spec = QUALITY_SPEC[quality]!
  const purls: string[] = []
  for (const info of list) {
    if (Number(info?.result ?? 0) !== 0) continue
    for (const raw of [info?.purl, info?.wifiurl]) {
      if (typeof raw !== 'string' || !raw.trim()) continue
      const purl = raw.trim()
      const filename = purl.split(/[?#]/)[0].split('/').pop()!.toLowerCase()
      // 服务端可能返回其他音质，不能把它标成请求的音质。
      if (filename.startsWith(spec.prefix.toLowerCase()) && filename.endsWith(`.${spec.extension}`)) purls.push(purl)
    }
  }
  const candidates = buildUrlCandidates(purls, sips)
  // 先试普通直链，避免第一项是试听时漏掉后面的完整地址。
  candidates.sort((a, b) => Number(TRIAL_RXP.test(a)) - Number(TRIAL_RXP.test(b)))
  for (const url of candidates) {
    const inspectDuration = TRIAL_RXP.test(url)
    if (inspectDuration && expectedMs <= 0) continue
    const media = await probeRemoteAudio(url, inspectDuration)
    if (!media.readable) continue
    if (!inspectDuration) return url
    const expectedMime = quality === 'flac' || quality === 'flac24bit' ? 'audio/flac' : 'audio/mpeg'
    const actualMs = media.durationMs ?? 0
    // MusicOne 的容差：2 秒或歌曲时长的 2%，取较大值。
    if (media.mime === expectedMime && actualMs > 0 && Math.abs(actualMs - expectedMs) <= Math.max(2000, expectedMs / 50)) return url
  }
  return null
}

class QQMusicVkeyError extends Error {}

const requestVkey = async(cookie: string, songMid: string, filenames: string[], prefix: string, platform: '23' | '20') => {
  const param: Record<string, unknown> = {
    guid: GUID,
    songmid: filenames.map(() => songMid),
    songtype: filenames.map(() => 0),
    uin: getQQMusicUin(cookie) || '0',
    loginflag: 1,
    platform,
    filename: filenames,
  }
  // platform 23 是 App 点播通道，这几个字段是它特有的；20 是网页兼容票，不能带
  if (platform == '23') {
    Object.assign(param, {
      h5queryversion: 1, nettype: '', cms: 0, firstlogin: 1, newver: 1, nohash: 0, quality: prefix,
    })
  }
  const body = await postAuthedMusicu(cookie, {
    req_1: { module: 'music.vkey.GetVkey', method: 'UrlGetVkey', param },
  }, {}, platform === '20' ? 'web' : 'app')
  // 业务失败不再伪装成空地址、逐档重试；外层仍可交给音源兜底。
  const code = Number(body?.code ?? 0) || Number(body?.req_1?.code ?? 0)
  if (code) throw new QQMusicVkeyError(`QQ Music vkey ${code}`)
  return body?.req_1?.data
}

export interface QQAccountUrl {
  url: string
  quality: LX.Quality
}

/**
 * 用 QQ 账号直取播放地址。
 *
 * 账号能拿到完整音频时直接使用，只有无法取得完整音频才回落用户音源。
 * 带 src 的地址会核对实际音频时长，不以 URL 参数判断会员权限。
 *
 * 每档先试 App，再试网页兼容票（platform 20），均不可用才降档。
 * 空地址、不可读地址、试听或网络异常都会尝试网页票；登录/业务错误停止账号重试。
 *
 * maxQuality 是这次允许试到的最高档，调用方按「用户选的音质」+「账号有没有会员」来传，
 * 不传按无损处理（等于不设限）。每档最多请求两张票，所以把上限收窄是有意义的：
 * 没开会员的账号只有标准音质，传 '128k' 时就只剩这一档，不会再白试上面那三档。
 */
export const getQQMusicUrlByAccount = async(
  musicInfo: LX.Music.MusicInfo_tx,
  preferredQuality?: LX.Quality,
  maxQuality: LX.Quality = 'flac24bit',
): Promise<QQAccountUrl | null> => {
  const meta = musicInfo.meta
  const songMid = String(meta.songId ?? '').trim()
  if (!songMid) return null
  const { cookie } = await getQQMusicSession()
  if (!cookie) return null

  const order = buildTryOrder(preferredQuality, maxQuality)

  const mediaMid = String(meta.strMediaMid ?? '').trim()
  const expectedMs = getDurationMs(musicInfo.interval)

  for (const quality of order) {
    const spec = QUALITY_SPEC[quality]
    if (!spec) continue
    const filenames = buildFilenames(spec.prefix, spec.extension, songMid, mediaMid)
    for (const platform of ['23', '20'] as const) {
      try {
        const data = await requestVkey(cookie, songMid, filenames, spec.prefix, platform)
        const url = await pickUrl(data, quality, expectedMs)
        if (url) return { url, quality }
      } catch (error) {
        if (isRequestCancelled(error) || error instanceof QQMusicSessionExpiredError || error instanceof QQMusicVkeyError) throw error
        // 不输出签名 URL / Cookie，保留取链通道以便定位失败。
        console.warn(`[QQMusic] 账号取链请求失败: song=${songMid}, platform=${platform}, quality=${quality}`)
      }
    }
  }
  return null
}
