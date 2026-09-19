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
      /** 歌单创建者昵称，推荐流里会带上 */
      author?: string
    }

    /**
     * 推荐歌单的本地缓存。推荐流是分页的，所以除了已取到的列表，
     * 还要记住下一页的游标，避免每次进页面都从头请求。
     * 游标取尽后会回到 0，所以不需要额外记「是否还有更多」。
     */
    interface RecommendPlaylistCache {
      list: PlaylistInfo[]
      /** 下一次刷新从哪个 From 开始取 */
      nextFrom: number
    }
  }
}
