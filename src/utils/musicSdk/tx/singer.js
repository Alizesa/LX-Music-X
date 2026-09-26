import { musicuRequest } from './utils'
import musicSearch from './musicSearch'

// 歌手页的“热门歌曲”上限，接口一次最多给这么多，且不支持翻页
const HOT_SONG_LIMIT = 50

export default {
  /**
   * 歌手信息 + 简介 + 热门歌曲。这三块在同一个接口里，一次请求就能全拿到，
   * 所以歌手详情页打开时只发一条请求。
   * @param mid 歌手 mid
   */
  getDetail(mid) {
    return musicuRequest([{
      module: 'music.web_singer_info_svr',
      method: 'get_singer_detail_info',
      param: {
        singermid: mid,
        num: HOT_SONG_LIMIT,
        page: 1,
      },
    }]).then(([data]) => {
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
        // 歌曲结构和搜索接口里的一致，直接复用搜索结果的处理
        songs: musicSearch.handleResult(data?.songlist),
      }
    })
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
