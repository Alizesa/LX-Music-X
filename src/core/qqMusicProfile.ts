// QQ 音乐不同接口返回的用户资料层级不完全一致（网页资料 / GetLoginUserInfo /
// 手机号登录回包各有一套包装）。按字段名递归找，避免绑死某一层。

// 数组顺序就是优先级：先找明确的昵称/头像字段，最后才用泛化的 name 兜底。
export const PROFILE_NICK_KEYS = ['nick', 'nickname', 'strnickname', 'strnick', 'username', 'displayname']
export const PROFILE_AVATAR_KEYS = ['headpic', 'headpicurl', 'headurl', 'avatar', 'avatarurl', 'head', 'portrait', 'face', 'photo', 'logo']

const normalizeProfileKey = (key: string) => key.toLowerCase().replace(/[_-]/g, '')

const findKeyDeep = (source: unknown, key: string, depth: number): string => {
  if (!source || typeof source != 'object' || depth > 6) return ''
  for (const [rawKey, value] of Object.entries(source)) {
    if (typeof value == 'string' && value.trim() && normalizeProfileKey(rawKey) === key) return value.trim()
  }
  for (const value of Object.values(source)) {
    if (value && typeof value == 'object') {
      const found = findKeyDeep(value, key, depth + 1)
      if (found) return found
    }
  }
  return ''
}

/**
 * 按 keys 的先后顺序在整棵对象树里找字段。
 * 不能只按对象自身的键顺序找：那样一个顶层 username 会抢在嵌套的 nick 前面。
 */
export const findProfileField = (source: unknown, keys: string[]) => {
  for (const key of keys) {
    const found = findKeyDeep(source, normalizeProfileKey(key), 0)
    if (found) return found
  }
  return ''
}

/** getQQMusicUserInfo 的兜底昵称/头像：不要用它覆盖登录回包或资料接口拿到的真实值 */
export const isQQMusicFallbackNickname = (uin: string, nickname: string) => nickname === `QQ ${uin}`
export const isQQMusicFallbackAvatar = (avatar?: string) => !avatar || avatar.includes('qlogo.cn')
