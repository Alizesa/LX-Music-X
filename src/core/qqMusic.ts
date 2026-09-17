import { httpFetch } from '@/utils/request'
import { getQQMusicCookie, getQQMusicUser, saveQQMusicCookie, saveQQMusicUser, removeQQMusicCookie } from '@/utils/data'
import { toNewMusicInfo } from '@/utils'
import musicSdk from '@/utils/musicSdk'
import CookieManager from '@react-native-cookies/cookies'

const QQ_API = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
const QQ_REFERER = 'https://y.qq.com/'
const QQ_COOKIE_URLS = ['https://y.qq.com/', 'https://qq.com/', 'https://c.y.qq.com/', 'https://u.y.qq.com/']

const getCookieValue = (cookie: string, name: string) => {
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(cookie)
  return match?.[1] ?? ''
}

export const isQQMusicCookie = (cookie: string) => {
  const uin = getQQMusicUin(cookie)
  const authKey = getCookieValue(cookie, 'qm_keyst') ||
    getCookieValue(cookie, 'qqmusic_key') ||
    getCookieValue(cookie, 'p_skey') ||
    getCookieValue(cookie, 'skey')
  return !!uin && !!authKey
}

export const getQQMusicUin = (cookie: string) => {
  const value = getCookieValue(cookie, 'uin') || getCookieValue(cookie, 'qqmusic_uin') || getCookieValue(cookie, 'p_uin')
  return value.replace(/^o/, '')
}

const request = async(url: string, cookie: string, options: Record<string, any> = {}) => {
  const result = await httpFetch(url, {
    ...options,
    headers: {
      Referer: QQ_REFERER,
      Origin: 'https://y.qq.com',
      Cookie: cookie,
      ...(options.headers ?? {}),
    },
  }).promise
  if (result.statusCode < 200 || result.statusCode >= 300) throw new Error(`QQ Music HTTP ${result.statusCode}`)
  return result.body as any
}

const findFirstArray = (value: any, predicate: (item: any) => boolean): any[] => {
  if (!value || typeof value != 'object') return []
  if (Array.isArray(value)) {
    if (value.length && value.some(predicate)) return value
    for (const item of value) {
      const result = findFirstArray(item, predicate)
      if (result.length) return result
    }
    return []
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    const result = findFirstArray(item, predicate)
    if (result.length) return result
  }
  return []
}

