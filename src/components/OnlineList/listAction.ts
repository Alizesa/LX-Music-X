import { LIST_IDS } from '@/config/constant'
import { addToPlayQueue, playList, playNext } from '@/core/player/player'
import { getPlayQueue } from '@/core/player/playQueue'
import { addTempPlayList } from '@/core/player/tempPlayList'
import settingState from '@/store/setting/state'
import { confirmDialog, shareMusic, toast } from '@/utils/tools'
import { addDislikeInfo, hasDislike } from '@/core/dislikeList'
import playerState from '@/store/player/state'
import { clearMusicUrlByMusic } from '@/utils/data'

/**
 * 点列表里的一首歌播放。
 *
 * 不再往「试听列表」里塞 —— 本地列表那套已经拆了，现在一切从播放队列走：
 * 加进队列（已有的会去重）再定位到它起播。
 */
export const handlePlay = (musicInfo: LX.Music.MusicInfoOnline) => {
  void addToPlayQueue([musicInfo]).then(() => {
    const index = getPlayQueue().findIndex(item => item.musicInfo.id == musicInfo.id)
    if (index < 0) return
    void playList(LIST_IDS.PLAY_QUEUE, index)
  })
}
export const handlePlayLater = (musicInfo: LX.Music.MusicInfoOnline, selectedList: LX.Music.MusicInfoOnline[], onCancelSelect: () => void) => {
  if (selectedList.length) {
    addTempPlayList(selectedList.map(s => ({ listId: '', musicInfo: s })))
    onCancelSelect()
  } else {
    addTempPlayList([{ listId: '', musicInfo }])
  }
}
export const handleAddToPlayQueue = (musicInfo: LX.Music.MusicInfoOnline, selectedList: LX.Music.MusicInfoOnline[], onCancelSelect: () => void) => {
  void addToPlayQueue(selectedList.length ? selectedList : [musicInfo]).then(count => {
    // 一首都没加进去，说明队列里已经有这首歌了
    toast(global.i18n.t(count ? 'list_edit_action_tip_add_success' : 'list_edit_action_tip_exist'))
  })
  if (selectedList.length) onCancelSelect()
}


export const handleShare = (musicInfo: LX.Music.MusicInfoOnline) => {
  shareMusic(settingState.setting['common.shareType'], settingState.setting['download.fileName'], musicInfo)
}

export const clearMusicUrl = async(musicInfo: LX.Music.MusicInfoOnline) => {
  try {
    await clearMusicUrlByMusic(musicInfo)
  } catch (error) {
    toast(global.i18n.t('list_remove_cache_fail_tip', { msg: (error as Error).message }))
    return
  }
  toast(global.i18n.t('list_remove_cache_success_tip'))
}

export const handleDislikeMusic = async(musicInfo: LX.Music.MusicInfoOnline) => {
  const confirm = await confirmDialog({
    message: musicInfo.singer ? global.i18n.t('lists_dislike_music_singer_tip', { name: musicInfo.name, singer: musicInfo.singer }) : global.i18n.t('lists_dislike_music_tip', { name: musicInfo.name }),
    cancelButtonText: global.i18n.t('cancel_button_text_2'),
    confirmButtonText: global.i18n.t('confirm_button_text'),
    bgClose: false,
  })
  if (!confirm) return
  await addDislikeInfo([{ name: musicInfo.name, singer: musicInfo.singer }])
  toast(global.i18n.t('lists_dislike_music_add_tip'))
  if (hasDislike(playerState.playMusicInfo.musicInfo)) {
    void playNext(true)
  }
}

