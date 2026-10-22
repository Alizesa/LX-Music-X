// QQ 音乐手机号验证码登录 + 票据续期。
// 协议对齐 MusicOne（HGODLK/MusicOne）的 QqSmsLoginClient：
// 同一个 musicu.fcg 的 phoneLogin 块，SendPhoneAuthCode 发验证码、Login 登录/续期。
import CookieManager from '@react-native-cookies/cookies'
import { httpFetch } from '@/utils/request'
import { getQQMusicDeviceId, saveQQMusicDeviceId } from '@/utils/data'
import {
  QQ_APP_USER_AGENT,
  getQQMusicAuthKey,
  getQQMusicUin,
  isQQMusicCookie,
  mergeQQMusicCookies,
  normalizeUin,
  parseQQMusicCookie,
  readMusicKey,
  readUin,
  serializeQQMusicCookie,
} from './qqMusicCookie'

const MUSIC_U_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
const LOGIN_BLOCK = 'phoneLogin'
// fetch 的 Cookie 会经由 RN 的 ForwardingCookieHandler 落到同一个 Android CookieManager；
// 读回来是为了拿到 SendPhoneAuthCode 下发的会话 Cookie（登录时服务端会校验）。
const RESPONSE_COOKIE_URLS = ['https://u.y.qq.com/', 'https://y.qq.com/']

const CREDENTIAL_FIELDS = [
  'openid', 'refresh_token', 'access_token', 'expired_at', 'musicid', 'str_musicid',
  'musickey', 'unionid', 'refresh_key', 'musickeyCreateTime', 'keyExpiresIn',
  'first_login', 'bindAccountType', 'needRefreshKeyIn', 'encryptUin', 'loginType',
] as const

const LOGIN_ERROR_KEYS = {
  1000: 'qq_login_expired',
  104400: 'qq_login_expired',
  104401: 'qq_login_expired',
  20271: 'qq_code_invalid',
  20274: 'qq_account_unbound',
  20277: 'qq_account_restricted',
  20278: 'qq_account_restricted',
  20450: 'qq_account_restricted',
  20279: 'qq_device_limit',
  100001: 'qq_too_frequent',
  104604: 'qq_too_frequent',
  20276: 'qq_security_required',
} as const
type LoginErrorKey = typeof LOGIN_ERROR_KEYS[keyof typeof LOGIN_ERROR_KEYS]

export class QQMusicLoginError extends Error {
  code: number
  constructor(message: string, code = 0) {
    super(message)
    this.name = 'QQMusicLoginError'
    this.code = code
  }
}

/** 20276：服务端要求先在 securityURL 完成滑块/点选验证，完成后带 Cookie 重试原操作 */
export class QQMusicSecurityRequiredError extends Error {
  url: string
  cookie: string
  constructor(url: string, cookie: string) {
    super(global.i18n.t('qq_security_required'))
    this.name = 'QQMusicSecurityRequiredError'
    this.url = url
    this.cookie = cookie
  }
}

const randomDeviceId = () => {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let id = ''
  for (let i = 0; i < 32; i++) id += chars[Math.floor(Math.random() * chars.length)]
  return id
}

/** 稳定设备标识：换号/退出都不清，否则服务端会把每次登录当成新设备 */
export const getQQMusicLoginDeviceId = async() => {
  const stored = await getQQMusicDeviceId()
  if (stored) {
    const normalized = String(stored).replace(/[^A-Za-z0-9]/g, '').slice(0, 32)
    if (normalized.length >= 8) return normalized
  }
  const id = randomDeviceId()
  await saveQQMusicDeviceId(id)
  return id
}

const loginComm = (deviceId: string, login: boolean) => ({
  ct: 11,
  cv: 14090008,
  v: 14090008,
  chid: '10003505',
  tmeAppID: 'qqmusic',
  tmeLoginMethod: 3,
  QIMEI: '',
  QIMEI36: '',
  OpenUDID: deviceId,
  OpenUDID2: deviceId,
  udid: deviceId,
  aid: deviceId,
  os_ver: '14',
  phonetype: 'MusicOne',
  devicelevel: '34',
  newdevicelevel: '34',
  rom: 'MusicOne',
  ...(login ? { tmeLoginType: 0 } : {}),
})

