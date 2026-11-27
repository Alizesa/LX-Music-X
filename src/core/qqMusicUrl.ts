import { getQQMusicSession, getQQMusicUin, postAuthedMusicu, QQMusicSessionExpiredError } from './qqMusic'
import { probeRemoteAudio, type RemoteAudioInfo } from '@/utils/nativeModules/remoteAudio'
import { isRequestCancelled, requestMsg } from '@/utils/message'
import { throwIfAborted, withAbort } from '@/utils/abort'
import BackgroundTimer from 'react-native-background-timer'
import { playbackLog, type PlaybackLogContext } from '@/utils/playbackLog'
import { getMusicDurationMs as getDurationMs, musicAudioFailure as audioFailure } from './musicUrlValidation'

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

// src 只用于候选排序；不带它的地址也可能返回试听。
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

interface AccountUrlOptions {
  isRefresh?: boolean
  onCancel?: (cancel: () => void) => void
  /** 下载必须保持指定音质；播放默认允许依次降档。 */
  allowQualityFallback?: boolean
  /** 在候选选择前跳过已播放失败或仍在冷却的地址，不占用媒体探测预算。 */
  isUrlRejected?: (url: string) => boolean
  trace?: PlaybackLogContext
  expectedMusicInfo?: LX.Music.MusicInfo
}

const pickUrl = async(data: any, quality: LX.Quality, expectedMs: number, signal: AbortSignal, isRefresh: boolean,
  trace: PlaybackLogContext & { musicId: string, platform: string }, isUrlRejected?: (url: string) => boolean): Promise<{ url: string, media: RemoteAudioInfo } | null> => {
  throwIfAborted(signal)
  const list: any[] = Array.isArray(data?.midurlinfo) ? data.midurlinfo : []
  const sips: string[] = Array.isArray(data?.sip) ? data.sip.filter((item: unknown) => typeof item === 'string') : []
  const spec = QUALITY_SPEC[quality]!
  const expectedMime = spec.extension === 'flac' ? 'audio/flac' : 'audio/mpeg'
  const purls: string[] = []
  let returnedUrls = 0
  for (const info of list) {
    if (Number(info?.result ?? 0) !== 0) continue
    for (const raw of [info?.purl, info?.wifiurl]) {
      if (typeof raw !== 'string' || !raw.trim()) continue
      returnedUrls++
      const purl = raw.trim()
      const filename = purl.split(/[?#]/)[0].split('/').pop()!.toLowerCase()
      // 服务端可能返回其他音质，不能把它标成请求的音质。
      if (filename.startsWith(spec.prefix.toLowerCase()) && filename.endsWith(`.${spec.extension}`)) purls.push(purl)
    }
  }
  const candidates = buildUrlCandidates(purls, sips)
  // 先试普通直链，避免第一项是试听时漏掉后面的完整地址。
  candidates.sort((a, b) => Number(TRIAL_RXP.test(a)) - Number(TRIAL_RXP.test(b)))
  const selected = candidates.filter(url => !isUrlRejected?.(url)).slice(0, 6)
  playbackLog('url.account_candidates', () => ({
    ...trace,
    quality,
    expectedMs,
    returnedUrls,
    candidates: candidates.length,
    selected: selected.length,
    resultCodes: list.slice(0, 6).map(info => Number(info?.result ?? 0)),
    reason: selected.length ? 'checking' : candidates.length ? 'rejected_urls' : returnedUrls ? 'quality_mismatch'
      : list.some(info => Number(info?.result ?? 0) !== 0) ? 'item_rejected' : 'empty_urls',
  }))
  if (!selected.length) return null
  // 每个响应最多探测 6 个候选、同时 3 个，整批含时长检查最多 5 秒。
  return new Promise<{ url: string, media: RemoteAudioInfo } | null>((resolve, reject) => {
    const controller = new AbortController()
    let done = false
    let next = 0
    const startedAt = Date.now()
    const finish = (value: { url: string, media: RemoteAudioInfo } | null, error?: unknown, reason = value ? 'complete' : 'candidates_rejected') => {
      if (done) return
      done = true
      playbackLog('url.account_candidates_done', () => ({ ...trace, quality, reason, available: !!value, attempted: next, elapsedMs: Date.now() - startedAt }))
      BackgroundTimer.clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      controller.abort()
      if (error) reject(error)
      else resolve(value)
    }
    const onAbort = () => { finish(null, new Error(requestMsg.cancelRequest), 'cancelled') }
    const timer = BackgroundTimer.setTimeout(() => { finish(null, undefined, 'timeout') }, 5000)
    signal.addEventListener('abort', onAbort)
    if (signal.aborted) { onAbort(); return }
    const worker = async() => {
      while (next < selected.length) {
        if (done) return
        const url = selected[next++]
        if (isUrlRejected?.(url)) continue
        const probeStartedAt = Date.now()
        const media = await probeRemoteAudio(url, true, { signal: controller.signal, isRefresh, timeoutMs: 5000 })
        if (done) return
        // 探测期间其他播放/预加载请求也可能标记这个 URL 失败，迟到结果不能重新选中它。
        const resolvedUrl = media.resolvedUrl ?? url
        const reason = isUrlRejected?.(url) === true || (resolvedUrl !== url && isUrlRejected?.(resolvedUrl) === true)
          ? 'rejected_url' : audioFailure(media, expectedMs, expectedMime)
        playbackLog('url.account_probe', () => ({
          ...trace,
          quality,
          url,
          expectedMs,
          expectedMime,
          probe: media,
          reason: reason ?? 'complete',
          accepted: !reason,
          elapsedMs: Date.now() - probeStartedAt,
        }))
        if (!reason) finish({ url, media })
      }
    }
    void Promise.all(Array.from({ length: Math.min(3, selected.length) }, worker))
      .then(() => { finish(null) }, error => { finish(null, error) })
  })
}

class QQMusicVkeyError extends Error {}

const requestVkey = async(cookie: string, songMid: string, filenames: string[], prefix: string, platform: '23' | '20', signal: AbortSignal) => {
  throwIfAborted(signal)
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
  }, {}, platform === '20' ? 'web' : 'app', signal)
  // 业务失败不再伪装成空地址、逐档重试；外层仍可交给音源兜底。
  const code = Number(body?.code ?? 0) || Number(body?.req_1?.code ?? 0)
  if (code) throw new QQMusicVkeyError(`QQ Music vkey ${code}`)
  return body?.req_1?.data
}

