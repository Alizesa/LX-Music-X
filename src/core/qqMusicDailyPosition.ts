import { getQQMusicDailyPosition, saveQQMusicDailyPosition } from '@/utils/data'
import listState from '@/store/list/state'
import playerState from '@/store/player/state'

/** 每日推荐那批歌存进临时列表时用的 id（见 Home/Views/Recommend） */
export const QQ_DAILY_PLAYLIST_ID = 'qq_daily_playlist'

/**
 * 记「每日推荐播到哪了」。
 *
 * 只记当前这首歌的 id，**不记下标**：下次打开时列表内容可能已经换了（每日推荐本身每天
 * 就换一批），存下标会指到别的歌上；按 id 找就没这个问题，找不到自然退回开头。
 *
 * 只认 `tempListMeta.id` 是每日推荐的那条队列 ——「猜你喜欢」走的是另一个 id，不会被记。
 */
export const initQQMusicDailyPosition = () => {
  global.state_event.on('playerMusicInfoChanged', () => {
    if (listState.tempListMeta.id != QQ_DAILY_PLAYLIST_ID) return
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