const loginError = (body: Record<string, any>, fallback: string) => {
  const code = Number(body.code ?? -1)
  const key = (LOGIN_ERROR_KEYS as Record<number, LoginErrorKey | undefined>)[code]
  const serverMessage = String(body.message ?? body.msg ?? '').trim()
  const message = key
    ? global.i18n.t(key)
    : serverMessage || (code > 0 ? `${fallback}（${code}）` : fallback)
  return new QQMusicLoginError(message, code > 0 ? code : 0)
}

const firstText = (body: Record<string, any>, names: readonly string[]) => {
  for (const name of names) {
    const value = body[name]
    if (value == null) continue
    const text = String(value).trim()
    if (text && text !== '0') return text
  }
  return ''
}

// RN 会把多个 Set-Cookie 用 ", " 拼起来；按「逗号 + name=」切开，避开 Expires 里的逗号。
// 取每段第一个分号前的内容，就是 name=value。
const extractSetCookies = (headers: unknown) => {
  if (!headers || typeof headers != 'object') return ''
  const map = headers as Record<string, unknown>
  const raw = map['set-cookie'] ?? map['Set-Cookie']
  if (!raw) return ''
  const values = Array.isArray(raw) ? raw : [raw]
  const pairs: string[] = []
  for (const value of values) {
    if (typeof value !== 'string') continue
    for (const part of value.split(/,(?=\s*[A-Za-z0-9_!#$%&'*+.^`|~-]+=)/)) {
      const pair = part.split(';', 1)[0].trim()
      const index = pair.indexOf('=')
      if (index <= 0) continue
      const name = pair.slice(0, index).trim()
      if (name) pairs.push(`${name}=${pair.slice(index + 1).trim()}`)
    }
  }
  return pairs.join('; ')
}

const readResponseCookie = async(baseCookie: string, headers?: unknown) => {
  // 等原生 CookieManager 落盘，再读 fetch 期间响应下发的 Cookie
  await CookieManager.flush().catch(() => {})
  let cookie = baseCookie
  for (const url of RESPONSE_COOKIE_URLS) {
    try {
      const cookies = await CookieManager.get(url, true)
      const header = Object.values(cookies)
        .filter(item => item?.name && item.value != null && item.value !== '')
        .map(item => `${item.name}=${item.value}`)
        .join('; ')
      cookie = mergeQQMusicCookies(cookie, header)
    } catch {}
  }
  // CookieManager 偶尔拿不到跨域 Set-Cookie，直接读响应头兜底
  return mergeQQMusicCookies(cookie, extractSetCookies(headers))
}

/** 把 Login 返回的 data 组装成项目现有会话能直接吃的 Cookie（uin + 音乐票据 + 续期字段） */
const buildCredentialCookie = (baseCookie: string, data: Record<string, any>) => {
  const userId = firstText(data, ['musicid', 'str_musicid', 'musicId', 'userid', 'user_id', 'uin'])
  const musicKey = firstText(data, ['musickey', 'music_key', 'qqmusic_key', 'qm_keyst', 'strMusicKey'])
  if (!userId || !musicKey) throw new QQMusicLoginError(global.i18n.t('qq_login_failed'))
  const accountId = userId.replace(/^o/i, '')
  const values: Record<string, string> = {}
  for (const name of CREDENTIAL_FIELDS) {
    const value = data[name]
    if (value == null) continue
    const text = String(value).trim()
    if (text) values[name] = text
  }
  values.musicid = userId
  values.musickey = musicKey
  // 和 MusicOne 一致：uin 用 o + 10 位补零，qqmusic_uin 用纯账号
  values.uin = `o${accountId.padStart(10, '0')}`
  values.qqmusic_uin = accountId
  // 手机号登录是 QQ 身份；网页接口（资料/收藏列表）按这个字段区分 QQ 与微信
  values.login_type = '1'
  values.qqmusic_key = musicKey
  values.qm_keyst = musicKey
  values.authst = musicKey
  const cookie = mergeQQMusicCookies(baseCookie, serializeQQMusicCookie(values))
  if (!isQQMusicCookie(cookie)) throw new QQMusicLoginError(global.i18n.t('qq_login_failed'))
  return cookie
}

interface PhoneLoginOptions {
  login: boolean
  /** 0/缺省是首次登录；1 = 微信身份，2 = QQ 身份（续期时传） */
  loginType?: number
  cookie?: string
}

const postPhoneLogin = async(method: string, param: Record<string, unknown>, options: PhoneLoginOptions) => {
  const deviceId = await getQQMusicLoginDeviceId()
  const comm: Record<string, unknown> = loginComm(deviceId, options.login)
  if (options.login) comm.tmeLoginType = options.loginType ?? 0
  if (options.loginType) {
    comm.qq = getQQMusicUin(options.cookie ?? '')
    comm.authst = getQQMusicAuthKey(options.cookie ?? '')
  }
  const result = await httpFetch(MUSIC_U_URL, {
    method: 'post',
    headers: {
      'User-Agent': QQ_APP_USER_AGENT,
      Referer: 'https://y.qq.com/',
      ...(options.cookie ? { Cookie: options.cookie } : {}),
    },
    body: {
      comm,
      [LOGIN_BLOCK]: {
        module: 'music.login.LoginServer',
        method,
        param,
      },
    },
  }).promise
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new QQMusicLoginError(`QQ Music HTTP ${result.statusCode}`)
  }
  const json = result.body as Record<string, any> | null
  if (!json || typeof json != 'object') throw new QQMusicLoginError(global.i18n.t('qq_login_failed'))
  if (Number(json.code ?? 0) != 0) throw loginError(json, global.i18n.t('qq_login_failed'))
  const block = json[LOGIN_BLOCK] as Record<string, any> | undefined
  if (!block) throw new QQMusicLoginError(global.i18n.t('qq_login_failed'))
  const cookie = await readResponseCookie(options.cookie ?? '', result.headers)
  const securityUrl = String(block.data?.securityURL ?? block.data?.securityUrl ?? '')
  if (Number(block.code ?? 0) === 20276 && securityUrl) {
    throw new QQMusicSecurityRequiredError(securityUrl, cookie)
  }
  if (Number(block.code ?? 0) != 0) throw loginError(block, global.i18n.t('qq_login_failed'))
  return { data: (block.data ?? {}) as Record<string, any>, cookie }
}

const normalizePhone = (phone: string) => {
  const value = String(phone ?? '').trim().replace(/\s+/g, '')
  if (value.length < 6 || value.length > 20 || /\D/.test(value)) {
    throw new QQMusicLoginError(global.i18n.t('qq_phone_invalid'))
  }
  return value
}

const normalizeCountryCode = (countryCode: string) => {
  const value = String(countryCode ?? '').trim().replace(/^\+/, '') || '86'
  if (value.length > 4 || /\D/.test(value)) {
    throw new QQMusicLoginError(global.i18n.t('qq_country_code_invalid'))
  }
  return value
}

export const sendQQMusicPhoneCaptcha = async(phone: string, countryCode: string, cookieSeed = '') => {
  const result = await postPhoneLogin('SendPhoneAuthCode', {
    tmeAppid: 'qqmusic',
    areaCode: normalizeCountryCode(countryCode),
    phoneNo: normalizePhone(phone),
  }, { login: false, cookie: cookieSeed })
  return { message: global.i18n.t('qq_code_sent'), cookie: result.cookie }
}

export interface QQMusicPhoneLoginResult {
  cookie: string
  /** 登录回包自带的资料；网页资料接口在手机号票据下不一定取得到 */
  nickname?: string
  avatar?: string
}

export const loginQQMusicByPhone = async(phone: string, code: string, cookieSeed = ''): Promise<QQMusicPhoneLoginResult> => {
  const captcha = String(code ?? '').trim()
  if (captcha.length < 4 || captcha.length > 10 || /\D/.test(captcha)) {
    throw new QQMusicLoginError(global.i18n.t('qq_code_invalid'))
  }
  const result = await postPhoneLogin('Login', {
    phoneNo: normalizePhone(phone),
    code: captcha,
    loginMode: 1,
  }, { login: true, cookie: cookieSeed })
  return {
    cookie: buildCredentialCookie(result.cookie, result.data),
    nickname: firstText(result.data, ['nick', 'nickname', 'nickName', 'name']) || undefined,
    avatar: firstText(result.data, ['avatar', 'avatarUrl', 'head', 'headPic', 'headurl']) || undefined,
  }
}

/** 是否带得过续期的字段（网页登录的票据没有 refresh_token，不走这条） */
export const hasQQMusicRefreshCredential = (cookie: string) => {
  const values = parseQQMusicCookie(cookie)
  return !!readUin(values) && !!readMusicKey(values) && !!(values.refresh_token || values.refresh_key)
}

/** musickeyCreateTime / keyExpiresIn 都是秒；提前 10 分钟续 */
export const shouldRefreshQQMusicCookie = (cookie: string, nowSeconds = Date.now() / 1000) => {
  const values = parseQQMusicCookie(cookie)
  const created = Number(values.musickeyCreateTime)
  const lifetime = Number(values.keyExpiresIn)
  if (!Number.isFinite(created) || !Number.isFinite(lifetime) || created <= 0 || lifetime <= 0) return false
  return nowSeconds >= created + lifetime - 600
}

/**
 * 用 refresh_token 换一张新票据。只负责网络与 Cookie 组装，不落库；
 * 落库/并发去重由 core/qqMusic.ts 的 refreshQQMusicCookie 统一处理。
 */
export const requestQQMusicCredentialRefresh = async(cookie: string) => {
  if (!hasQQMusicRefreshCredential(cookie)) return null
  const values = parseQQMusicCookie(cookie)
  const accountId = readUin(values)
  const musicKey = readMusicKey(values)
  if (!accountId || !musicKey) return null
  const loginType = Number(values.loginType) === 1 || Number(values.loginType) === 2
    ? Number(values.loginType)
    : musicKey.startsWith('W_X') ? 1 : 2
  const result = await postPhoneLogin('Login', {
    openid: values.openid ?? '',
    access_token: values.access_token ?? '',
    refresh_token: values.refresh_token ?? '',
    expired_in: Number(values.expired_at ?? 0) || 0,
    str_musicid: values.str_musicid || accountId,
    musicid: Number(accountId) || 0,
    musickey: musicKey,
    unionid: values.unionid ?? '',
    refresh_key: values.refresh_key ?? '',
    loginMode: 2,
  }, { login: true, loginType, cookie })
  const data = result.data
  const returnedId = normalizeUin(firstText(data, ['musicid', 'str_musicid', 'musicId', 'userid', 'user_id', 'uin']))
  if (returnedId && returnedId !== accountId) {
    throw new QQMusicLoginError(global.i18n.t('qq_login_failed'))
  }
  // 服务端没回账号时补上，buildCredentialCookie 需要它
  if (!returnedId) data.musicid = accountId
  const refreshed = buildCredentialCookie(result.cookie, data)
  // 有些响应不更新 musickeyCreateTime：沿用它会让「临近过期」永远成立，
  // 每读一次会话就多打一次续期请求。续期成功就用本地时间兜底。
  const valuesAfter = parseQQMusicCookie(refreshed)
  const baseCreated = Number(values.musickeyCreateTime) || 0
  const newCreated = Number(valuesAfter.musickeyCreateTime) || 0
  if (newCreated <= baseCreated) {
    valuesAfter.musickeyCreateTime = String(Math.floor(Date.now() / 1000))
    return serializeQQMusicCookie(valuesAfter)
  }
  return refreshed
}
