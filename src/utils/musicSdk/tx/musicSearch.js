import { formatPlayTime, sizeFormate } from '../../index'
import { formatSingerName } from '../utils'
import { comm, signRequest } from './utils'

// 接口出错（多为被限流）时重试的间隔，避免连着打好几次
const retryDelay = 500

/** 搜索结果里歌曲所在的 tab：0 单曲、1 歌手、2 专辑、3 歌单、4 MV */
const SEARCH_TYPE_SONG = 0
const SEARCH_TYPE_SINGER = 1

export default {
  limit: 50,
  total: 0,
  page: 0,
  allPage: 1,
  successCode: 0,
  /** 服务端表示“没有搜索结果”（见 searchSingerRequest） */
  noResultCode: 2001,
  musicSearch(str, page, limit, retryNum = 0) {
    if (retryNum > 5) return Promise.reject(new Error('搜索失败'))
    const searchRequest = signRequest({
      comm,
      'music.search.SearchCgiService': {
        module: 'music.search.SearchCgiService',
        method: 'DoSearchForQQMusicDesktop',
        param: {
          grp: 1,
          num_per_page: limit,
          page_num: page,
          query: str,
          remoteplace: 'txt.newclient.top',
          search_type: SEARCH_TYPE_SONG,
          searchid: this.getSearchId(),
        },
      },
    })
    return searchRequest.then(({ body }) => {
      // console.log(body)
      const req = body?.['music.search.SearchCgiService'] ?? body?.req
      if (!req || body.code != this.successCode || req.code != this.successCode) {
        return this.musicSearch(str, page, limit, ++retryNum)
      }
      return req.data
    })
  },
  searchSingerRequest(str, page, limit, retryNum = 0) {
    if (retryNum > 3) return Promise.reject(new Error('搜索失败'))
    const searchRequest = signRequest({
      comm,
      'music.search.SearchCgiService': {
        module: 'music.search.SearchCgiService',
        method: 'DoSearchForQQMusicDesktop',
        param: {
          grp: 1,
          num_per_page: limit,
          page_num: page,
          query: str,
          remoteplace: 'txt.newclient.top',
          search_type: SEARCH_TYPE_SINGER,
          searchid: this.getSearchId(),
        },
      },
    })
    return searchRequest.then(({ body }) => {
      const req = body?.['music.search.SearchCgiService'] ?? body?.req
      // 2001 是“这个关键词没有结果”，不是出错：重试也还是同样的结果，
      // 当成空列表返回就好，否则搜不到东西会显示成“加载失败”
      if (req?.code == this.noResultCode) return { body: { singer: { list: [] } }, meta: { sum: 0 } }
      if (!req || body.code != this.successCode || req.code != this.successCode) {
        // 失败多半是被限流，等一下再试，别连着打
        return new Promise(resolve => { setTimeout(resolve, retryDelay) })
          .then(() => this.searchSingerRequest(str, page, limit, ++retryNum))
      }
      return req.data
    })
  },
  /**
   * 搜索歌手。注意歌手页每页最多只能要 20 条左右，
   * 请求 50 条时服务端会返回 code 0 但列表为空（不是限流）。
   */
  searchSinger(str, page = 1, limit = 20) {
    // 和 musicSearch 一样，这里拿到的是 { body, meta }，歌手在 body.singer.list 里，
    // 总数在 meta.sum 上（body.singer 自己没有 total 字段）
    return this.searchSingerRequest(str, page, limit).then(({ body, meta }) => {
      const rawList = body?.singer?.list ?? []
      const list = rawList.map(item => {
        const mid = item.singerMID ?? ''
        return {
          id: item.singerID ?? mid,
          mid,
          name: item.singerName ?? '',
          // 接口给的是 http 带缩略图后缀的地址，统一换成 https 的原图
          picUrl: mid ? `https://y.gtimg.cn/music/photo_new/T001R500x500M000${mid}.jpg` : '',
          albumSize: item.albumNum ?? 0,
          songSize: item.songNum ?? 0,
          source: 'tx',
        }
      }).filter(item => item.name)
      const total = meta?.sum ?? list.length
      return { list, total, allPage: Math.ceil(total / limit), limit, source: 'tx' }
    })
  },
  /**
   * PC 客户端版 searchid：32 位大写十六进制 GUID + 5 位补零随机数 = 37 字符。
   * 对应 QQ 音乐 PC 端 searchid 形状（服务端只需要唯一的会话 ID，形状一致即可）。
   */
  getSearchId() {
    let guid = ''
    for (let i = 0; i < 32; i++) guid += Math.floor(Math.random() * 16).toString(16)
    return guid.toUpperCase() + String(Math.floor(Math.random() * 100000)).padStart(5, '0')
  },
  handleResult(rawList) {
    // console.log(rawList)
    if (!rawList || !Array.isArray(rawList)) return []
    const list = []
    rawList.forEach(item => {
      if (!item.file?.media_mid) return

      let types = []
      let _types = {}
      const file = item.file
      if (file.size_128mp3 != 0) {
        let size = sizeFormate(file.size_128mp3)
        types.push({ type: '128k', size })
        _types['128k'] = {
          size,
        }
      }
      if (file.size_320mp3 !== 0) {
        let size = sizeFormate(file.size_320mp3)
        types.push({ type: '320k', size })
        _types['320k'] = {
          size,
        }
      }
      if (file.size_flac !== 0) {
        let size = sizeFormate(file.size_flac)
        types.push({ type: 'flac', size })
        _types.flac = {
          size,
        }
      }
      if (file.size_hires !== 0) {
        let size = sizeFormate(file.size_hires)
        types.push({ type: 'flac24bit', size })
        _types.flac24bit = {
          size,
        }
      }
      // types.reverse()
      let albumId = ''
      let albumName = ''
      if (item.album) {
        albumName = item.album.name
        albumId = item.album.mid
      }
      list.push({
        singer: formatSingerName(item.singer, 'name'),
        // name: item.name + (item.title_extra ?? ''),
        name: item.title,
        albumName,
        albumId,
        source: 'tx',
        interval: item.interval ? formatPlayTime(item.interval) : null,
        songId: item.id,
        albumMid: item.album?.mid ?? '',
        strMediaMid: item.file.media_mid,
        songmid: item.mid,
        img: (albumId === '' || albumId === '空')
          ? item.singer?.length ? `https://y.gtimg.cn/music/photo_new/T001R500x500M000${item.singer[0].mid}.jpg` : ''
          : `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumId}.jpg`,
        types,
        _types,
        typeUrl: {},
      })
    })
    // console.log(list)
    return list
  },
  search(str, page = 1, limit) {
    if (limit == null) limit = this.limit
    // http://newlyric.kuwo.cn/newlyric.lrc?62355680
    return this.musicSearch(str, page, limit).then(({ body, meta }) => {
      let list = this.handleResult(body.song.list)

      this.total = meta.sum
      this.page = page
      this.allPage = Math.ceil(this.total / limit)

      return Promise.resolve({
        list,
        allPage: this.allPage,
        limit,
        total: this.total,
        source: 'tx',
      })
    })
  },
}
