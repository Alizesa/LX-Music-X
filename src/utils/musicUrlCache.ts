import { parseApiSourceOrder } from './apiSourceOrder'

export interface CachedMusicUrl {
  url: string
  context: string
  /** 请求音质与返回音质可能不同；旧记录省略时以存储 key 的音质为准。 */
  actualQuality?: LX.Quality
}

/** 只复用同一取址策略的结果；上下文在请求开始时捕获，迟到结果不能被标成新源。 */
export const getMusicUrlCacheContext = (setting: LX.AppSetting, order?: LX.Music.UrlSourceOrder) => JSON.stringify([
  1,
  setting['common.apiSource'],
  parseApiSourceOrder(setting['common.apiSourceOrder'], setting['common.apiSource']),
  order ?? (setting['player.urlSource'] === 'source' ? 'sourceFirst' : 'accountFirst'),
  setting['player.noVipStandardQuality'],
])
