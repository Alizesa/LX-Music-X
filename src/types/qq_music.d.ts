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
      /**
       * 「我喜欢」这类虚拟歌单。它们的 id 被归一化成 dirid(201)，
       * 只有走 CgiGetDiss 的取歌路径能处理，通用的歌单详情接口无法打开。
       */
      liked?: boolean
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

    /**
     * 每日推荐的播放存档：切到别的歌单时，播放队列会被整条替换掉
     * （play_queue 只有一个槽），所以切走前把推荐队列和播放位置存下来，
     * 下次点「每日推荐」能接着播，而不是从缓存那 20 首的第一首重来。
     */
    interface RecommendSession {
      /** 推荐队列，含播放过程中自动续上的那几批 */
      songs: LX.Player.PlayMusic[]
      /** 切走时正在播的那首在队列里的位置 */
      index: number
      /** 存档时间，用来判断是否跨天（跨天就不再续，推荐内容本来就该换新） */
      savedAt: number
    }
  }
}
