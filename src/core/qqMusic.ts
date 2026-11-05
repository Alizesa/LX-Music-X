import { httpFetch } from '@/utils/request'
import { throwIfAborted, withAbort } from '@/utils/abort'
import {
  getQQMusicCookie,
  getQQMusicUser,
  saveQQMusicCookie,
  saveQQMusicUser,
  removeQQMusicCookie,
  getQQMusicPlaylistsCache,
  saveQQMusicPlaylistsCache,
  removeQQMusicPlaylistsCache,
  removeQQMusicDailyPlaylistCache,
  removeQQMusicDailyRecommendCache,
  removeQQMusicHeartRadarCache,
  removeQQMusicRecommendPlaylistsCache,
  removeQQMusicRefreshDay,
} from '@/utils/data'
import { toNewMusicInfo, decodeName } from '@/utils'
import musicSdk from '@/utils/musicSdk'
import { clearPlaylistSongsCache } from './qqMusicPlaylistSongsCache'
import CookieManager from '@react-native-cookies/cookies'
import {
  QQ_APP_USER_AGENT,
  QQ_USER_AGENT,
  getQQMusicUin,
  isQQMusicCookie,
  normalizeUin,
  parseQQMusicCookie,
  readAppLoginType,
  readMusicKey,
  readUin,
  serializeQQMusicCookie,
} from './qqMusicCookie'
import {
  hasQQMusicRefreshCredential,
  requestQQMusicCredentialRefresh,
  shouldRefreshQQMusicCookie,
} from './qqMusicLogin'
import {
  PROFILE_AVATAR_KEYS,
  PROFILE_NICK_KEYS,
  findProfileField,
  isQQMusicFallbackAvatar,
  isQQMusicFallbackNickname,
} from './qqMusicProfile'

export {
  QQ_APP_USER_AGENT,
  QQ_USER_AGENT,
  getQQMusicAuthKey,
  getQQMusicUin,
  isQQMusicCookie,
  parseQQMusicCookie,
} from './qqMusicCookie'

const QQ_MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
// 用 c6 这个主机：c.y.qq.com 是老站点，资料接口在它上面拿不到头像
const QQ_PROFILE_URL = 'https://c6.y.qq.com/rsc/fcgi-bin/fcg_get_profile_homepage.fcg'
const QQ_CREATED_PLAYLIST_URL = 'https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss'
const QQ_COLLECTED_PLAYLIST_URL = 'https://c.y.qq.com/fav/fcgi-bin/fcg_get_profile_order_asset.fcg'
// 注意是 fcg-bin 而不是 fcgi-bin：写成 fcgi-bin 会直接 404
const QQ_PLAYLIST_DETAIL_URL = 'https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg'
// "我喜欢"在歌单列表里是 dirid=201 的虚拟歌单，旧接口取不到，必须走 CgiGetDiss
const LIKED_PLAYLIST_DIRID = 201
// 每日推荐同样是 dirid 定位的虚拟歌单，和「我喜欢」走同一条 CgiGetDiss 通道
const DAILY_RECOMMEND_DIRID = 202
const DISS_PAGE_SIZE = 100
const DISS_MAX_PAGES = 20
const QQ_REFERER = 'https://y.qq.com/'
// 个人主页相关接口对 Referer 敏感，必须是个人页而不是首页
const QQ_PROFILE_REFERER = 'https://y.qq.com/portal/profile.html'
const QQ_COOKIE_URLS = ['https://y.qq.com/', 'https://qq.com/', 'https://c.y.qq.com/', 'https://u.y.qq.com/']

// 页面级接口用的浏览器 UA（WebView 登录已单独用 QQ_USER_AGENT）
const QQ_WEB_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

const RECOMMEND_TARGET = 20
const RECOMMEND_MAX_TRIES = 6
// "猜你喜欢"电台的 id。不传这个 id，服务端会当成匿名默认电台，
// 返回一堆通用曲目且 code 仍是 0 —— 表现就是"推荐的不是我的风格"。
// 传了它之后个人化受票据门控，票据不被接受会明确返回 code 1000。
const GUESS_RECOMMEND_ID = 99
// 一次向电台要多少首。要满一份（= RECOMMEND_TARGET），一轮就够；
// 服务端要是只回一部分，下面的循环会接着补齐（参考实现一次也是要满 20）
const RECOMMEND_PAGE_SIZE = 20
const PLAYLIST_PAGE_SIZE = 200
// 首页推荐歌单一次展示多少张。从音乐流里抽歌单卡，8 张足够铺满一屏横滑
const RECOMMEND_PLAYLIST_LIMIT = 8
// 音乐流里歌单卡的标识（对齐 MusicOne 的 QqMusicFeedProtocol）
const FEED_PLAYLIST_JUMP_TYPE = 10014
const FEED_PLAYLIST_SERVER_TYPE = 500
const FEED_AI_FOLDER_SUBTYPE = 2001
const FEED_DAILY_30_STYLE = 7
const FEED_DAILY_30_SUBTYPE = 510
const FEED_FOLDER_STYLES = new Set([1, 2, 5, 47, 54, 55, 84, 93, 201, 205, 210, 241, 302])

// QQ 网页接口认的是「o + 10 位补零」的 uin（MusicOne 的登录凭据也是这个格式）。
// 手机号登录没有 p_uin/ptui_loginuin 这些网页别名，只写纯数字时资料接口可能认不出账号。
const formatStoredUin = (raw: unknown, fallback = '') => {
  const normalized = normalizeUin(raw)
  // 「0」是网页登录常见的占位值，不能当成真账号；有 fallback 时用它补上
  const value = normalized && normalized !== '0' ? normalized : fallback
  return value && value !== '0' ? `o${value.padStart(10, '0')}` : value
}

// 旧版本存的是纯数字 uin：读会话时顺手迁移成网页格式，不用用户重新登录
const migrateStoredUin = (cookie: string) => {
  const cookies = parseQQMusicCookie(cookie)
  // 以现有 uin 为准；只有 uin 缺失/是占位 0 时才退回 readUin
  // （微信登录的 wxuin 和 uin 不一定是同一个值，不能拿它覆盖已有 uin）
  const formatted = formatStoredUin(cookies.uin, readUin(cookies))
  if (!formatted || cookies.uin === formatted) return null
  cookies.uin = formatted
  return serializeQQMusicCookie(cookies)
}

// 续期成功后重放请求时，App 信封的 authst 写在 body.comm 里；只换 Cookie 头
// 服务端仍会按旧票据拒绝，所以这里把 comm 里的身份字段一起换成新值。
// 不新增字段，保持原来的信封形状（buildAuthComm / 网页 comm / 精简 comm 都可能走这里）。
const updateCommCredential = (comm: unknown, cookie: string) => {
  if (!comm || typeof comm != 'object' || Array.isArray(comm)) return null
  const current = comm as Record<string, unknown>
  const cookies = parseQQMusicCookie(cookie)
  const uin = readUin(cookies)
  const authst = readMusicKey(cookies)
  const next = { ...current }
  if ('uin' in next && uin) next.uin = uin
  if ('qq' in next && uin) next.qq = uin
  if ('authst' in next && authst) next.authst = authst
  if ('tmeLoginType' in next) next.tmeLoginType = readAppLoginType(cookies)
  return next
}

const request = async(url: string, cookie: string, options: Record<string, any> = {}, autoCleanExpired = true, signal?: AbortSignal): Promise<any> => {
  throwIfAborted(signal)
  const generation = sessionGeneration
  const pendingRequest = httpFetch(url, {
    ...options,
    headers: {
      Referer: QQ_REFERER,
      Origin: 'https://y.qq.com',
      // UA 按接口分：musicu.fcg 是手机 App 接口，要和 App 信封配套；
      // 其余（资料、歌单列表这类页面级 .fcg）是网页端的，必须用登录时那套浏览器 UA，
      // 换成 App UA 会被拒 —— 这也是头像一度取不到的原因。
      'User-Agent': url == QQ_MUSICU_URL ? QQ_APP_USER_AGENT : QQ_USER_AGENT,
      // 未登录时不要发一个空的 Cookie 头
      ...(cookie ? { Cookie: cookie } : {}),
      ...(options.headers ?? {}),
    },
  })
  const result = await withAbort(pendingRequest.promise, signal, () => { pendingRequest.cancelHttp() })
  throwIfAborted(signal)
  if (result.statusCode < 200 || result.statusCode >= 300) throw new Error(`QQ Music HTTP ${result.statusCode}`)
  const body = result.body as any
  // 所有带票据的请求都从这里过，过期就在这一处识别并清理，不再逐个接口手写判断。
  // 只在确实带了完整票据(Cookie)时才判定：未登录的匿名请求同样会碰到过期码，
  // 那种情况不该被当成"登录失效"。
  // autoCleanExpired=false 用在登录流程：那里失败只代表这次 Cookie 不对，
  // 不能顺手把已经登录的会话清掉（否则用户换个号输错一次就被踢下线）
  if (autoCleanExpired && isQQMusicCookie(cookie) && hasExpiredSession(body)) {
    if (generation !== sessionGeneration || pendingSessionChanges) throw new QQMusicSessionExpiredError()
    // 先试着续期：手机号登录的票据带 refresh_token，续成之后这个请求可以直接重放一次。
    // 续期失败才按原来的逻辑清会话、通知界面重新登录。
    const refreshed = await withAbort(refreshQQMusicCookie(cookie, true), signal)
    throwIfAborted(signal)
    if (generation !== sessionGeneration || pendingSessionChanges) throw new QQMusicSessionExpiredError()
    if (refreshed && refreshed !== cookie) {
      let retryOptions = options
      const requestBody = options.body
      if (url == QQ_MUSICU_URL && requestBody && typeof requestBody == 'object' && !Array.isArray(requestBody)) {
        const comm = updateCommCredential((requestBody as Record<string, unknown>).comm, refreshed)
        if (comm) retryOptions = { ...options, body: { ...requestBody, comm } }
      }
      const retried: any = await request(url, refreshed, retryOptions, false, signal)
      if (!hasExpiredSession(retried)) return retried
    }
    // 会话可能已经被用户换号/退出：别拿旧请求的过期去清掉新账号的会话
    const current = await readSessionCookie(generation).catch(() => null)
    throwIfAborted(signal)
    const currentUin = current ? readUin(parseQQMusicCookie(current)) : ''
    const requestUin = readUin(parseQQMusicCookie(cookie))
    if (generation !== sessionGeneration || pendingSessionChanges || !current || (currentUin && requestUin && currentUin !== requestUin)) {
      throw new QQMusicSessionExpiredError()
    }
    handleExpiredSession()
    throw new QQMusicSessionExpiredError()
  }
  return body
}

