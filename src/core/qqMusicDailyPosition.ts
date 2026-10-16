import { getQQMusicDailyPosition, saveQQMusicDailyPosition } from '@/utils/data'
import { isPlayQueueFromList } from '@/core/player/playQueue'
import listState from '@/store/list/state'
import playerState from '@/store/player/state'
import { LIST_IDS } from '@/config/constant'

/** 每日推荐那批歌存进临时列表时用的 id（见 Home/Views/Recommend） */
export const QQ_DAILY_PLAYLIST_ID = 'qq_daily_playlist'

/**
 * 记「每日推荐播到哪了」。
 *
 * 只记当前这首歌的 id，**不记下标**：下次打开时列表内容可能已经换了（每日推荐本身每天
 * 就换一批），存下标会指到别的歌上；按 id 找就没这个问题，找不到自然退回开头。
 *
 * 认的是「当前这条播放队列是每日推荐建出来的」，光看临时列表标记不够：那个标记只在
 * setTempList 时才变，而点「猜你喜欢」时若走的是接手存档那条分支（
 * qqMusicRecommend.continueRecommendQueue 返回 true），playGuess 直接 return，
 * 根本不调 setTempList —— 标记还停在每日推荐上，猜你喜欢的歌就被记进这份位置里了。
 * 回头再点每日推荐，那首歌不在 30 首里，只能退回第一首。
 * 队列自己的来源标记没这个问题，它跟着队列一起被 replace 掉（同 qqMusicRecommendSession）。
 */
export const initQQMusicDailyPosition = () => {
  global.state_event.on('playerMusicInfoChanged', () => {
    // 每日推荐整表播放走的是临时列表（Recommend 里的 playDaily）。
    // 猜你喜欢用自己的队列标记，单曲播放和试听列表则会把队列换成别的来源，都不该记。
    if (!isPlayQueueFromList(LIST_IDS.TEMP)) return
    if (listState.tempListMeta.id != QQ_DAILY_PLAYLIST_ID) return
    // 插进来的「稍后播放」不属于这条列表
    if (playerState.playMusicInfo.isTempPlay) return
    const raw = playerState.playMusicInfo.musicInfo
    if (!raw) return
    const musicInfo = 'progress' in raw ? raw.metadata.musicInfo : raw
    void saveQQMusicDailyPosition({ songId: musicInfo.id, savedAt: Date.now() })
  })
}

/**
 * 上次播到的那首歌在当前列表里的位置；找不到就从头放（0）。
 * 今天换了新的一批、或那首歌被下掉了，都会落到 0。
 */
export const resolveQQMusicDailyIndex = async(songs: LX.Music.MusicInfoOnline[]) => {
  const saved = await getQQMusicDailyPosition()
  if (!saved) return 0
  return Math.max(songs.findIndex(song => song.id == saved.songId), 0)
}
