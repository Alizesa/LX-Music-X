import { httpFetch } from '@/utils/request'
import { zzcSign } from './crypto'

export const comm = {
  _channelid: '0',
  _os_version: '6.2.9200-2',
  ct: '19',
  cv: '2151',
  guid: '1F70E520B2EAA7D25E11760783C53CA9',
  patch: '118',
  psrf_access_token_expiresAt: 0,
  psrf_qqaccess_token: '',
  psrf_qqopenid: '',
  psrf_qqunionid: '',
  tmeAppID: 'qqmusic',
  tmeLoginType: 0,
  uin: '0',
  wid: '7223299733393904640',
}

/**
 * @param data 请求体
 * @param path 接口路径，搜索接口是 musics.fcg，按 module/method 调用的接口是 musicu.fcg
 */
export const signRequest = async(data, path = 'musics.fcg') => {
  // console.log(data)
  const sign = await zzcSign(JSON.stringify(data))
  // console.log('sign', sign)
  return httpFetch(`https://u.y.qq.com/cgi-bin/${path}?sign=${sign}`, {
    method: 'post',
    headers: {
      'User-Agent': 'QQMusic 14090508(android 12)',
    },
    body: data,
  }).promise
}

/**
 * 按 module/method 调 client 接口，多个请求合并到一次 HTTP 里发出去，
 * 返回按传入顺序排好的 data 列表。任何一个子请求失败都直接抛错，
 * 由调用方决定要不要重试（这里不重试，避免出错时反复打同一个接口）。
 * @param reqs { module, method, param } 数组
 */
export const musicuRequest = async(reqs) => {
  const data = { comm }
  reqs.forEach((req, index) => {
    data[`req_${index}`] = req
  })
  return signRequest(data, 'musicu.fcg').then(({ body }) => {
    return reqs.map((req, index) => {
      const result = body?.[`req_${index}`]
      if (!result || result.code != 0) throw new Error(`请求失败: ${result?.code ?? body?.code ?? 'unknown'} (${req.module}.${req.method})`)
      return result.data
    })
  })
}