// 同一次过期可能有一屏接口同时在飞，续期只做一次，大家共用结果。
let refreshPromise: Promise<string | null> | null = null
// 主动续期失败后先退避一分钟：断网时不能每次读会话都打一次 15s 超时的请求
let refreshRetryAt = 0
// 登录/退出会递增。在途续期回来发现代次变了，就不能再写回旧账号的票据
let sessionGeneration = 0
// 清理期间存储里可能仍有旧 Cookie，不能把它作为可用会话返回。
let pendingSessionChanges = 0
// 冷启动时多个页面会同时读会话；uin 迁移只排一次写盘
let uinMigrationQueued = false
// 歌单读改写、票据写入和完整的会话切换共用队列：退出必须等已开始的写入落盘再清理。
let sessionWriteQueue: Promise<void> = Promise.resolve()
const queueSessionWrite = async<T>(write: () => Promise<T>): Promise<T> => {
  const next = sessionWriteQueue.then(write)
  sessionWriteQueue = next.then(() => {}, () => {})
  return next
}

const changeQQMusicSession = async<T>(change: () => Promise<T>): Promise<T> => {
  // 在排队前失效，不能等清理完成或 Cookie 删除后才阻止旧请求。
  sessionGeneration++
  pendingSessionChanges++
  refreshPromise = null
  refreshRetryAt = 0
  try {
    return await queueSessionWrite(change)
  } finally {
    pendingSessionChanges--
  }
}

export interface QQMusicSession {
  cookie: string
  user: LX.QQMusic.UserInfo | null
  generation: number
}

export const isQQMusicSessionCurrent = (session: QQMusicSession) =>
  session.generation === sessionGeneration && pendingSessionChanges === 0

// getQQMusicCookie 可能迁移旧版明文票据，读操作也必须和退出的删除排队。
const readSessionCookie = async(generation: number) => {
  if (generation !== sessionGeneration || pendingSessionChanges) return null
  return queueSessionWrite(async() => {
    if (generation !== sessionGeneration || pendingSessionChanges) return null
    return getQQMusicCookie()
  })
}

/**
 * 续期/校验票据。
 * - force=false：只在接近过期时续（getQQMusicSession 用，日常没有多余请求）
 * - force=true：服务端已经拒绝旧票据，无论本地时间都试一次（request 用）
 * 返回可用 Cookie；续不了返回 null（force=false 时返回原 Cookie，调用方可继续用）。
 */
const refreshQQMusicCookie = async(cookie: string, force: boolean): Promise<string | null> => {
  const generation = sessionGeneration
  if (pendingSessionChanges) return null
  if (!isQQMusicCookie(cookie)) return null
  if (!hasQQMusicRefreshCredential(cookie)) return force ? null : cookie

  // 别的请求可能已经续过票：以存储里的新票据为准。
  // 继续用调用方手里的旧 Cookie 再换一次，refresh_token 可能已经轮换，反而会失败。
  const stored = await readSessionCookie(generation).catch(() => null)
  if (!stored || generation !== sessionGeneration || pendingSessionChanges) return null
  if (stored !== cookie) {
    const storedUin = readUin(parseQQMusicCookie(stored))
    const cookieUin = readUin(parseQQMusicCookie(cookie))
    if (storedUin && cookieUin && storedUin !== cookieUin) return null
    if (!shouldRefreshQQMusicCookie(stored)) return stored
    cookie = stored
  }

  if (!force && !shouldRefreshQQMusicCookie(cookie)) return cookie
  if (!force && Date.now() < refreshRetryAt) return cookie
  if (!refreshPromise) {
    let tracked: Promise<string | null>
    tracked = requestQQMusicCredentialRefresh(cookie)
      .then(async refreshed => {
        if (!refreshed || !isQQMusicCookie(refreshed)) return null
        const cookies = parseQQMusicCookie(refreshed)
        cookies.uin = formatStoredUin(cookies.uin, readUin(cookies))
        const normalizedCookie = serializeQQMusicCookie(cookies)
        // 真正落盘时再校验一次代次：登录/退出可能发生在请求返回之后
        const saved = await queueSessionWrite(async() => {
          if (generation !== sessionGeneration || pendingSessionChanges) return false
          await saveQQMusicCookie(normalizedCookie)
          return generation === sessionGeneration && pendingSessionChanges === 0
        })
        if (!saved || generation !== sessionGeneration || pendingSessionChanges) return null
        refreshRetryAt = 0
        // 新票据生效，允许之后再因为过期而自动清理
        expiredHandled = false
        return normalizedCookie
      })
      .catch(error => {
        if (!force && generation === sessionGeneration && !pendingSessionChanges) refreshRetryAt = Date.now() + 60_000
        console.warn('[QQMusic] 登录续期失败:', error instanceof Error ? error.message : error)
        return null
      })
      .finally(() => { if (refreshPromise === tracked) refreshPromise = null })
    refreshPromise = tracked
  }
  return refreshPromise
}


/**
 * 登录态请求的 comm 块。uin 必须是账号 UIN，且必须带 authst(音乐票据)，
 * 否则服务端不认这个身份 —— 这是早先 "session expired" 的直接原因之一。
 *
 * 这里用的是手机 App 信封：ct/cv/chid/tmeAppID/tmeLoginType 是一组互相对应的
 * App 端标识，UA 也要配套（见 QQ_APP_USER_AGENT）。qq 和 uin 都带账号：
 * App 端习惯读 qq，而本仓既有的调用点读 uin，两个都给上最稳。
 * musicu.fcg 目前不校验 sign。
 */
const buildAuthComm = (cookies: Record<string, string>) => {
  const uin = readUin(cookies)
  const authst = readMusicKey(cookies)
  return {
    uin,
    qq: uin,
    format: 'json',
    ct: 11,
    cv: 14090008,
    v: 14090008,
    chid: '10003505',
    tmeAppID: 'qqmusic',
    tmeLoginType: readAppLoginType(cookies),
    ...(authst ? { authst } : {}),
  }
}

/**
 * 带登录态的 musicu.fcg 请求。extra 是要并进 body 的字段（req_0 / req_1 ...），
 * 默认用 App 信封；网页兼容取票必须同时切换 comm 和 UA。
 */
export const postAuthedMusicu = async(
  cookie: string,
  extra: Record<string, unknown>,
  headers: Record<string, string> = {},
  client: 'app' | 'web' = 'app',
  signal?: AbortSignal,
) => {
  const cookies = parseQQMusicCookie(cookie)
  if (!readUin(cookies) || !readMusicKey(cookies)) throw new Error(global.i18n.t('qq_cookie_invalid'))
  return request(QQ_MUSICU_URL, cookie, {
    method: 'post',
    body: { comm: client === 'web' ? buildCommonComm(cookies) : buildAuthComm(cookies), ...extra },
    headers: { 'User-Agent': client === 'web' ? QQ_WEB_USER_AGENT : QQ_APP_USER_AGENT, ...headers },
  }, true, signal)
}

const buildCommonComm = (cookies: Record<string, string>) => ({
  cv: 4747474,
  ct: 24,
  format: 'json',
  inCharset: 'utf-8',
  outCharset: 'utf-8',
  notice: 0,
  platform: 'yqq.json',
  needNewCode: 1,
  uin: readUin(cookies),
})

