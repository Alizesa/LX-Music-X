// QQ 音乐不同接口返回的用户资料层级不完全一致（网页资料 / GetLoginUserInfo /
// 手机号登录回包各有一套包装）。按字段名递归找，避免绑死某一层。

// 昵称先找明确字段，最后才用泛化的 name，免得抓到嵌套对象的无关名字。
export const PROFILE_NICK_KEYS = ['nick', 'nickname', 'strnickname', 'strnick', 'username', 'displayname']
export const PROFILE_AVATAR_KEYS = ['headpic', 'headpicurl', 'headurl', 'avatar', 'avatarurl', 'head', 'portrait', 'face', 'photo', 'logo']

const normalizeProfileKey = (key: string) => key.toLowerCase().replace(/[_-]/g, '')

export const findProfileField = (source: unknown, keys: string[], depth = 0): string => {
  if (!source || typeof source != 'object' || depth > 6) return ''
  const wanted = new Set(keys)
  for (const [key, value] of Object.entries(source)) {
    if (typeof value == 'string' && value.trim() && wanted.has(normalizeProfileKey(key))) return value.trim()
  }
  for (const value of Object.values(source)) {
    if (value && typeof value == 'object') {
      const found = findProfileField(value, keys, depth + 1)
      if (found) return found
    }
  }
  return ''
}
