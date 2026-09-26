import { musicuRequest } from './utils'
import musicSearch from './musicSearch'

// 这个接口不像搜索接口那样限制每页条数，50 实测可用
const SONG_PAGE_SIZE = 50

export default {
  /**
   * 歌手歌曲。翻页靠 sin（偏移量），**不是 page**：
   * 传 page 服务端不认，每页都返回同样的第一页；sin 能一直翻到 total_song 首的全部曲库。
   * @param sin 从第几首开始
   * @param num 要几首
   */
  requestSongs(mid, sin, num) {
    return musicuRequest([{
      module: 'music.web_singer_info_svr',
      method: 'get_singer_detail_info',
      param: {
        singermid: mid,
        // 5 = 按热度排序，和 QQ 客户端歌手页的默认顺序一致
        sort: 5,
        sin,
        num,
      },
    }]).then(([data]) => data)
  },
  handleSongs(data, limit) {
    // 歌曲结构和搜索接口里的一致，直接复用搜索结果的处理
    const list = musicSearch.handleResult(data?.songlist)
    // 翻过头之后 total_song 会变成 0，所以只有拿到结果时才更新总数
    const total = data?.total_song ?? 0
    return { list, total, allPage: Math.ceil(total / limit), limit, source: 'tx' }
  },
  /**
   * 歌手信息 + 简介 + 第一页歌曲。这三块在同一个接口里，一次请求就能全拿到，
   * 所以歌手详情页打开时只发一条请求。
   * @param mid 歌手 mid
   */
  getDetail(mid, limit = SONG_PAGE_SIZE) {
    return this.requestSongs(mid, 0, limit).then(data => {
      const singerInfo = data?.singer_info ?? {}
      return {
        source: 'tx',
        mid: singerInfo.mid ?? mid,
        info: {
          id: String(singerInfo.id ?? ''),
          mid: singerInfo.mid ?? mid,
          name: singerInfo.name ?? '',
          otherName: singerInfo.other_name ?? '',
          fans: singerInfo.fans ?? 0,
          // 简介是纯字符串，不是对象
          brief: typeof data?.singer_brief == 'string' ? data.singer_brief : '',
          totalSong: data?.total_song ?? 0,
          totalAlbum: data?.total_album ?? 0,
          totalMv: data?.total_mv ?? 0,
        },
        songs: this.handleSongs(data, limit),
      }
    })
  },
  /**
   * 歌手歌曲的后续页（第一页在 getDetail 里一起拿）
   * @param page 页数，从 1 开始
   */
  getSongs(mid, page = 1, limit = SONG_PAGE_SIZE) {
    return this.requestSongs(mid, (page - 1) * limit, limit)
      .then(data => this.handleSongs(data, limit))
  },
  /**
   * 歌手专辑列表
   * @param mid 歌手 mid
   * @param page 页数
   * @param limit 每页条数
   */
  getAlbums(mid, page = 1, limit = 20) {
    return musicuRequest([{
      module: 'music.musichallAlbum.AlbumListServer',
      method: 'GetAlbumList',
      param: {
        singerMid: mid,
        begin: (page - 1) * limit,
        num: limit,
        // 2 = 按发行时间倒序，新专辑在前
        order: 2,
        orderType: 0,
      },
    }]).then(([data]) => {
      const list = (data?.albumList ?? []).map(item => ({
        id: item.albumMid,
        mid: item.albumMid,
        name: item.albumName ?? '',
        author: item.singerName ?? '',
        img: item.albumMid ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${item.albumMid}.jpg` : '',
        publishDate: item.publishDate ?? '',
        albumType: item.albumType ?? '',
        source: 'tx',
      })).filter(item => item.id)
      const total = data?.total ?? list.length
      return { list, total, allPage: Math.ceil(total / limit), limit, source: 'tx' }
    })
  },
}