// 未登录时的 App 信封：和登录态同一套标识，只是不带账号与票据。
// 原来这里用的是 { cv: 1602, ct: 20 }，属于网页端那套，一并换掉。
const buildAnonymousComm = () => ({
  uin: '0',
  format: 'json',
  ct: 11,
  cv: 14090008,
  v: 14090008,
  chid: '10003505',
  tmeAppID: 'qqmusic',
  tmeLoginType: 0,
})

// 服务端用这两个码明确表示"未登录/票据失效"，区别于网络错误和结构变更
const isSessionExpiredBody = (body: any) => Number(body?.code) === 1000 || Number(body?.result) === 301

/**
 * musicu.fcg 会把各模块的返回平铺在 req_0/req_1/radio/playlist 这类键下，
 * 过期码就写在那一层，所以除顶层之外还要往下看一层。
 *
 * 以前只在"用户资料"和"每日推荐"两处手写了这个判断，其余接口拿到过期响应
 * 只会返回空列表或抛一句通用错误——表现出来就是"登录明明失效了但界面还是
 * 已登录、数据一直是空的"，得手动退出再重新登录才能恢复。
 *
 * 只认这两个码，不判"非 0 即失败"：外层码在登录态下的取值范围没有全部验证过，
 * 判非 0 会引入原本不存在的失败分支。
 */
const hasExpiredSession = (body: any) => {
  if (isSessionExpiredBody(body)) return true
  if (!body || typeof body !== 'object') return false
  return Object.values(body as Record<string, unknown>).some(value => isSessionExpiredBody(value))
}

/**
 * 票据失效。调用方按普通错误处理即可（界面会 toast 出这句话），
 * 会话清理和界面通知已经在 request() 里做掉了。
 */
export class QQMusicSessionExpiredError extends Error {
  constructor() {
    super(global.i18n.t('qq_session_expired'))
  }
}

// 一次过期会有多个请求同时在飞，清理和广播只做一次。
// 标志位在第一个 await 之前就置位，几个并发请求里只有一个能进来。
let expiredHandled = false

const handleExpiredSession = () => {
  if (expiredHandled) return
  expiredHandled = true
  // 清理放在后台做：调用方该抛的错照抛，界面会在清理完成后收到退出通知
  void clearQQMusicSession()
    // 连同账号维度的缓存一起清掉，否则退出后界面还挂着上一个号的数据
    .catch(error => { console.warn('[QQMusic] clear expired session failed:', error instanceof Error ? error.message : error) })
    .finally(() => { global.app_event.qqMusicAccountUpdated(null) })
}

const getPath = (source: any, path: string) => {
  let value = source
  for (const key of path.split('.')) {
    value = value?.[key]
    if (value == null) return undefined
  }
  return value
}

// 按已知字段路径取第一个非空数组。替代原先"递归查找第一个像歌曲的数组"的启发式 ——
// 后者在推荐流这类多卡片结构上会抓到无关数组。
const pickArray = (source: any, paths: string[]): any[] => {
  for (const path of paths) {
    const value = getPath(source, path)
    if (Array.isArray(value) && value.length) return value
  }
  return []
}

// 上游在不同接口里把歌曲包在 songInfo / track_info / Track 等不同包装层下，统一拆开
const unwrapSong = (raw: any) => {
  const source = raw?.Track ?? raw
  return source?.songInfo ?? source?.track_info ?? source?.songinfo ?? source?.song ?? source
}

