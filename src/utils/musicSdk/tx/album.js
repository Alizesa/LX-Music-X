import { musicuRequest } from './utils'
import musicSearch from './musicSearch'

export default {
  /**
   * 专辑歌曲
   * @param mid 专辑 mid
   * @param page 页数
   * @param limit 每页条数
   */
  getSongs(mid, page = 1, limit = 30) {
    return musicuRequest([{
      module: 'music.musichallAlbum.AlbumSongList',
      method: 'GetAlbumSongList',
      param: {
        albumMid: mid,
        begin: (page - 1) * limit,
        num: limit,
      },
    }]).then(([data]) => {
      // 歌曲被包了一层 songInfo，结构和搜索结果一致
      const list = musicSearch.handleResult((data?.songList ?? []).map(item => item.songInfo))
      const total = data?.totalNum ?? list.length
      return { list, total, allPage: Math.ceil(total / limit), limit, source: 'tx' }
    })
  },
}
