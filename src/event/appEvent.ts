import Event from './Event'
import { type SearchType } from '@/store/search/state'


// {
//   // sync: {
//   //   send_action_list: 'send_action_list',
//   //   handle_action_list: 'handle_action_list',
//   //   send_sync_list: 'send_sync_list',
//   //   handle_sync_list: 'handle_sync_list',
//   // },
// }

export class AppEvent extends Event {
  // configUpdate() {
  //   this.emit('configUpdate')
  // }

  focus() {
    this.emit('focus')
  }

  /**
   * 我的列表更新
   */
  mylistUpdated(lists: LX.List.MyListInfo[]) {
    this.emit('mylistUpdated', lists)
  }

  /**
   * 音乐信息切换
   */
  musicToggled() {
    this.emit('musicToggled')
  }

  /**
   * 手动改变进度
   * @param progress 进度
   */
  setProgress(progress: number, maxPlayTime?: number) {
    this.emit('setProgress', progress, maxPlayTime)
  }

  /**
   * 设置音量大小
   * @param volume 音量大小
   */
  setVolume(volume: number) {
    this.emit('setVolume', volume)
  }

  /**
   * 设置是否静音
   * @param isMute 是否静音
   */
  setVolumeIsMute(isMute: boolean) {
    this.emit('setVolumeIsMute', isMute)
  }

  // 播放器事件
  play() {
    this.emit('play')
  }

  pause() {
    this.emit('pause')
  }

  stop() {
    this.emit('stop')
  }

  error() {
    this.emit('error')
  }

  // 播放器原始事件
  playerPlaying() {
    this.emit('playerPlaying')
  }

  playerPause() {
    this.emit('playerPause')
  }

  // playerStop() {
  //   this.emit('playerStop')
  // }

  playerEnded() {
    this.emit('playerEnded')
  }

  playerError() {
    this.emit('playerError')
  }

  // playerLoadeddata() {
  //   this.emit('playerLoadeddata')
  // }

  playerLoadstart() {
    this.emit('playerLoadstart')
  }

  // playerCanplay() {
  //   this.emit('playerCanplay')
  // }

  playerEmptied() {
    this.emit('playerEmptied')
  }

  playerWaiting() {
    this.emit('playerWaiting')
  }


  // 更新图片事件
  picUpdated() {
    this.emit('picUpdated')
  }

  // 更新歌词事件
  lyricUpdated() {
    this.emit('lyricUpdated')
  }

  // 更新歌词偏移
  lyricOffsetUpdate() {
    this.emit('lyricOffsetUpdate')
  }

  // 我的列表内歌曲改变事件
  myListMusicUpdate(ids: string[]) {
    if (!ids.length) return
    this.emit('myListMusicUpdate', ids)
  }

  // 下载列表改变事件
  downloadListUpdate() {
    this.emit('downloadListUpdate')
  }

  downloadTaskUpdate(task: LX.Download.DownloadListItem) {
    this.emit('downloadTaskUpdate', task)
  }

  downloadCountUpdate(count: number) {
    this.emit('downloadCountUpdate', count)
  }

  playQueueUpdate(queue: LX.Player.PlayQueueItem[]) {
    this.emit('playQueueUpdate', queue)
  }

  playHistoryUpdate(history: LX.Player.PlayHistoryItem[]) {
    this.emit('playHistoryUpdate', history)
  }

  qqMusicAccountUpdated(user: LX.QQMusic.UserInfo | null) {
    this.emit('qqMusicAccountUpdated', user)
  }

  // 「我喜欢」的本地状态集合变了（收藏/取消收藏后，或重新拉取后）
  qqMusicLikedUpdated() {
    this.emit('qqMusicLikedUpdated')
  }

  // 「我的歌单」那份缓存被就地改过（收藏/取消收藏一个歌单）。
  // 常驻挂载的「我的」页据此重读一遍，不然要等重新进页面或下拉刷新才更新
  qqMusicPlaylistsUpdated() {
    this.emit('qqMusicPlaylistsUpdated')
  }

  // 列表里的音乐信息改变事件
  musicInfoUpdate(musicInfo: LX.Music.MusicInfo) {
    this.emit('musicInfoUpdate', musicInfo)
  }

  /**
   * 搜索类型改变事件
   * @param type
   */
  searchTypeChanged(type: SearchType) {
    this.emit('searchTypeChanged', type)
  }
}


type EventMethods = Omit<EventType, keyof Event>


declare class EventType extends AppEvent {
  on<K extends keyof EventMethods>(event: K, listener: EventMethods[K]): any
  off<K extends keyof EventMethods>(event: K, listener: EventMethods[K]): any
}

export type AppEventTypes = Omit<EventType, keyof Omit<Event, 'on' | 'off'>>
export const createAppEventHub = (): AppEventTypes => {
  return new AppEvent()
}