const rawSongToOldInfo = (raw: any) => {
  const song = unwrapSong(raw)
  const singer = Array.isArray(song?.singer)
    ? song.singer.map((item: any) => item.name).filter(Boolean).join('、')
    : song?.singer?.name ?? song?.singer ?? ''
  const album = song?.album ?? {}
  const file = song?.file ?? {}
  const songmid = song?.songmid ?? song?.mid ?? song?.song_mid
  const albumId = album?.mid ?? song?.albumMid ?? song?.albummid ?? ''
  if (!songmid || (!song?.title && !song?.name)) return null
  const types: any[] = []
  const _types: Record<string, any> = {}
  const qualitySizes: Array<[string, string]> = [['128k', 'size_128mp3'], ['320k', 'size_320mp3'], ['flac', 'size_flac'], ['flac24bit', 'size_hires']]
  for (const [type, key] of qualitySizes) {
    if (Number(file?.[key] ?? 0) > 0) {
      types.push({ type, size: '' })
      _types[type] = { size: '' }
    }
  }
  if (!types.length) {
    types.push({ type: '128k', size: '' })
    _types['128k'] = { size: '' }
  }
  // 歌曲类型：1 = 普通歌曲，2 = 长音频，6 = 视频/直播。写歌单/写红心都要带上它，
  // 传 0（早先我们硬编码的值）不是合法类型，服务端会拒（80092）。
  const rawType = Number(song?.type ?? song?.songtype ?? song?.song_type)
  const songType = Number.isFinite(rawType) && rawType > 0 ? rawType : 1
  return {
    songmid: String(songmid),
    songType,
    songId: song?.id ?? song?.songid ?? songmid,
    name: song?.title ?? song?.name,
    singer,
    albumName: album?.name ?? song?.albumName ?? song?.albumname ?? '',
    albumId,
    albumMid: albumId,
    strMediaMid: file?.media_mid ?? song?.strMediaMid ?? song?.media_mid ?? songmid,
    interval: song?.interval ? `${Math.floor(song.interval / 60).toString().padStart(2, '0')}:${(song.interval % 60).toString().padStart(2, '0')}` : null,
    img: albumId ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumId}.jpg` : '',
    source: 'tx',
    types,
    _types,
  }
}

const mapSongs = (rawList: any[]): LX.Music.MusicInfoOnline[] =>
  rawList.map(rawSongToOldInfo).filter(Boolean).map(item => toNewMusicInfo(item)) as LX.Music.MusicInfoOnline[]

// 服务端会往「我的歌单」里塞一些虚拟歌单：QZone背景音乐、本地上传之类。
// QQ 客户端自己不显示它们，它们也不是用户建的，点开也没有内容。
// 判据是 id：真实歌单一定有可用的 disstid，只有 dirid 或 dissid=0 的都是虚拟歌单。
// 这类里唯一要保留的是「我喜欢」(dirid=201)，它靠 dirid 定位、走另一条取歌通道。
//
// 另外仍留一份名字前缀表作为兜底：虚拟歌单若哪天带上了一个像样的 disstid，
// 上面那条规则就认不出来了，名字至少能挡住已知的几个。
const HIDDEN_PLAYLIST_NAME_PREFIXES = ['QZone背景音乐', '本地上传']
const isHiddenPlaylistName = (name: string) =>
  HIDDEN_PLAYLIST_NAME_PREFIXES.some(prefix => name.startsWith(prefix))

// 服务端有时会返回标题为「我喜欢」但没有 dirid=201 的快捷条目。
// 那种条目走通用歌单详情取不到歌，按 MusicOne 的做法按名字过滤掉。
const LIKED_SHORTCUT_NAMES = new Set(['我喜欢', '我喜欢的音乐'])
const isLikedShortcutName = (name: string) => LIKED_SHORTCUT_NAMES.has(name.replace(/\s+/g, ''))

/** 新建/重命名时不能用的名字：会被列表归一化过滤掉，建出来就“消失”了 */
export const isReservedQQMusicPlaylistName = (name: string) =>
  isLikedShortcutName(name) || isHiddenPlaylistName(name)

const isRealPlaylistId = (id: unknown) => id != null && id !== '' && Number(id) !== 0

/**
 * 给已经归一化的歌单列表兜一次底：缓存里可能还留着旧版本存下来的虚拟歌单，
 * 而那一层已经看不出 disstid 了，只能按名字挡。取回来和读缓存的地方都用它。
 */
export const filterVisiblePlaylists = (list: LX.QQMusic.PlaylistInfo[]) =>
  // liked 是可选的，「我喜欢」永远保留；其余按名字挡
  list.filter(item => item.liked === true || !isHiddenPlaylistName(item.name))

const normalizePlaylist = (raw: any, subscribed: boolean): LX.QQMusic.PlaylistInfo | null => {
  // 虚拟歌单没有可用的 disstid，统一归一化成 dirid，详情接口据此切换取数方式
  const dirid = Number(raw?.dirid ?? raw?.dirId ?? 0)
  const liked = dirid === LIKED_PLAYLIST_DIRID
  // 与 QQ 客户端一致：dissid 可能会返回 0，此时继续使用 tid 等真实编号。
  const realId = [raw?.dissid, raw?.tid, raw?.disstid, raw?.diss_id, raw?.id]
    .find(value => isRealPlaylistId(value))
  // 不是「我喜欢」又没有真实 disstid，就是服务端塞进来的虚拟歌单
  if (!liked && !isRealPlaylistId(realId)) return null
  const id = liked ? LIKED_PLAYLIST_DIRID : realId ?? dirid
  const name = raw?.diss_name ?? raw?.dissname ?? raw?.title ?? raw?.name
  if (id == null || !name) return null
  const decodedName = decodeName(String(name))
  if (!liked && isHiddenPlaylistName(decodedName)) return null
  return {
    id: String(id),
    // 写接口（加歌/移歌）要的是目录编号，不是公开的 disstid，这里原样留着
    dirId: dirid > 0 ? dirid : undefined,
    name: decodedName,
    cover: raw?.diss_cover ?? raw?.logo ?? raw?.imgurl ?? raw?.picurl ?? raw?.cover?.medium_url ?? raw?.cover_url_medium,
    description: decodeName(String(raw?.desc ?? raw?.introduction ?? '')).replace(/<br>/g, '\n'),
    trackCount: Number(raw?.song_cnt ?? raw?.song_count ?? raw?.songnum ?? raw?.total_song_num ?? 0) || undefined,
    subscribed,
    liked,
  }
}

/**
 * 是否是「我喜欢」这类虚拟歌单。
 *
 * 同时看 id 和标记：`liked` 是后加的字段，早先版本缓存下来的歌单没有它，
 * 只看标记会漏判，用户点下去就会走不通的通用详情接口。而 id 从最初就被
 * 归一化成 dirid，缓存里也带着，所以以它为准更可靠。
 */
/** 只按 id 判断：本地列表那边只有 sourceListId，没有 liked 标记 */
export const isLikedPlaylistId = (id: string | number) => Number(id) === LIKED_PLAYLIST_DIRID

export const isLikedPlaylist = (info: Pick<LX.QQMusic.PlaylistInfo, 'id' | 'liked'>) =>
  !!info.liked || isLikedPlaylistId(info.id)

export const getQQMusicSession = async(): Promise<QQMusicSession> => {
  const generation = sessionGeneration
  const empty = { cookie: '', user: null, generation }
  if (pendingSessionChanges) return empty
  const user = await getQQMusicUser() ?? null
  const storedCookie = await readSessionCookie(generation) ?? ''
  // 读存储也会让出执行权；不能给旧 Cookie 配上新代次。
  if (generation !== sessionGeneration || pendingSessionChanges) return empty
  // 旧版本把 uin 规范化成了纯数字；这里迁移成网页接口认的 o + 10 位格式，
  // 让已登录的账号不用重新登录也能拿到资料/昵称
  const migratedCookie = storedCookie ? migrateStoredUin(storedCookie) : null
  const cookie = migratedCookie ?? storedCookie
  if (migratedCookie && !uinMigrationQueued) {
    uinMigrationQueued = true
    void queueSessionWrite(async() => {
      if (generation !== sessionGeneration || pendingSessionChanges) return
      await saveQQMusicCookie(migratedCookie)
    }).catch(() => {}).finally(() => { uinMigrationQueued = false })
  }
  // 临近过期就在后台续一次：这是取链/进页面的热路径，不能卡在一个最长 15s 的请求上。
  // 旧票据在窗口内仍然有效，真过期了 request() 还有一次强制续期兜底。
  if (cookie && hasQQMusicRefreshCredential(cookie) && shouldRefreshQQMusicCookie(cookie)) {
    void refreshQQMusicCookie(cookie, false).catch(() => {})
  }
  return {
    cookie,
    generation,
    // 头像在读取时再归一化一遍：地址归一化是后加的，早先存下来的 user 里可能还是
    // 协议相对地址，不改的话得重新登录才会好
    user: user ? { ...user, avatar: normalizeAvatarUrl(user.avatar) || user.avatar } : null,
  }
}

/** 更新当前会话的歌单缓存；读改写和退出清理串行，过期结果也不广播给界面。 */
export const updateQQMusicPlaylistsCache = async(
  session: QQMusicSession,
  update: (cached: LX.QQMusic.PlaylistInfo[]) => LX.QQMusic.PlaylistInfo[] | null,
): Promise<boolean> => {
  // 旧请求立即结束，不必等待正在进行的退出/换号清理。
  if (!session.cookie || !isQQMusicSessionCurrent(session)) return false
  return queueSessionWrite(async() => {
    if (!isQQMusicSessionCurrent(session)) return false
    const cached = await getQQMusicPlaylistsCache()
    if (!isQQMusicSessionCurrent(session)) return false
    const next = update(cached)
    if (next === null) return true
    await saveQQMusicPlaylistsCache(next)
    // 写盘期间发生退出时，队列会随后清理；这里不能再发旧账号的成功通知。
    if (!isQQMusicSessionCurrent(session)) return false
    global.app_event.qqMusicPlaylistsUpdated()
    return true
  })
}

export interface QQMusicUserSeed {
  nickname?: string
  avatar?: string
}

export const saveQQMusicSession = async(cookie: string, seed?: QQMusicUserSeed) => {
  const generation = sessionGeneration
  const cookies = parseQQMusicCookie(cookie)
  const uin = readUin(cookies)
  if (!uin || !readMusicKey(cookies)) throw new Error(global.i18n.t('qq_cookie_invalid'))
  // 落库前统一 uin 格式。网页接口认 o + 10 位补零（MusicOne 同款）；
  // 微信登录(login_type=2)时 Cookie 里通常没有 uin，用 wxuin 补上。
  cookies.uin = formatStoredUin(cookies.uin, uin)
  const normalizedCookie = serializeQQMusicCookie(cookies)
  const user = await getQQMusicUserInfo(normalizedCookie)
  // 资料请求也可能跨越退出/换号，晚到的登录结果不能恢复已退出的会话。
  if (generation !== sessionGeneration) throw new QQMusicSessionExpiredError()
  if (!user.uin) user.uin = uin
  // 手机号登录的网页资料接口有时拿不到昵称/头像，登录回包里带了就用它兜底。
  // 资料接口返回了真昵称/真头像时以资料为准（和 MusicOne 的优先级一致）。
  if (seed?.nickname && isQQMusicFallbackNickname(uin, user.nickname)) user.nickname = seed.nickname
  if (seed?.avatar && isQQMusicFallbackAvatar(user.avatar)) {
    user.avatar = normalizeAvatarUrl(seed.avatar) || user.avatar
  }
  return changeQQMusicSession(async() => {
    // 以票据的账号为准，资料可能滞后；没有票据时也不沿用残留的旧账号缓存。
    const prevCookie = await getQQMusicCookie() ?? ''
    if (getQQMusicUin(prevCookie) !== uin) await clearQQMusicDataCache()
    await saveQQMusicCookie(normalizedCookie)
    await saveQQMusicUser(user)
    // 新会话生效，允许之后再因为过期而自动清理
    expiredHandled = false
    return user
  })
}

const clearQQMusicDataCache = async() => {
  await removeQQMusicPlaylistsCache()
  await removeQQMusicDailyPlaylistCache()
  await removeQQMusicDailyRecommendCache()
  await removeQQMusicHeartRadarCache()
  await removeQQMusicRecommendPlaylistsCache()
  // 歌单歌曲缓存也要等清完再切会话，否则旧账号的在途写可能落在新账号
  await clearPlaylistSongsCache()
  // 「哪天刷过」的记账也清掉：换号后新号的缓存是空的，别让旧号那天的记录挡住自动刷新
  await removeQQMusicRefreshDay()
}

export const clearQQMusicSession = async() => changeQQMusicSession(async() => {
  await clearQQMusicDataCache()
  await removeQQMusicCookie()
  await saveQQMusicUser(null)
  try {
    await Promise.all(QQ_COOKIE_URLS.map(async url => {
      const cookies = await CookieManager.get(url, true)
      await Promise.all(Object.values(cookies).map(async cookie => CookieManager.set(url, {
        ...cookie,
        value: '',
        expires: '1970-01-01T00:00:00.000Z',
      }, true)))
    }))
    await CookieManager.flush()
  } catch {}
})

/**
 * 每日推荐（dirid=202）。和「我喜欢」一样是 dirid 定位的虚拟歌单，
 * 只有 CgiGetDiss 通道认它 —— 当 disstid 传是取不到的。
 */
export const getQQMusicDailyPlaylist = async(cookie: string) => {
  const songs = await fetchPlaylistSongsByDiss(cookie, '', DAILY_RECOMMEND_DIRID)
  if (!songs.length) throw new Error(global.i18n.t('qq_load_failed'))
  return songs
}

/**
 * 从「最近播放」的歌单列表里找红心雷达。
 *
 * MusicOne 的「我的 → 最近播放」读的是 `PlayRecentlyRead/GetPlayRecentlyInfo`
 * 的 type=4，`geDanList` 里每一项都是最近播放过的歌单。红心雷达在那边就是一张
 * 服务端给的普通歌单卡片，拿到真实歌单 id 后就能走通用 CgiGetDiss 取整份歌单。
 */
const findRecentHeartRadarPlaylist = async(cookie: string): Promise<{ id: string, dirid?: number } | null> => {
  const body = await postAuthedMusicu(cookie, {
    req_0: {
      module: 'music.musicasset.PlayRecentlyRead',
      method: 'GetPlayRecentlyInfo',
      param: { type: 4, updateTime: 0, requestCnt: 500 },
    },
  })
  // 响应层级和参考实现一致：req_0.data.data.geDanList；老一点的封装可能少一层 data
  const rawList = pickArray(body?.req_0?.data, ['data.geDanList', 'geDanList'])
  const candidates: Array<{ id: number, dirid: number, index: number, lastTime: number }> = []
  for (const raw of rawList) {
    // 繁体的「紅心雷達」也认；名字里带这个词的旧歌单/自建歌单靠下面的排序取最新那张
    const name = decodeName(String(raw?.name ?? ''))
      .replace(/\s+/g, '')
      .replace(/紅/g, '红')
      .replace(/達/g, '达')
    if (!name.includes('红心雷达')) continue
    const id = Number(raw?.id)
    const dirid = Number(raw?.dirid ?? raw?.dirId ?? 0)
    if (!(id > 0) && !(dirid > 0)) continue
    candidates.push({
      id,
      dirid,
      // 参考实现按 index 升序、lastTime 降序；同一天有多条时取最新那张
      index: Number(raw?.index ?? Number.MAX_SAFE_INTEGER),
      lastTime: Number(raw?.lastTime ?? raw?.last_time ?? 0),
    })
  }
  candidates.sort((a, b) => a.index - b.index || b.lastTime - a.lastTime)
  const best = candidates[0]
  if (!best) return null
  return best.dirid > 0
    ? { id: String(best.id || best.dirid), dirid: best.dirid }
    : { id: String(best.id) }
}

/**
 * 红心雷达：按「我喜欢」推的歌单，和每日推荐一样每天固定一批（50 首）。
 *
 * 不要用 GetRadarSong 自己拼数量：那是个无限流，每次请求给的歌都会变。
 * 这里直接读「最近播放」里的那张红心雷达歌单，把整份歌单取回来，
 * 歌单本身就是当天固定的那 50 首。
 */
export const getQQMusicHeartRadarSongs = async(cookie: string): Promise<LX.Music.MusicInfoOnline[]> => {
  const recent = await findRecentHeartRadarPlaylist(cookie)
  if (!recent) throw new Error(global.i18n.t('qq_load_failed'))
  const songs = await getQQMusicPlaylistSongs(cookie, recent.id, recent.dirid)
  if (!songs.length) throw new Error(global.i18n.t('qq_load_failed'))
  return songs
}

// 服务端对 GetRadioSimilarSongs 的 amount 上限就是 12
const SIMILAR_SONGS_AMOUNT = 12

/**
 * 相似歌曲。vecSong 是要找相似的种子曲（QQ 的数值 songId）。
 * 未登录或没有种子时返回空而不是抛错：首页少一块推荐不该让整个页面失败。
 */
export const getQQMusicSimilarSongs = async(cookie: string, songId: string | number): Promise<LX.QQMusic.SimilarRecommendation> => {
  const empty: LX.QQMusic.SimilarRecommendation = { title: '', songs: [] }
  const id = Number(songId)
  if (!id) return empty
  const cookies = parseQQMusicCookie(cookie)
  if (!readUin(cookies) || !readMusicKey(cookies)) return empty
  const body = await request(QQ_MUSICU_URL, cookie, {
    method: 'post',
    body: {
      comm: buildAuthComm(cookies),
      req_0: {
        module: 'music.recommend.AutoPlayServer',
        method: 'GetRadioSimilarSongs',
        param: { vecSong: [id], from: 0, amount: SIMILAR_SONGS_AMOUNT, ext: {} },
      },
    },
  })
  const data = body?.req_0?.data ?? {}
  const values: any[] = Array.isArray(data.vecSong) ? data.vecSong : Array.isArray(data.songList) ? data.songList : []
  return {
    title: String(data.recTitle ?? '').trim(),
    songs: mapSongs(values.map((item: any) => item?.track ?? item?.Track ?? item?.songInfo ?? item)),
  }
}

/**
 * 头像地址归一化。
 *
 * 资料接口给的头像经常是**协议相对地址**（`//thirdqq.qlogo.cn/...`），这种 URI 没有
 * scheme，RN 的 Image 会直接加载失败、界面上就是没有头像。补成 https。
 * 非 http(s) 的一律当无效，交给调用方退到 qlogo 兜底地址。
 */
export const normalizeAvatarUrl = (raw: unknown): string => {
  const url = typeof raw == 'string' ? raw.trim() : ''
  if (!url) return ''
  if (url.startsWith('//')) return `https:${url}`
  // http 也一并升到 https：QQ 的图片 CDN 都支持，省得受 Android 明文流量策略影响
  if (/^http:\/\//i.test(url)) return `https://${url.slice('http://'.length)}`
  return /^https:\/\//i.test(url) ? url : ''
}

/**
 * 资料/票据接口的 g_tk：由音乐票据按 hash33 算出来。
 * 早先这里硬编码 5381 —— 那是未登录匿名请求才碰巧能用的值，带票据的请求要用算出来的。
 * 逐位计算要和 Kotlin/Java 的 Int 溢出行为一致，所以每步都用 |0 收成 32 位。
 */
const hash33 = (value: string, seed: number): number => {
  let hash = seed
  for (let index = 0; index < value.length; index++) {
    hash = (hash + ((hash << 5) + value.charCodeAt(index))) | 0
  }
  return hash & 0x7fffffff
}

/**
 * 取一首歌在服务端眼中的「规范身份」：数值 songId 和歌曲类型。
 *
 * 写歌单必须要这两个值，而且**删除时必须和当初添加进去的完全一致** —— 对不上，
 * 服务端会把这次删除当成「删一个不存在的条目」，返回成功但什么都不做。
 * MusicOne 在写入前会先补一次详情（`enrichTrackMetadata`），就是为此。
 */
export const getQQMusicTrackIdentity = async(
  cookie: string,
  songMid: string,
  fallbackSongType: number,
  fallbackSongId: number,
): Promise<{ songId: number, songType: number } | null> => {
  const cookies = parseQQMusicCookie(cookie)
  if (!readUin(cookies) || !readMusicKey(cookies)) throw new Error(global.i18n.t('qq_cookie_invalid'))
  const body = await request(QQ_MUSICU_URL, cookie, {
    method: 'post',
    headers: { 'User-Agent': QQ_WEB_USER_AGENT },
    body: {
      comm: buildCommonComm(cookies),
      req_1: {
        module: 'music.pf_song_detail_svr',
        method: 'get_song_detail_yqq',
        param: { song_mid: songMid, song_type: fallbackSongType, song_id: fallbackSongId },
      },
    },
  })
  const info = body?.req_1?.data?.track_info
  if (!info) return null
  const songId = Number(info.id)
  const songType = Number(info.type)
  return {
    songId: Number.isFinite(songId) && songId > 0 ? songId : fallbackSongId,
    songType: Number.isFinite(songType) && songType >= 0 ? songType : fallbackSongType,
  }
}

export const getQQMusicUserInfo = async(cookie: string): Promise<LX.QQMusic.UserInfo> => {
  const cookies = parseQQMusicCookie(cookie)
  const uin = readUin(cookies)
  const musicKey = readMusicKey(cookies)
  if (!uin || !musicKey) throw new Error(global.i18n.t('qq_cookie_invalid'))
  // 用占位值 0 去拼 qlogo 是必然 404 的空请求，宁可不给地址让界面显示占位
  const fallback: LX.QQMusic.UserInfo = {
    uin,
    nickname: `QQ ${uin}`,
    avatar: uin && uin != '0' ? `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(uin)}&s=640` : '',
  }
  // 资料接口只用来取昵称和头像。票据失效由 request() 统一判定，这里必须放行，
  // 否则会被下面的 catch 吞掉、退化成 Cookie 派生的资料，登录时就变成"明明失败了却显示已登录"；
  // 网络异常等其它情况仍然退化为 Cookie 派生的资料，不阻断登录流程。
  const query = new URLSearchParams({
    g_tk: String(hash33(musicKey, 5381)),
    format: 'json',
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    notice: '0',
    cid: '205360838',
    needNewCode: '0',
    loginUin: uin,
    hostUin: '0',
    userid: uin,
    reqfrom: '1',
  }).toString()
  // 同一接口对 Referer/UA 比较敏感：先按本仓库一直用的个人页 Referer 请求，
  // 拿不到真昵称时再按 MusicOne 的写法（首页 Referer + 通用 Chrome UA）试一次。
  // 手机号登录的票据没有 p_uin 等网页别名，这一步是资料/昵称的主要兜底。
  const attempts: Array<{ referer: string, headers: Record<string, string> }> = [
    { referer: QQ_PROFILE_REFERER, headers: {} },
    {
      referer: QQ_REFERER,
      headers: { 'User-Agent': QQ_WEB_USER_AGENT, Accept: 'application/json, text/plain, */*' },
    },
  ]
  let profile: { nickname: string, avatar: string, uin: string } | null = null
  let profileAvatar = ''
  for (const attempt of attempts) {
    let body: any = null
    try {
      body = await request(
        `${QQ_PROFILE_URL}?${query}`,
        cookie,
        { headers: { Referer: attempt.referer, ...attempt.headers }, timeout: 5000 },
        // 登录流程：过期只让这次登录失败，不动已有会话
        false,
      )
    } catch (error) {
      if (error instanceof QQMusicSessionExpiredError) throw error
      console.warn('[QQMusic] profile request failed:', error instanceof Error ? error.message : error)
      // 网络层就失败了，换 Referer 再打一次只会再等一个超时；直接转 App 接口
      break
    }
    if (!body) break
    const data = body?.data ?? {}
    // 有些账号/接口变体不给 creator 这一层，资料直接平铺在 data 上
    const creator = data.creator ?? data.user ?? data.profile ?? data
    const avatar = creator.headpic || creator.avatar || creator.avatarUrl || creator.logo
    if (avatar && !profileAvatar) profileAvatar = String(avatar)
    const nickname = creator.nick || creator.nickname || creator.name || creator.hostname
    if (!nickname) continue
    profile = {
      nickname: String(nickname),
      avatar: String(avatar ?? ''),
      // 资料接口有的账号会给 uin: 0（占位），别拿它把 Cookie 里的真号覆盖掉
      uin: normalizeUin(creator.uin),
    }
    break
  }
  // 网页资料接口拿不到昵称时，再用 App 信封的 GetLoginUserInfo 试一次。
  // 手机号登录拿到的本来就是 App 票据，这条通常才是能认出账号的通道。
  if (!profile) {
    try {
      // 登录流程里 Cookie 还没落库：autoCleanExpired 必须关掉，
      // 否则资料接口回 1000 会走续期/登出，把刚登录的会话判成过期
      const body = await request(QQ_MUSICU_URL, cookie, {
        method: 'post',
        timeout: 5000,
        body: {
          comm: buildAuthComm(cookies),
          userInfo: {
            module: 'music.UserInfo.userInfoServer',
            method: 'GetLoginUserInfo',
            param: {},
          },
        },
      }, false)
      const block = body?.userInfo
      if (block && Number(block.code ?? 0) === 0) {
        const data = block.data ?? block
        const nickname = findProfileField(data, PROFILE_NICK_KEYS) || findProfileField(data, ['name'])
        if (nickname) {
          profile = {
            nickname,
            avatar: findProfileField(data, PROFILE_AVATAR_KEYS),
            uin: normalizeUin(findProfileField(data, ['uin', 'musicid', 'musicId'])),
          }
        }
      }
    } catch (error) {
      if (error instanceof QQMusicSessionExpiredError) throw error
      console.warn('[QQMusic] GetLoginUserInfo failed:', error instanceof Error ? error.message : error)
    }
  }
  if (!profile) {
    return {
      uin,
      nickname: cookies.nickname || cookies.nick || fallback.nickname,
      avatar: normalizeAvatarUrl(profileAvatar || cookies.avatar || cookies.avatarUrl || cookies.headpic) || fallback.avatar,
    }
  }
  // 头像除了 creator 上那几处，登录 Cookie 里有时也带着一份，兜住它；
  // 前一次尝试可能只回了头像没回昵称，别把它丢掉
  const avatar = profile.avatar || profileAvatar || cookies.avatar || cookies.avatarUrl || cookies.headpic
  return {
    uin: profile.uin && profile.uin != '0' ? profile.uin : uin,
    nickname: profile.nickname,
    avatar: normalizeAvatarUrl(avatar) || fallback.avatar,
  }
}

// 自建歌单有两个数组：disslist 是当前格式，list 是旧的，两处都要读
// （只读 disslist 会漏掉一部分账号，MusicOne 两个都读）
const readCreatedPlaylists = (body: any): any[] =>
  [...pickArray(body, ['data.disslist']), ...pickArray(body, ['data.list'])]

/**
 * 自建歌单列表。
 *
 * **参数只带 MusicOne 那五个**（hostuin / sin / size / format / charset）。
 * 早先我们多带了 `g_tk` / `loginUin` / `notice` / `platform=yqq.json` / `needNewCode`，
 * 其中 `platform=yqq.json` 会让服务端按**网页老格式**返回，那种响应里**没有 dirid** ——
 * 而写歌单（加歌/删歌）必须要 dirid。MusicOne 用这几个参数打同一个接口，是拿得到 dirid 的
 * （它的 `qqDirectoryId` 就是从 `item.dirid` 读的）。
 *
 * 参数取不到东西时退回老参数兜底：老的没有 dirid，但至少歌单列表不会空掉。
 */
export const getQQMusicPlaylists = async(
  cookie: string,
  fetchOptions: { requireAll?: boolean } = {},
): Promise<LX.QQMusic.PlaylistInfo[]> => {
  const cookies = parseQQMusicCookie(cookie)
  const uin = readUin(cookies)
  if (!uin) throw new Error(global.i18n.t('qq_cookie_invalid'))
  const createdUrl = `${QQ_CREATED_PLAYLIST_URL}?hostuin=${encodeURIComponent(uin)}&sin=0&size=${PLAYLIST_PAGE_SIZE}&format=json&inCharset=utf8&outCharset=utf-8`
  const legacyCreatedUrl = `${QQ_CREATED_PLAYLIST_URL}?hostUin=0&hostuin=${encodeURIComponent(uin)}&sin=0&size=${PLAYLIST_PAGE_SIZE}&g_tk=5381&loginUin=${encodeURIComponent(uin)}&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0`
  // 收藏列表按 MusicOne 的 profileAssetQuery 带全参数：只带 ct/cid/userid/reqtype 时，
  // 网页登录 Cookie 靠 skey/p_skey 还能认出来，手机号登录只有音乐票据，服务端会当成未登录。
  const collectedUrl = `${QQ_COLLECTED_PLAYLIST_URL}?format=json&inCharset=utf8&outCharset=utf-8&platform=yqq.json&needNewCode=0&loginUin=${encodeURIComponent(uin)}&hostUin=0&notice=0&g_tk=5381&ct=20&cid=205360956&userid=${encodeURIComponent(uin)}&reqtype=3&sin=0&ein=99`
  const options = { headers: { Referer: QQ_PROFILE_REFERER } }

  const createdTask = (async(): Promise<any[]> => {
    const fresh = await request(createdUrl, cookie, options).then(readCreatedPlaylists)
    if (fresh.length) return fresh
    return request(legacyCreatedUrl, cookie, options).then(readCreatedPlaylists)
  })()

  const [created, collected] = await Promise.allSettled([
    createdTask,
    request(collectedUrl, cookie, options).then(body => {
      const list = pickArray(body, ['data.cdlist'])
      // 收藏列表依赖登录态，失败时原来会静默变成空列表；留一条带服务端码的日志方便定位
      if (!list.length) console.warn('[QQMusic] 收藏歌单为空:', body?.code, body?.subcode, body?.msg ?? body?.message ?? '')
      return list
    }),
  ])
  // 写操作前的校验/写后刷新不能拿残缺列表覆盖缓存：任一接口失败就整体报错
  if (fetchOptions.requireAll) {
    if (created.status === 'rejected') throw created.reason
    if (collected.status === 'rejected') throw collected.reason
  }
  // 两个接口都失败说明会话确实不可用，明确报错而不是静默返回空列表
  if (created.status === 'rejected' && collected.status === 'rejected') throw created.reason
  if (collected.status === 'rejected') {
    console.warn('[QQMusic] 收藏歌单请求失败:', collected.reason instanceof Error ? collected.reason.message : collected.reason)
  }
  const createdList = created.status === 'fulfilled' ? created.value : []
  const collectedList = collected.status === 'fulfilled' ? collected.value : []
  const seen = new Set<string>()
  const list = [
    ...createdList.map((raw: any) => normalizePlaylist(raw, false)),
    ...collectedList.map((raw: any) => normalizePlaylist(raw, true)),
  ].filter((item): item is LX.QQMusic.PlaylistInfo => {
    if (!item?.id || !item.name) return false
    if (!item.liked && isLikedShortcutName(item.name)) return false
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
  // 「我喜欢」是 dirid=201 的虚拟歌单，正常由收藏列表带回来。手机号登录的响应
  // 可能不包含它，导致 Mine 页的「我喜欢」入口拿不到 liked 项、点了没反应。
  // 这里兜底补一个，详情页仍走 CgiGetDiss 的 201 通道，不依赖这个列表项。
  if (!list.some(item => item.liked)) {
    // 收藏列表没带 dirid=201 时补一个。曲目数由界面从「我喜欢」的常驻 id 集合补，
    // 这里不整份读 liked 歌曲缓存（数据量大，而且这里只是列表兜底）
    list.unshift({
      id: String(LIKED_PLAYLIST_DIRID),
      dirId: LIKED_PLAYLIST_DIRID,
      name: global.i18n.t('mine_liked'),
      description: '',
      subscribed: false,
      liked: true,
    })
  }
  return list
}

// 音乐流的 miscellany/v_user 有时是 JSON 字符串（MusicOne 也专门兜了这种情况）
const asFeedObject = (value: any): Record<string, any> | null => {
  if (value && typeof value == 'object' && !Array.isArray(value)) return value
  if (typeof value == 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed == 'object' && !Array.isArray(parsed) ? parsed : null
    } catch {}
  }
  return null
}
const asFeedArray = (value: any): any[] => {
  if (Array.isArray(value)) return value
  if (typeof value == 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : []
    } catch {}
  }
  return []
}
const cleanFeedText = (value: unknown) => {
  const text = decodeName(String(value ?? ''))
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[>"“”']+$/, '')
    .trim()
  // 播放量/收藏数这类统计文案不能当推荐语或创建者
  if (/^(?:评论|播放|收听|收藏|喜欢)?\s*\d+(?:\.\d+)?\s*(?:万|亿|w|k|m)?\+?\s*(?:评论|播放|收听|收藏|喜欢)?$/i.test(text)) return ''
  if (text == '为你推荐') return ''
  return text
}

/**
 * 从音乐流的卡位里读一张歌单卡。
 *
 * 对齐 MusicOne 的 QqMusicFeedProtocol：歌单卡的判定是
 * style=302 / type=500+jumptype=10014 / type=0 的若干 folder style + jumptype=10014。
 * 每日30首也是 type=500/jumptype=10014，首页另有入口，这里要排掉。
 */
const readFeedPlaylistCard = (card: any): LX.QQMusic.PlaylistInfo | null => {
  if (!card || typeof card != 'object') return null
  const style = Number(card.style ?? -1)
  const serverType = Number(card.type ?? 0)
  const serverSubtype = Number(card.subtype ?? 0)
  const jumpType = Number(card.jumptype ?? 0)
  const title = decodeName(String(card.title ?? '')).trim()
  if (style === FEED_DAILY_30_STYLE ||
    (serverType === FEED_PLAYLIST_SERVER_TYPE && serverSubtype === FEED_DAILY_30_SUBTYPE) ||
    title.replace(/\s+/g, '') === '每日30首') return null
  const isPlaylist = style === 302 ||
    (serverType === FEED_PLAYLIST_SERVER_TYPE && serverSubtype !== FEED_AI_FOLDER_SUBTYPE && jumpType === FEED_PLAYLIST_JUMP_TYPE) ||
    (serverType === 0 && FEED_FOLDER_STYLES.has(style) && jumpType === FEED_PLAYLIST_JUMP_TYPE)
  if (!isPlaylist) return null
  const id = Number(card.id)
  if (!(id > 0)) return null
  const misc = asFeedObject(card.miscellany) ?? {}
  // 和 MusicOne 一样：卡面副文案优先用官方推荐语，其次才是 subtitle/创建者
  const recommendation = [misc.p_Template_setTitle, misc.recommendationTitle, misc.rcmd_reason, misc.rec_reason]
    .map(cleanFeedText)
    .find(Boolean) ?? ''
  const subtitle = cleanFeedText(card.subtitle)
  // MusicOne 的卡面副文案顺序：官方推荐语 → 创建者（v_user）→ subtitle → 兜底
  const creator = asFeedArray(card.v_user)
    .map(user => cleanFeedText(user?.nick ?? user?.nickname ?? user?.name))
    .find(Boolean) ?? ''
  return {
    id: String(id),
    name: title || global.i18n.t('qq_recommend_playlists'),
    cover: normalizeAvatarUrl(card.cover) || undefined,
    author: recommendation || creator || subtitle || 'QQ 音乐推荐',
    description: recommendation || subtitle || undefined,
  }
}

// 音乐流是混排的，首屏不一定有歌单卡；最多探 3 页去抽
const FEED_RECOMMEND_PROBE_PAGES = 3

/** 从 MusicOne 同款首页音乐流里抽歌单卡 */
const readFeedRecommendedPlaylists = async(cookie: string): Promise<LX.QQMusic.PlaylistInfo[]> => {
  const cookies = parseQQMusicCookie(cookie)
  const authed = !!readUin(cookies) && !!readMusicKey(cookies)
  let clientTimeZone = 'Asia/Shanghai'
  try { clientTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || clientTimeZone } catch {}
  const list: LX.QQMusic.PlaylistInfo[] = []
  const seen = new Set<string>()
  let shelfCount = 0
  let shelfIds: string[] = []
  let uniqueKeys: string[] = []
  for (let page = 1; page <= FEED_RECOMMEND_PROBE_PAGES && list.length < RECOMMEND_PLAYLIST_LIMIT; page++) {
    const body = await request(QQ_MUSICU_URL, authed ? cookie : '', {
      method: 'post',
      body: {
        comm: authed ? buildAuthComm(cookies) : buildAnonymousComm(),
        req_0: {
          module: 'music.recommend.RecommendFeed',
          method: 'get_recommend_feed',
          param: {
            direction: page === 1 ? 0 : 1,
            page,
            s_num: shelfCount,
            client_time: Math.floor(Date.now() / 1000),
            v_cache: shelfIds,
            // 首屏/刷新让推荐服务重新算个性化内容；后续页要带上一页的排重键
            ...(page > 1 ? { v_uniq: uniqueKeys } : {}),
            ext: {
              bluetooth: '0',
              has_login: '1',
              no_need_sound_quality: '1',
              ifRadarBlock: '0',
              nopack_people: '0',
              auto_folding_time: '0',
              first_req_time: page === 1 ? '1' : '0',
              is_20_style: '1',
              client_time_zone: clientTimeZone,
            },
          },
        },
      },
    })
    const block = body?.req_0
    if (!block) {
      throw new Error(String(body?.message ?? body?.msg ?? global.i18n.t('qq_load_failed')))
    }
    const data = block.data ?? {}
    if (Number(body?.code ?? 0) !== 0 || Number(block.code ?? 0) !== 0 || Number(data.retcode ?? 0) !== 0) {
      throw new Error(String(block.message ?? block.msg ?? data.msg ?? global.i18n.t('qq_load_failed')))
    }
    // 参考实现同时认 v_shelf / Shelfs 两个键
    const shelves: any[] = Array.isArray(data.v_shelf)
      ? data.v_shelf
      : Array.isArray(data.Shelfs) ? data.Shelfs : []
    if (!shelves.length) break
    const nextShelfIds: string[] = []
    const nextUniqueKeys: string[] = []
    for (const shelf of shelves) {
      const shelfId = String(shelf?.id ?? '')
      if (shelfId) nextShelfIds.push(shelfId)
      const niches: any[] = Array.isArray(shelf?.v_niche) ? shelf.v_niche : []
      for (const niche of niches) {
        const cards: any[] = Array.isArray(niche?.v_card) ? niche.v_card : []
        for (const card of cards) {
          // 官方只为 315 号货架回传排重键
          if (shelfId === '315' && card?.type != null) {
            nextUniqueKeys.push(`${Number(card.type)}_${Number(card.subtype ?? 0)}_${String(card.id ?? '')}`)
          }
          const item = readFeedPlaylistCard(card)
          if (!item || seen.has(item.id)) continue
          seen.add(item.id)
          list.push(item)
          if (list.length >= RECOMMEND_PLAYLIST_LIMIT) break
        }
        if (list.length >= RECOMMEND_PLAYLIST_LIMIT) break
      }
      if (list.length >= RECOMMEND_PLAYLIST_LIMIT) break
    }
    shelfCount += shelves.length
    shelfIds = [...new Set([...shelfIds, ...nextShelfIds])]
    uniqueKeys = [...new Set([...uniqueKeys, ...nextUniqueKeys])].slice(-100)
  }
  return list
}

// 旧推荐栏的映射（仅作音乐流抽不到歌单卡时的兜底）
const normalizeLegacyRecommendedPlaylist = (raw: any): LX.QQMusic.PlaylistInfo | null => {
  const basic = raw?.basic
  if (!basic) return null
  const id = basic.tid ?? basic.dirid
  const name = basic.title
  if (id == null || !name) return null
  const cover = basic.cover ?? {}
  return {
    id: String(id),
    name: decodeName(String(name)),
    cover: cover.medium_url ?? cover.small_url ?? cover.default_url ?? cover.big_url,
    description: decodeName(String(basic.desc ?? '')).replace(/<br>/g, '\n'),
    trackCount: Number(basic.song_cnt ?? 0) || undefined,
    author: decodeName(String(basic.creator?.nick ?? '')) || undefined,
  }
}

/** 旧接口 PlaylistSquare/GetRecommendFeed（MusicOne 已停用，只拿来兜底） */
const getLegacyRecommendedPlaylists = async(cookie: string): Promise<LX.QQMusic.PlaylistInfo[]> => {
  const cookies = parseQQMusicCookie(cookie)
  const authed = !!readUin(cookies) && !!readMusicKey(cookies)
  const body = await request(QQ_MUSICU_URL, authed ? cookie : '', {
    method: 'post',
    body: {
      comm: authed ? buildAuthComm(cookies) : buildAnonymousComm(),
      req_0: {
        module: 'music.playlist.PlaylistSquare',
        method: 'GetRecommendFeed',
        param: { From: 0, Size: RECOMMEND_PLAYLIST_LIMIT },
      },
    },
  })
  const block = body?.req_0
  if (!block) throw new Error(String(body?.message ?? body?.msg ?? global.i18n.t('qq_load_failed')))
  if (Number(block.code ?? 0) !== 0) {
    throw new Error(String(block.message ?? block.msg ?? block.data?.msg ?? global.i18n.t('qq_load_failed')))
  }
  const data = block.data ?? {}
  const feed = data.FeedRsp ?? data
  const rawList: any[] = Array.isArray(feed.List) ? feed.List : []
  const list = rawList
    .map((item: any) => normalizeLegacyRecommendedPlaylist(item?.Playlist))
    .filter((item: LX.QQMusic.PlaylistInfo | null): item is LX.QQMusic.PlaylistInfo => !!item)
  if (!list.length) throw new Error(global.i18n.t('qq_load_failed'))
  return list
}

/**
 * 推荐歌单：优先对齐 MusicOne 的首页音乐流（`RecommendFeed/get_recommend_feed`，
 * 从 v_shelf → v_niche → v_card 抽歌单卡）。音乐流是混排的、首屏不一定有歌单卡，
 * 所以最多探 3 页；还是抽不到（或请求失败）就退回旧的 PlaylistSquare 推荐栏兜底，
 * 保证这个区块不会因为流里没歌单卡而整体报错。
 */
export const getQQMusicRecommendedPlaylists = async(cookie: string): Promise<LX.QQMusic.PlaylistInfo[]> => {
  try {
    const list = await readFeedRecommendedPlaylists(cookie)
    if (list.length) return list
    console.warn('[QQMusic] 音乐流没有返回歌单卡，改用旧推荐接口')
  } catch (error) {
    // 票据失效就交给上层走重新登录，不要再拿旧 Cookie 打第二个接口
    if (error instanceof QQMusicSessionExpiredError) throw error
    console.warn('[QQMusic] 音乐流推荐歌单失败，改用旧推荐接口:', error instanceof Error ? error.message : error)
  }
  return getLegacyRecommendedPlaylists(cookie)
}

/**
 * "猜你喜欢"（电台连续推荐）。
 *
 * 请求**整体对齐参考实现那条**（这个接口在那边是线上验证过的）：槽位 songlist、
 * 精简 comm（ct=19 / cv=0 + authst）、浏览器 UA。和这边别处用的 App 信封不是一套 ——
 * 这里刻意只对这一个调用用参考实现的那套，别顺手把全局 helper 改了。
 * 解析同时认 songlist / radio 两个槽位，将来服务端或封装换了也不至于空列表。
 */
export const getQQMusicDailyRecommendations = async(cookie: string): Promise<LX.Music.MusicInfoOnline[]> => {
  const cookies = parseQQMusicCookie(cookie)
  const uin = readUin(cookies)
  const authst = readMusicKey(cookies)
  // 这条电台要带票据才是个性化的（参考实现没票据直接拦在本地）
  if (!uin || !authst) throw new Error(global.i18n.t('qq_cookie_invalid'))
  // 参考实现用的最简 comm：ct=19 / cv=0。别用 buildAuthComm 那套 App 信封
  const comm = { uin, format: 'json', ct: 19, cv: 0, authst }
  const seen = new Set<string>()
  const songs: LX.Music.MusicInfoOnline[] = []
  let staleRounds = 0
  // 一次要 num=RECOMMEND_PAGE_SIZE 首，够一轮就攒满一份。服务端要是只给一部分，
  // 就继续调用、按 songmid 去重补够 —— 循环只在"没给满"时才有意义。
  // 电台每次调用可能给一批新的；若连续两轮没有新歌，说明上游改成了固定列表，
  // 就此打住，免得白跑满次数。
  for (let i = 0; i < RECOMMEND_MAX_TRIES && songs.length < RECOMMEND_TARGET; i++) {
    let body: any
    try {
      body = await request(QQ_MUSICU_URL, cookie, {
        method: 'post',
        body: {
          comm,
          songlist: {
            module: 'music.radioProxy.MbTrackRadioSvr',
            method: 'get_radio_track',
            param: {
              id: GUESS_RECOMMEND_ID,
              num: RECOMMEND_PAGE_SIZE,
              from: 0,
              scene: 0,
              song_ids: [],
            },
          },
        },
        // 参考实现这条用的是浏览器 UA（和它自己的 App 通道分开）
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      })
    } catch (error) {
      // 票据失效由 request() 抛出并已就地清理会话；已经取到歌就当作本批到此为止
      if (!songs.length) throw error
      break
    }
    const data = body?.songlist?.data ?? body?.radio?.data
    const rawList = pickArray(data, ['tracks', 'track', 'track_list', 'songList', 'vec_song'])
    if (!rawList.length) break
    const before = songs.length
    for (const raw of rawList) {
      // songlist 槽位的条目外面包了一层 { track: {...} }（参考实现也是这么拆的）；
      // 老的 radio 槽位直接就是歌曲对象。两种都认
      const info = rawSongToOldInfo(raw?.track ?? raw)
      if (!info || seen.has(info.songmid)) continue
      seen.add(info.songmid)
      songs.push(toNewMusicInfo(info) as LX.Music.MusicInfoOnline)
      if (songs.length >= RECOMMEND_TARGET) break
    }
    if (songs.length === before) {
      if (++staleRounds >= 2) break
    } else {
      staleRounds = 0
    }
  }
  if (!songs.length) throw new Error(global.i18n.t('qq_load_failed'))
  return songs
}

// 现代接口，分页取全量。也是唯一能取到"我喜欢"(dirid=201)的方式
// dirid 是「虚拟歌单」的编号（201=我喜欢，202=每日推荐）。给了 dirid 就不看 disstid。
const fetchPlaylistSongsByDiss = async(cookie: string, playlistId: string, dirid = 0) => {
  const cookies = parseQQMusicCookie(cookie)
  // 未登录时别走这条需要鉴权的通道：它必然失败，白白多一次请求。
  // 直接返回空，让上层落到公开的旧接口（公开歌单不需要登录也能取）。
  if (!readUin(cookies) || !readMusicKey(cookies)) return []
  const comm = buildAuthComm(cookies)
  const songs: LX.Music.MusicInfoOnline[] = []
  const seen = new Set<string>()
  for (let page = 0; page < DISS_MAX_PAGES; page++) {
    const body = await request(QQ_MUSICU_URL, cookie, {
      method: 'post',
      body: {
        comm,
        playlist: {
          module: 'music.srfDissInfo.DissInfo',
          method: 'CgiGetDiss',
          param: {
            disstid: dirid ? 0 : Number(playlistId) || 0,
            dirid,
            tag: true,
            song_begin: page * DISS_PAGE_SIZE,
            song_num: DISS_PAGE_SIZE,
            userinfo: true,
            orderlist: true,
            onlysonglist: false,
          },
        },
      },
    })
    const block = body?.playlist
    if (Number(block?.code ?? 0) !== 0) {
      // 首页就失败说明这个歌单取不到，交给上层换接口；后续页失败则保留已取到的部分
      if (!songs.length) throw new Error(String(block?.message ?? block?.msg ?? 'QQ playlist detail unavailable'))
      break
    }
    const data = block?.data
    const rawList = pickArray(data, ['songlist'])
    if (!rawList.length) break
    for (const raw of rawList) {
      const info = rawSongToOldInfo(raw)
      if (!info || seen.has(info.songmid)) continue
      seen.add(info.songmid)
      songs.push(toNewMusicInfo(info) as LX.Music.MusicInfoOnline)
    }
    const total = Number(data?.total_song_num ?? 0)
    if (!total || songs.length >= total || rawList.length < DISS_PAGE_SIZE) break
  }
  return songs
}

export const getQQMusicPlaylistSongs = async(cookie: string, playlistId: string, directoryId?: number) => {
  // 现代接口优先，旧接口兜底，最后退回公开的 SDK 接口
  try {
    const dirid = directoryId ?? (Number(playlistId) === LIKED_PLAYLIST_DIRID ? LIKED_PLAYLIST_DIRID : 0)
    const songs = await fetchPlaylistSongsByDiss(cookie, playlistId, dirid)
    if (songs.length) return songs
  } catch (error) {
    console.warn('[QQMusic] CgiGetDiss failed:', error instanceof Error ? error.message : error)
  }
  // 歌单详情本身是公开的，但仍带上账号 Cookie：QQ 对私有歌单需要它
  try {
    const uin = getQQMusicUin(cookie)
    const url = `${QQ_PLAYLIST_DETAIL_URL}?type=1&json=1&utf8=1&onlysong=0&new_format=1&disstid=${encodeURIComponent(playlistId)}&loginUin=${encodeURIComponent(uin)}&hostUin=${encodeURIComponent(uin)}&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0`
    const body = await request(url, cookie)
    const rawSongs: any[] = Array.isArray(body?.cdlist?.[0]?.songlist) ? body.cdlist[0].songlist : []
    if (rawSongs.length) return mapSongs(rawSongs)
  } catch (error) {
    console.warn('[QQMusic] playlist detail fallback failed:', error instanceof Error ? error.message : error)
  }
  return getQQMusicPlaylistSongsFallback(playlistId)
}

export const getQQMusicPlaylistSongsFallback = async(playlistId: string) => {
  const result = await (musicSdk.tx.songList.getListDetail(playlistId) as Promise<{ list: any[] }>)
  return result.list.map(item => toNewMusicInfo(item)) as LX.Music.MusicInfoOnline[]
}
