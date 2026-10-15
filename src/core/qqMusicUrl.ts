import { getQQMusicSession, getQQMusicUin, postAuthedMusicu } from './qqMusic'

// QQ 的取票接口按文件名前缀区分音质，扩展名跟着前缀走
const QUALITY_SPEC: Partial<Record<LX.Quality, { prefix: string, extension: string }>> = {
  '128k': { prefix: 'M500', extension: 'mp3' },
  '320k': { prefix: 'M800', extension: 'mp3' },
  flac: { prefix: 'F000', extension: 'flac' },
  flac24bit: { prefix: 'RS01', extension: 'flac' },
}

// 逐档往下试的顺序。QQ 只有这四档，覆盖足够
const FALLBACK_ORDER: LX.Quality[] = ['flac24bit', 'flac', '320k', '128k']

// 固定 guid，和 tx SDK 的 comm 用同一个
const GUID = '1F70E520B2EAA7D25E11760783C53CA9'

// 试听地址带 src 参数
const TRIAL_RXP = /[?&]src=/i

const buildFilenames = (prefix: string, extension: string, songMid: string, mediaMid: string): string[] =>
  mediaMid
    ? [`${prefix}${mediaMid}.${extension}`, `${prefix}${mediaMid}${mediaMid}.${extension}`]
    : [`${prefix}${songMid}${songMid}.${extension}`, `${prefix}${songMid}.${extension}`]

/** 拼出可直接播放的绝对地址。purl 可能是相对路径，基址在响应的 sip 里。 */
const absolutize = (purl: string, sips: string[]): string | null => {
  const normalized = purl.startsWith('//') ? `https:${purl}` : purl
  if (/^https?:\/\//i.test(normalized)) return normalized
  const base = sips.map(item => item.trim()).find(item => item.startsWith('//') || /^https?:\/\//i.test(item))
  if (!base) return null
  const normalizedBase = base.startsWith('//') ? `https:${base}` : base
  return `${normalizedBase.replace(/\/+$/, '')}/${normalized.replace(/^\/+/, '')}`
}

const pickUrl = (data: any): { url: string, trial: boolean } | null => {
  const list: any[] = Array.isArray(data?.midurlinfo) ? data.midurlinfo : []
  const sips: string[] = Array.isArray(data?.sip) ? data.sip : []
  for (const info of list) {
    if (Number(info?.result ?? 0) !== 0) continue
    const candidates = [info?.purl, info?.wifiurl].filter((item): item is string => typeof item == 'string' && item.length > 0)
    for (const purl of candidates) {
      const url = absolutize(purl, sips)
      if (url) return { url, trial: TRIAL_RXP.test(url) }
    }
  }
  return null
}

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
  })
  return body?.req_1?.data
}

export interface QQAccountUrl {
  url: string
  quality: LX.Quality
}

/**
 * 用 QQ 账号直取播放地址。
 *
 * 免费可听的歌能拿到完整音源；VIP 歌服务端只给试听重定向（地址带 src 参数），
 * 这时返回 null，让调用方回落到用户 API 脚本的音源 —— 「免费可听走账号、
 * VIP 走音源」就落在这里。没登录、或这首歌没带 mid，同样返回 null。
 *
 * 逐档往下试：首选音质拿不到就退一档。各档都只给试听时，再用网页兼容票
 * (platform 20) 试一次 —— App 通道偶尔只会返回试听重定向，而这首其实是能听的。
 */
export const getQQMusicUrlByAccount = async(
  musicInfo: LX.Music.MusicInfo_tx,
  preferredQuality?: LX.Quality,
): Promise<QQAccountUrl | null> => {
  const meta = musicInfo.meta
  const songMid = String(meta.songId ?? '')
  if (!songMid) return null
  const { cookie } = await getQQMusicSession()
  if (!cookie) return null

  const order = preferredQuality && QUALITY_SPEC[preferredQuality]
    ? [preferredQuality, ...FALLBACK_ORDER.filter(quality => quality != preferredQuality)]
    : FALLBACK_ORDER

  const mediaMid = String(meta.strMediaMid ?? '')
  let trial: { quality: LX.Quality, filenames: string[], prefix: string } | null = null

  for (const quality of order) {
    const spec = QUALITY_SPEC[quality]
    if (!spec) continue
    const filenames = buildFilenames(spec.prefix, spec.extension, songMid, mediaMid)
    let data
    try {
      data = await requestVkey(cookie, songMid, filenames, spec.prefix, '23')
    } catch {
      continue
    }
    const picked = pickUrl(data)
    if (!picked) continue
    if (!picked.trial) return { url: picked.url, quality }
    // 只拿到试听：先记下这一档，继续往下试更低的
    trial ??= { quality, filenames, prefix: spec.prefix }
  }

  if (trial) {
    try {
      const data = await requestVkey(cookie, songMid, trial.filenames, trial.prefix, '20')
      const picked = pickUrl(data)
      if (picked && !picked.trial) return { url: picked.url, quality: trial.quality }
    } catch {
      // 兼容票也失败就按「拿不到」处理，交给音源
    }
  }
  return null
}
