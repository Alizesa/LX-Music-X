// QQ 音乐登录票据的解析/组装。qqMusic.ts（会话与请求）和 qqMusicLogin.ts
// （手机号登录/续期）共用，单独放一层避免两个模块互相 import。

// 这个 UA 只给登录用的 WebView：y.qq.com 的登录页要靠浏览器 UA 才能正常渲染。
// 项目默认的 Chrome/69 过于陈旧，这里用较新的版本。
export const QQ_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// 接口请求一律走手机 App 信封，UA 必须和 comm 里的 cv=14090008 对得上；
// 用浏览器 UA 配 App 版本号的话，服务端会按网页端返回，字段和可用功能都有出入。
export const QQ_APP_USER_AGENT = 'QQMusic 14090008(android 14)'

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

export const serializeQQMusicCookie = (cookies: Record<string, string>) => Object.keys(cookies)
  .filter(key => cookies[key] != null && cookies[key] !== '')
  .map(key => `${key}=${cookies[key]}`)
  .join('; ')

/** 后传的 Cookie 覆盖先传的同名项 */
export const mergeQQMusicCookies = (...cookies: Array<string | null | undefined>) => {
  const merged: Record<string, string> = {}
  for (const cookie of cookies) {
    if (!cookie) continue
    Object.assign(merged, parseQQMusicCookie(cookie))
  }
  return serializeQQMusicCookie(merged)
}

export const normalizeUin = (raw: unknown) => {
  const digits = String(raw ?? '').replace(/\D/g, '')
  return digits.replace(/^0+/, '') || digits
}

// 微信登录(login_type=2)时账号标识在 wxuin 上。
//
// 注意：**「0」是 QQ 音乐网页登录很常见的占位值**。它不是真账号，但又是 truthy ——
// 早先按 `||` 链取第一个非空值会直接拿到它，后面的 wxuin / qqmusic_uin 永远没机会。
// uin 于是变成字面量 0，凡是拿它拼地址的接口全废（qlogo 头像查 nk=0 必然查不到）。
export const readUin = (cookies: Record<string, string>) => {
  const candidates = Number(cookies.login_type) === 2
    ? [cookies.wxuin, cookies.uin, cookies.p_uin]
    : [cookies.uin, cookies.qqmusic_uin, cookies.wxuin, cookies.p_uin]
  const values = candidates.map(normalizeUin).filter(Boolean)
  // 有真号就优先用真号；一个都没有时仍退回占位值，
  // 否则会把一个本来能用的 Cookie 判成未登录
  return values.find(value => value != '0') ?? values[0] ?? ''
}

// 只有 qm_keyst / qqmusic_key / music_key 是 QQ 音乐自己的登录票据。
// skey / p_skey 属于 QQ 互联(.qq.com)，对音乐接口无效 —— 早先把它们当兜底，
// 会让"其实没登录成功"的 Cookie 通过本地校验，然后在服务端被拒。
export const readMusicKey = (cookies: Record<string, string>) => cookies.qm_keyst || cookies.qqmusic_key || cookies.music_key || ''

export const getQQMusicUin = (cookie: string) => readUin(parseQQMusicCookie(cookie))

export const getQQMusicAuthKey = (cookie: string) => readMusicKey(parseQQMusicCookie(cookie))

export const isQQMusicCookie = (cookie: string) => {
  const cookies = parseQQMusicCookie(cookie)
  return !!readUin(cookies) && !!readMusicKey(cookies)
}
