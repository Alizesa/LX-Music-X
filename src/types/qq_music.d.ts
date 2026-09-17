declare namespace LX {
  namespace QQMusic {
    interface UserInfo {
      uin: string
      nickname: string
      avatar?: string
    }

    interface PlaylistInfo {
      id: string
      name: string
      cover?: string
      description?: string
      trackCount?: number
      /** true 表示收藏歌单，false 表示自建歌单 */
      subscribed?: boolean
    }
  }
}
