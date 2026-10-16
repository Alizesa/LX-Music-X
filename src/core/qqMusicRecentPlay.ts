import { getQQMusicSession, postAuthedMusicu } from './qqMusic'
import settingState from '@/store/setting/state'
import playerState from '@/store/player/state'

/**
 * 把本机播放上报到 QQ 的「最近播放」（云端记录）。
 *
 * **只写不读**：这份记录是给 QQ 客户端那边看的（换设备能接着播），本机的播放历史另有
 * 一份本地表（core/player/playHistory），播放历史页只显示本地那份。
 *
 * 上报时机：歌真的开始播了（playerPlaying）才报，而且每首歌只报一次 ——
 * 暂停再播也会再响一次 playerPlaying，靠「这首报过没有」挡掉（不然一首歌暂停几次
 * 就多发几次请求）；换歌时（playMusicInfoChanged）放开，所以重播同一首会重新上报。
 *
 * 参数形状照参考实现的 ReportPlayRecentlyInfo：数字 songId（字符串）+ mid +
 * lastTime（秒）+ listenCnt，type=2 是歌曲维度（和读那条一致）。
 */
let reportedId: string | null = null

const report = async(musicInfo: LX.Music.MusicInfo): Promise<void> => {
  if (musicInfo.source != 'tx') return
  // 数字 songId 和 mid 只有 tx 那份 info 上有（上面按来源挡过一次，类型也就收窄了）
  const songId = Number(musicInfo.meta.id ?? 0)
  const songMid = String(musicInfo.meta.songId ?? '')
  // 缺数字 id 或 mid 就没法上报：参考实现也是这两个都齐了才发（补不齐宁可不报）
  if (!songId || !songMid) return
  const { cookie } = await getQQMusicSession()
  if (!cookie) return
  const body = await postAuthedMusicu(cookie, {
    req_0: {
      module: 'music.musicasset.PlayRecentlyWrite',
      method: 'ReportPlayRecentlyInfo',
      param: {
        data: [{
          id: String(songId),
          type: 2,
          lastTime: Math.floor(Date.now() / 1000),
          listenCnt: 1,
          auxillaryID: songMid,
        }],
      },
    },
  })
  const code = Number(body?.code ?? -1)
  const requestCode = Number(body?.req_0?.code ?? -1)
  const ret = Number(body?.req_0?.data?.ret ?? -1)
  if (code !== 0 || requestCode !== 0 || ret !== 0) {
    throw new Error(`code=${code} reqCode=${requestCode} ret=${ret}`)
  }
}

/** 由 core/init/dataInit 调用一次。幂等 */
let initialized = false
export const initQQMusicRecentPlayReport = () => {
  if (initialized) return
  initialized = true
  // 换歌就放开：同一首歌重播也要能再报一次
  global.state_event.on('playMusicInfoChanged', () => { reportedId = null })
  global.app_event.on('playerPlaying', () => {
    // 设置里关了「保存播放历史」，云端这份也不写
    if (!settingState.setting['player.isSavePlayHistory']) return
    const raw = playerState.playMusicInfo.musicInfo
    if (!raw) return
    const musicInfo = 'progress' in raw ? raw.metadata.musicInfo : raw
    if (musicInfo.source != 'tx' || musicInfo.id === reportedId) return
    reportedId = musicInfo.id
    void report(musicInfo).catch(error => {
      // 上报是给云端看的旁路，失败不打扰用户，也别影响播放
      console.warn('[QQMusic] 最近播放上报失败:', error instanceof Error ? error.message : error)
    })
  })
}