const rawSongToOldInfo = (raw: any) => {
  const song = raw?.songInfo ?? raw?.track_info ?? raw?.song ?? raw
  const singer = Array.isArray(song?.singer)
    ? song.singer.map((item: any) => item.name).filter(Boolean).join('、')
    : song?.singer?.name ?? song?.singer ?? ''
  const album = song?.album ?? {}
  const file = song?.file ?? {}
  const songmid = song?.songmid ?? song?.mid ?? song?.song_mid
  const albumId = album?.mid ?? song?.albumMid ?? ''
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
    songId: song?.id ?? songmid,
    name: song?.title ?? song?.name,
    singer,
    albumName: album?.name ?? song?.albumName ?? '',
    albumId,
    albumMid: albumId,
    strMediaMid: file?.media_mid ?? song?.strMediaMid ?? songmid,
    interval: song?.interval ? `${Math.floor(song.interval / 60).toString().padStart(2, '0')}:${(song.interval % 60).toString().padStart(2, '0')}` : null,
    img: albumId ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumId}.jpg` : '',
    source: 'tx',
    types,
    _types,
  }
}

const normalizeSongs = (body: any): LX.Music.MusicInfoOnline[] => {
  const rawSongs = findFirstArray(body, item => !!(item?.songmid || item?.mid || item?.songInfo?.songmid || item?.track_info?.mid))
  return rawSongs.map(rawSongToOldInfo).filter(Boolean).map(item => toNewMusicInfo(item)) as LX.Music.MusicInfoOnline[]
}

const normalizePlaylist = (raw: any): LX.QQMusic.PlaylistInfo | null => {
  const id = raw?.tid ?? raw?.dissid ?? raw?.disstid ?? raw?.id
  const name = raw?.dissname ?? raw?.title ?? raw?.name
  if (id == null || !name) return null
  return {
    id: String(id),
    name: String(name),
    cover: raw?.logo ?? raw?.imgurl ?? raw?.cover?.medium_url ?? raw?.cover_url_medium,
    description: raw?.desc ?? raw?.introduction ?? '',
    trackCount: Number(raw?.song_count ?? raw?.songnum ?? raw?.total ?? 0) || undefined,
  }
}

export const getQQMusicSession = async() => ({
  cookie: await getQQMusicCookie() ?? '',
  user: await getQQMusicUser() ?? null,
})

export const saveQQMusicSession = async(cookie: string) => {
  const normalizedCookie = cookie.split(';').map(item => item.trim()).filter(Boolean).join('; ')
  if (!isQQMusicCookie(normalizedCookie)) throw new Error(global.i18n.t('qq_cookie_invalid'))
  const uin = getQQMusicUin(normalizedCookie)
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
  const uin = getQQMusicUin(cookie)
  const body = await request(QQ_API, cookie, {
    method: 'post',
    body: {
      comm: { ct: 24, cv: 4747474, uin: uin || '0' },
      userinfo: {
        module: 'QQMusic.Login',
        method: 'GetLoginInfo',
        param: {},
      },
    },
  })
  const raw = body?.userinfo?.data ?? body?.userinfo ?? body?.data?.userinfo ?? {}
  const responseCode = body?.userinfo?.code ?? body?.userinfo?.data?.code
  if (responseCode != null && Number(responseCode) !== 0) throw new Error('QQ Music session expired')
  const resolvedUin = String(raw?.uin ?? raw?.qq ?? uin ?? '')
  if (raw?.is_login === false || raw?.login === false) throw new Error('QQ Music session expired')
  return {
    uin: resolvedUin,
    nickname: raw?.nick ?? raw?.nickname ?? raw?.nickName ?? (resolvedUin ? `QQ ${resolvedUin}` : 'QQ Music'),
    avatar: raw?.avatar ?? raw?.headurl ?? raw?.avatarurl,
  }
}

export const getQQMusicPlaylists = async(cookie: string): Promise<LX.QQMusic.PlaylistInfo[]> => {
  const uin = getQQMusicUin(cookie)
  if (!uin) throw new Error('QQ Music account ID not found')
  const url = `https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_songlist.fcg?hostuin=${encodeURIComponent(uin)}&sin=0&size=100&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq&needNewCode=0`
  const body = await request(url, cookie)
  const rawList = body?.data?.disslist ?? body?.disslist ?? body?.data?.list ?? body?.list ?? []
  return rawList.map(normalizePlaylist).filter(Boolean) as LX.QQMusic.PlaylistInfo[]
}

export const getQQMusicDailyRecommendations = async(cookie: string): Promise<LX.Music.MusicInfoOnline[]> => {
  const uin = getQQMusicUin(cookie)
  if (!uin) throw new Error('QQ Music account ID not found')
  const body = await request(QQ_API, cookie, {
    method: 'post',
    body: {
      comm: { ct: 24, cv: 4747474, uin },
      recommend: {
        module: 'music.recommend.RecommendFeedServer',
        method: 'get_recommend_feed',
        param: { uin, from: 0, num: 50 },
      },
    },
  })
  const songs = normalizeSongs(body)
  if (songs.length) return songs
  throw new Error('QQ Music recommendations are unavailable')
}

export const getQQMusicPlaylistSongs = async(cookie: string, playlistId: string) => {
  // Playlist details are public, while the account cookie is still passed to
  // the request when QQ requires it for private lists.
  const body = await request(`https://c.y.qq.com/qzone/fcgi-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&onlysong=0&new_format=1&disstid=${encodeURIComponent(playlistId)}&loginUin=${encodeURIComponent(getQQMusicUin(cookie))}&hostUin=${encodeURIComponent(getQQMusicUin(cookie))}&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0`, cookie)
  const rawSongs = body?.cdlist?.[0]?.songlist ?? []
  if (rawSongs.length) return normalizeSongs({ songs: rawSongs })
  return getQQMusicPlaylistSongsFallback(playlistId)
}

export const getQQMusicPlaylistSongsFallback = async(playlistId: string) => {
  const result = await (musicSdk.tx.songList.getListDetail(playlistId) as Promise<{ list: any[] }>)
  return result.list.map(item => toNewMusicInfo(item)) as LX.Music.MusicInfoOnline[]
}
