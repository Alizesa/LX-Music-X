import { httpFetch } from '@/utils/request'
import { getQQMusicCookie, getQQMusicUser, saveQQMusicCookie, saveQQMusicUser, removeQQMusicCookie } from '@/utils/data'
import { toNewMusicInfo } from '@/utils'
import musicSdk from '@/utils/musicSdk'
import CookieManager from '@react-native-cookies/cookies'

const QQ_MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
const QQ_PROFILE_URL = 'https://c.y.qq.com/rsc/fcgi-bin/fcg_get_profile_homepage.fcg'
const QQ_CREATED_PLAYLIST_URL = 'https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss'
const QQ_COLLECTED_PLAYLIST_URL = 'https://c.y.qq.com/fav/fcgi-bin/fcg_get_profile_order_asset.fcg'
const QQ_PLAYLIST_DETAIL_URL = 'https://c.y.qq.com/qzone/fcgi-bin/fcg_ucc_getcdinfo_byids_cp.fcg'
const QQ_REFERER = 'https://y.qq.com/'
// 个人主页相关接口对 Referer 敏感，必须是个人页而不是首页
const QQ_PROFILE_REFERER = 'https://y.qq.com/portal/profile.html'
const QQ_COOKIE_URLS = ['https://y.qq.com/', 'https://qq.com/', 'https://c.y.qq.com/', 'https://u.y.qq.com/']

// 与 WebView 登录时使用的 UA 保持一致：Cookie 在哪个 UA 下签发，就用哪个 UA 请求，
// 避免因指纹不一致被风控。项目默认的 Chrome/69 也过于陈旧。
export const QQ_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const RECOMMEND_TARGET = 20
const RECOMMEND_MAX_TRIES = 4
const PLAYLIST_PAGE_SIZE = 200

export const parseQQMusicCookie = (cookie: string): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const part of String(cookie ?? '').split(';')) {
    const raw = part.trim()
    if (!raw) continue
    const index = raw.indexOf('=')
    if (index <= 0) continue
    const key = raw.slice(0, index).trim()
    if (key) result[key] = raw.slice(index + 1).trim()
  }
  return result
}

const serializeQQMusicCookie = (cookies: Record<string, string>) => Object.keys(cookies)
  .filter(key => cookies[key] != null && cookies[key] !== '')
  .map(key => `${key}=${cookies[key]}`)
  .join('; ')

const normalizeUin = (raw: unknown) => {
  const digits = String(raw ?? '').replace(/\D/g, '')
  return digits.replace(/^0+/, '') || digits
}

// 微信登录(login_type=2)时账号标识在 wxuin 上
const readUin = (cookies: Record<string, string>) => normalizeUin(
  Number(cookies.login_type) === 2
    ? cookies.wxuin || cookies.uin || cookies.p_uin
    : cookies.uin || cookies.qqmusic_uin || cookies.wxuin || cookies.p_uin,
)

// 只有 qm_keyst / qqmusic_key / music_key 是 QQ 音乐自己的登录票据。
// skey / p_skey 属于 QQ 互联(.qq.com)，对音乐接口无效 —— 早先把它们当兜底，
// 会让"其实没登录成功"的 Cookie 通过本地校验，然后在服务端被拒。
const readMusicKey = (cookies: Record<string, string>) => cookies.qm_keyst || cookies.qqmusic_key || cookies.music_key || ''

export const getQQMusicUin = (cookie: string) => readUin(parseQQMusicCookie(cookie))

export const getQQMusicAuthKey = (cookie: string) => readMusicKey(parseQQMusicCookie(cookie))

export const isQQMusicCookie = (cookie: string) => {
  const cookies = parseQQMusicCookie(cookie)
  return !!readUin(cookies) && !!readMusicKey(cookies)
}

const request = async(url: string, cookie: string, options: Record<string, any> = {}) => {
  const result = await httpFetch(url, {
    ...options,
    headers: {
      Referer: QQ_REFERER,
      Origin: 'https://y.qq.com',
      'User-Agent': QQ_USER_AGENT,
      Cookie: cookie,
      ...(options.headers ?? {}),
    },
  }).promise
  if (result.statusCode < 200 || result.statusCode >= 300) throw new Error(`QQ Music HTTP ${result.statusCode}`)
  return result.body as any
}

/**
 * 登录态请求的 comm 块。uin 必须是账号 UIN，且必须带 authst(音乐票据)，
 * 否则服务端不认这个身份 —— 这是早先 "session expired" 的直接原因之一。
 * ct=19 表示已登录通道，cv=0 是 Web 端使用的版本号；musicu.fcg 目前不校验 sign。
 */
