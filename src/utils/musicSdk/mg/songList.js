import { httpFetch } from '../../request'
import { formatPlayCount } from '../../index'
import { filterMusicInfoListV5 } from './musicInfo'
import { createSignature } from './musicSearch'
import { createHttpFetch } from './utils/index'


export default {
  limit_song: 30,
  successCode: '000000',
  cachedDetailInfo: {},
  cachedUrl: {},
  regExps: {

    // https://music.migu.cn/v3/music/playlist/161044573?page=1
    listDetailLink: /^.+\/playlist\/(\d+)(?:\?.*|&.*$|#.*$|$)/,
  },
  getSongListDetailUrl(id, page) {
    return `https://app.c.nf.migu.cn/MIGUM3.0/resource/playlist/song/v2.0?pageNo=${page}&pageSize=${this.limit_song}&playlistId=${id}`
    // return `https://app.c.nf.migu.cn/MIGUM2.0/v1.0/user/queryMusicListSongs.do?musicListId=${id}&pageNo=${page}&pageSize=${this.limit_song}`
  },
  defaultHeaders: {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1',
    Referer: 'https://m.music.migu.cn/',
    // language: 'Chinese',
    // ua: 'Android_migu',
    // mode: 'android',
    // version: '6.8.5',
  },

  getListDetailList(id, page, tryNum = 0) {
    if (tryNum > 2) return Promise.reject(new Error('try max num'))
    // https://h5.nf.migu.cn/app/v4/p/share/playlist/index.html?id=184187437&channel=0146921

    // if (/playlist\/index\.html\?/.test(id)) {
    //   id = id.replace(/.*(?:\?|&)id=(\d+)(?:&.*|$)/, '$1')
    // } else if ((/[?&:/]/.test(id))) id = id.replace(this.regExps.listDetailLink, '$1')

    const requestObj_listDetail = httpFetch(this.getSongListDetailUrl(id, page), { headers: this.defaultHeaders })
    return requestObj_listDetail.promise.then(({ body }) => {
      if (body.code !== this.successCode) return this.getListDetailList(id, page, ++tryNum)
      // console.log(JSON.stringify(body))
      // console.log(body)
      return {
        list: filterMusicInfoListV5(body.data.songList),
        page,
        limit: this.limit_song,
        total: body.data.totalCount,
        source: 'mg',
      }
    })
  },

  getListDetailInfo(id, tryNum = 0) {
    if (tryNum > 2) return Promise.reject(new Error('try max num'))

    if (this.cachedDetailInfo[id]) return Promise.resolve(this.cachedDetailInfo[id])
    const requestObj_listDetailInfo = httpFetch(`https://c.musicapp.migu.cn/MIGUM3.0/resource/playlist/v2.0?playlistId=${id}`, {
      headers: this.defaultHeaders,
    })
    return requestObj_listDetailInfo.promise.then(({ body }) => {
      if (body.code !== this.successCode) return this.getListDetail(id, ++tryNum)
      // console.log(JSON.stringify(body))
      // console.log(body)
      const cachedDetailInfo = this.cachedDetailInfo[id] = {
        name: body.data.title,
        img: body.data.imgItem.img,
        desc: body.data.summary,
        author: body.data.ownerName,
        play_count: formatPlayCount(body.data.opNumItem.playNum),
      }
      return cachedDetailInfo
    })
  },

  async getDetailUrl(link, page, retryNum = 0) {
    if (retryNum > 3) return Promise.reject(new Error('link try max num'))

    const requestObj_listDetailLink = httpFetch(link, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Version/9.0 Mobile/13B143 Safari/601.1',
        Referer: link,
      },
    })
    const { url: location, statusCode } = await requestObj_listDetailLink.promise
    // console.log(body, location)
    if (statusCode > 400) return this.getDetailUrl(link, page, ++retryNum)
    if (location.split('?')[0] != link.split('?')[0]) {
      this.cachedUrl[link] = location
      return this.getListDetail(location, page)
    }
    return Promise.reject(new Error('link get failed'))
  },

  getListDetail(id, page, retryNum = 0) { // 获取歌曲列表内的音乐
    // https://h5.nf.migu.cn/app/v4/p/share/playlist/index.html?id=184187437&channel=0146921
    // http://c.migu.cn/00bTY6?ifrom=babddaadfde4ebeda289d671ab62f236
    // https://music.migu.cn/v5/#/playlist?playlistId=221573417
    if (/\/playlist[/?]/.test(id)) {
      id = /(?:playlistId|id)=(\d+)/.exec(id)?.[1]
      if (!id) throw new Error('list detail id parse failed')
    } else if (this.regExps.listDetailLink.test(id)) {
      id = id.replace(this.regExps.listDetailLink, '$1')
    } else if ((/[?&:/]/.test(id))) {
      const url = this.cachedUrl[id]
      return url ? this.getListDetail(url, page) : this.getDetailUrl(id, page)
    }

    return Promise.all([
      this.getListDetailList(id, page, retryNum),
      this.getListDetailInfo(id, retryNum),
    ]).then(([listData, info]) => {
      listData.info = info
      return listData
    })
  },

  getDetailPageUrl(id) {
    if (/playlist\/index\.html\?/.test(id)) {
      id = id.replace(/.*(?:\?|&)id=(\d+)(?:&.*|$)/, '$1')
    } else if (this.regExps.listDetailLink.test(id)) {
      id = id.replace(this.regExps.listDetailLink, '$1')
    }
    return `https://music.migu.cn/v3/music/playlist/${id}`
  },

  filterSongListResult(raw) {
    const list = []
    raw.forEach(item => {
      if (!item.id) return

      const playCount = parseInt(item.playNum)
      list.push({
        play_count: isNaN(playCount) ? 0 : formatPlayCount(playCount),
        id: item.id,
        author: item.userName,
        name: item.name,
        img: item.musicListPicUrl,
        total: item.musicNum,
        source: 'mg',
      })
    })
    return list
  },
  search(text, page, limit = 20) {
    const timeStr = Date.now().toString()
    const signResult = createSignature(timeStr, text)
    return createHttpFetch(`https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=1&isCopyright=1&searchSwitch=%7B%22song%22%3A0%2C%22album%22%3A0%2C%22singer%22%3A0%2C%22tagSong%22%3A0%2C%22mvSong%22%3A0%2C%22bestShow%22%3A0%2C%22songlist%22%3A1%2C%22lyricSong%22%3A0%7D&pageSize=${limit}&text=${encodeURIComponent(text)}&pageNo=${page}&sort=0&sid=USS`, {
      headers: {
        uiVersion: 'A_music_3.6.1',
        deviceId: signResult.deviceId,
        timestamp: timeStr,
        sign: signResult.sign,
        channel: '0146921',
        'User-Agent': 'Mozilla/5.0 (Linux; U; Android 11.0.0; zh-cn; MI 11 Build/OPR1.170623.032) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30',
      },
    }).then(body => {
      if (!body.songListResultData) throw new Error('get song list faild.')

      const list = this.filterSongListResult(body.songListResultData.result)
      return {
        list,
        limit,
        total: parseInt(body.songListResultData.totalCount),
        source: 'mg',
      }
    })
  },
}