export interface QQAccountUrl {
  media?: RemoteAudioInfo
  url: string
  quality: LX.Quality
}

/**
 * 用 QQ 账号直取播放地址。
 *
 * 账号能拿到完整音频时直接使用，只有无法取得完整音频才回落用户音源。
 * 所有地址都核对实际音频时长与格式，不以 URL 参数判断是否完整。
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
  options: AccountUrlOptions = {},
): Promise<QQAccountUrl | null> => {
  const meta = musicInfo.meta
  const songMid = String(meta.songId ?? '').trim()
  const expectedMs = getDurationMs(options.expectedMusicInfo?.interval) || getDurationMs(musicInfo.interval)
  // 无法比较完整时长时直接交给音源，避免取回试听后误当作完整音频。
  if (!songMid || !expectedMs) {
    playbackLog('url.account_skip', () => ({ ...options.trace, musicId: musicInfo.id, expectedMs, reason: !songMid ? 'missing_song_id' : 'duration_unavailable' }))
    return null
  }
  const controller = new AbortController()
  const { signal } = controller
  let timedOut = false
  // 账号整条链也设上限，避免多个音质/通道的等待累加到播放器自动跳歌。
  const timer = BackgroundTimer.setTimeout(() => {
    if (signal.aborted) return
    timedOut = true
    controller.abort()
  }, 30000)
  try {
    options.onCancel?.(() => { controller.abort() })
    throwIfAborted(signal)
    const { cookie } = await withAbort(getQQMusicSession(), signal)
    if (!cookie) {
      playbackLog('url.account_skip', () => ({ ...options.trace, musicId: musicInfo.id, reason: 'no_session' }))
      return null
    }
    const order = buildTryOrder(preferredQuality, maxQuality)
      .filter(quality => options.allowQualityFallback !== false || quality === (preferredQuality ?? maxQuality))
    playbackLog('url.account_plan', () => ({ ...options.trace, musicId: musicInfo.id, expectedMs, qualities: order }))
    const mediaMid = String(meta.strMediaMid ?? '').trim()
    for (const quality of order) {
      const spec = QUALITY_SPEC[quality]
      if (!spec) continue
      const filenames = buildFilenames(spec.prefix, spec.extension, songMid, mediaMid)
      for (const platform of ['23', '20'] as const) {
        const trace = { ...options.trace, musicId: musicInfo.id, platform }
        const startedAt = Date.now()
        try {
          playbackLog('url.account_channel_start', () => ({ ...trace, quality }))
          const data = await requestVkey(cookie, songMid, filenames, spec.prefix, platform, signal)
          playbackLog('url.account_channel_response', () => ({ ...trace, quality, elapsedMs: Date.now() - startedAt }))
          const result = await pickUrl(data, quality, expectedMs, signal, options.isRefresh ?? false, trace, options.isUrlRejected)
          throwIfAborted(signal)
          if (result) return { ...result, quality }
        } catch (error) {
          playbackLog('url.account_channel_failed', () => ({ ...trace, quality, error, elapsedMs: Date.now() - startedAt }))
          throwIfAborted(signal)
          if (isRequestCancelled(error) || error instanceof QQMusicSessionExpiredError || error instanceof QQMusicVkeyError) throw error
          console.warn(`[QQMusic] 账号取链请求失败: song=${songMid}, platform=${platform}, quality=${quality}`)
        }
      }
    }
    return null
  } catch (error) {
    // 超时允许音源接手，用户取消则必须终止整个播放请求。
    if (timedOut && isRequestCancelled(error)) {
      playbackLog('url.account_timeout', () => ({ ...options.trace, musicId: musicInfo.id }))
      return null
    }
    throw error
  } finally {
    BackgroundTimer.clearTimeout(timer)
    controller.abort()
  }
}