const buildAuthComm = (cookies: Record<string, string>) => {
  const uin = readUin(cookies)
  const authst = readMusicKey(cookies)
  return {
    uin,
    format: 'json',
    ct: 19,
    cv: 0,
    ...(authst ? { authst } : {}),
  }
}

// 服务端用这两个码明确表示"未登录/票据失效"，区别于网络错误和结构变更
const isSessionExpired = (body: any) => Number(body?.code) === 1000 || Number(body?.result) === 301

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
  return {
    songmid: String(songmid),
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

const normalizePlaylist = (raw: any, subscribed: boolean): LX.QQMusic.PlaylistInfo | null => {
  const id = raw?.dissid ?? raw?.tid ?? raw?.dirid ?? raw?.disstid ?? raw?.diss_id ?? raw?.id
  const name = raw?.diss_name ?? raw?.dissname ?? raw?.title ?? raw?.name
  if (id == null || !name) return null
  return {
    id: String(id),
    name: String(name),
    cover: raw?.diss_cover ?? raw?.logo ?? raw?.imgurl ?? raw?.picurl ?? raw?.cover?.medium_url ?? raw?.cover_url_medium,
    description: raw?.desc ?? raw?.introduction ?? '',
    trackCount: Number(raw?.song_cnt ?? raw?.song_count ?? raw?.songnum ?? raw?.total_song_num ?? 0) || undefined,
    subscribed,
  }
}

export const getQQMusicSession = async() => ({
  cookie: await getQQMusicCookie() ?? '',
  user: await getQQMusicUser() ?? null,
})

export const saveQQMusicSession = async(cookie: string) => {
  const cookies = parseQQMusicCookie(cookie)
  const uin = readUin(cookies)
  if (!uin || !readMusicKey(cookies)) throw new Error(global.i18n.t('qq_cookie_invalid'))
  // 落库前把 uin 归一化成纯数字，后续请求和展示都依赖它。
  // 微信登录(login_type=2)时 Cookie 里通常没有 uin，用 wxuin 补上；
  // 已有 uin 时不能覆盖 —— 它和 wxuin 并不总是同一个值。
  cookies.uin = normalizeUin(cookies.uin) || uin
  const normalizedCookie = serializeQQMusicCookie(cookies)
  const user = await getQQMusicUserInfo(normalizedCookie)
  if (!user.uin) user.uin = uin
  await saveQQMusicCookie(normalizedCookie)
  await saveQQMusicUser(user)
  return user
}

export const clearQQMusicSession = async() => {
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
}

export const getQQMusicUserInfo = async(cookie: string): Promise<LX.QQMusic.UserInfo> => {
  const cookies = parseQQMusicCookie(cookie)
  const uin = readUin(cookies)
  if (!uin || !readMusicKey(cookies)) throw new Error(global.i18n.t('qq_cookie_invalid'))
  const fallback: LX.QQMusic.UserInfo = {
    uin,
    nickname: `QQ ${uin}`,
    avatar: `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(uin)}&s=100`,
  }
  // 资料接口只用来取昵称和头像。只有服务端明确回"未登录"才判定会话失效；
  // 网络异常等其它情况退化为 Cookie 派生的资料，不阻断登录流程。
  let body: any = null
  try {
    body = await request(
      `${QQ_PROFILE_URL}?cid=205360838&userid=${encodeURIComponent(uin)}&reqfrom=1&g_tk=5381&loginUin=${encodeURIComponent(uin)}&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0`,
      cookie,
      { headers: { Referer: QQ_PROFILE_REFERER } },
    )
  } catch (error) {
    console.warn('[QQMusic] profile request failed:', error instanceof Error ? error.message : error)
  }
  if (!body) return fallback
  if (isSessionExpired(body)) throw new Error(global.i18n.t('qq_session_expired'))
  const creator = body?.data?.creator ?? body?.data?.user ?? body?.data?.profile ?? {}
  return {
    uin: normalizeUin(creator.uin ?? uin) || uin,
    nickname: creator.nick || creator.nickname || creator.name || creator.hostname || fallback.nickname,
    avatar: creator.headpic || creator.avatar || creator.avatarUrl || creator.logo || fallback.avatar,
  }
}

export const getQQMusicPlaylists = async(cookie: string): Promise<LX.QQMusic.PlaylistInfo[]> => {
  const cookies = parseQQMusicCookie(cookie)
  const uin = readUin(cookies)
  if (!uin) throw new Error(global.i18n.t('qq_cookie_invalid'))
  const createdUrl = `${QQ_CREATED_PLAYLIST_URL}?hostUin=0&hostuin=${encodeURIComponent(uin)}&sin=0&size=${PLAYLIST_PAGE_SIZE}&g_tk=5381&loginUin=${encodeURIComponent(uin)}&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0`
  const collectedUrl = `${QQ_COLLECTED_PLAYLIST_URL}?ct=20&cid=205360956&userid=${encodeURIComponent(uin)}&reqtype=3&sin=0&ein=80`
  const options = { headers: { Referer: QQ_PROFILE_REFERER } }
  const [created, collected] = await Promise.allSettled([
    request(createdUrl, cookie, options),
    request(collectedUrl, cookie, options),
  ])
  // 两个接口都失败说明会话确实不可用，明确报错而不是静默返回空列表
  if (created.status === 'rejected' && collected.status === 'rejected') throw created.reason
  const createdList = created.status === 'fulfilled' ? pickArray(created.value, ['data.disslist']) : []
  const collectedList = collected.status === 'fulfilled' ? pickArray(collected.value, ['data.cdlist']) : []
  const seen = new Set<string>()
  return [
    ...createdList.map((raw: any) => normalizePlaylist(raw, false)),
    ...collectedList.map((raw: any) => normalizePlaylist(raw, true)),
  ].filter((item): item is LX.QQMusic.PlaylistInfo => {
    if (!item?.id || !item.name || seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

export const getQQMusicDailyRecommendations = async(cookie: string): Promise<LX.Music.MusicInfoOnline[]> => {
  const cookies = parseQQMusicCookie(cookie)
  const uin = readUin(cookies)
  if (!uin) throw new Error(global.i18n.t('qq_cookie_invalid'))
  const comm = buildAuthComm(cookies)
  const seen = new Set<string>()
  const songs: LX.Music.MusicInfoOnline[] = []
  let expired = false
  // 上游单次只回约 5 首，需要多次调用并按 songmid 去重凑够一份推荐列表
  for (let i = 0; i < RECOMMEND_MAX_TRIES && songs.length < RECOMMEND_TARGET; i++) {
    let body: any
    try {
      body = await request(QQ_MUSICU_URL, cookie, {
        method: 'post',
        body: {
          comm,
          radio: {
            module: 'music.radioProxy.MbTrackRadioSvr',
            method: 'get_radio_track',
            param: {},
          },
        },
      })
    } catch (error) {
      if (!songs.length) throw error
      break
    }
    if (isSessionExpired(body) || isSessionExpired(body?.radio)) {
      expired = true
      break
    }
    const rawList = pickArray(body?.radio?.data, ['track', 'songList', 'vec_song', 'tracks'])
    if (!rawList.length) break
    for (const raw of rawList) {
      const info = rawSongToOldInfo(raw)
      if (!info || seen.has(info.songmid)) continue
      seen.add(info.songmid)
      songs.push(toNewMusicInfo(info) as LX.Music.MusicInfoOnline)
      if (songs.length >= RECOMMEND_TARGET) break
    }
  }
  if (!songs.length) throw new Error(global.i18n.t(expired ? 'qq_session_expired' : 'qq_load_failed'))
  return songs
}

export const getQQMusicPlaylistSongs = async(cookie: string, playlistId: string) => {
  // 歌单详情本身是公开的，但仍带上账号 Cookie：QQ 对私有歌单需要它
  const uin = getQQMusicUin(cookie)
  const url = `${QQ_PLAYLIST_DETAIL_URL}?type=1&json=1&utf8=1&onlysong=0&new_format=1&disstid=${encodeURIComponent(playlistId)}&loginUin=${encodeURIComponent(uin)}&hostUin=${encodeURIComponent(uin)}&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0`
  const body = await request(url, cookie)
  const rawSongs: any[] = Array.isArray(body?.cdlist?.[0]?.songlist) ? body.cdlist[0].songlist : []
  if (rawSongs.length) return mapSongs(rawSongs)
  return getQQMusicPlaylistSongsFallback(playlistId)
}

export const getQQMusicPlaylistSongsFallback = async(playlistId: string) => {
  const result = await (musicSdk.tx.songList.getListDetail(playlistId) as Promise<{ list: any[] }>)
  return result.list.map(item => toNewMusicInfo(item)) as LX.Music.MusicInfoOnline[]
}
