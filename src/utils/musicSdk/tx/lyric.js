import { decode as decodeEntities } from 'he'
import { QQ_LYRIC_CACHE_VERSION } from '@/config/constant'
import { httpFetch } from '../../request'
import { requestMsg } from '../../message'
import { decodeQrc } from './qrcDecode'

// 同一接口可能返回 QRC 密文、Base64 或明文，crypt=0 时也可能仍有 QRC 密文。
const decodeLyricText = async(raw) => {
  if (typeof raw != 'string') return ''
  const text = raw.trim()
  if (!text) return ''
  if (text.includes('[') || text.includes('LyricContent=')) return text
  if (/^[\da-f]+$/i.test(text) && text.length % 16 === 0) {
    const decoded = await decodeQrc(text)
    if (decoded) return decoded
  }
  return Buffer.from(text, 'base64').toString('utf8')
}

export const decodeLyric = async(lrc, tlrc, rlrc) => {
  const [lyric, tlyric, rlyric] = await Promise.all([lrc, tlrc, rlrc].map(decodeLyricText))
  return { lyric, tlyric, rlyric }
}

const parseTools = {
  rxps: {
    lineTime: /^\[(\d+),\d+\]/,
    lrcTimes: /\[(\d+:\d{2}(?:[.:]\d{1,3})?)\]/g,
    wordTime: /\(\d+,\d+\)/,
    wordTimeAll: /(\(\d+,\d+\))/g,
  },
  msFormat(timeMs) {
    if (!Number.isFinite(timeMs)) return ''
    const ms = timeMs % 1000
    const m = Math.floor(timeMs / 60000).toString().padStart(2, '0')
    const s = Math.floor(timeMs / 1000 % 60).toString().padStart(2, '0')
    return `[${m}:${s}.${String(ms).padStart(3, '0')}]`
  },
  getIntv(interval) {
    const result = /^(\d+):(\d{2})(?:[.:](\d{1,3}))?$/.exec(interval)
    if (!result) return NaN
    return (Number(result[1]) * 60 + Number(result[2])) * 1000 + Number((result[3] ?? '').padEnd(3, '0'))
  },
  parseLrc(lrc) {
    const lines = []
    for (const line of lrc.split('\n')) {
      const text = line.replace(this.rxps.lrcTimes, '').trim()
      for (const match of line.matchAll(this.rxps.lrcTimes)) {
        const time = this.getIntv(match[1])
        if (Number.isFinite(time)) lines.push({ time, text })
      }
    }
    return lines.sort((a, b) => a.time - b.time)
  },
  parseLyric(lrc) {
    const lxlrcLines = []
    const lrcLines = []
    for (let line of lrc.replace(/\r/g, '').split('\n')) {
      line = line.trim()
      const result = this.rxps.lineTime.exec(line)
      if (!result) {
        if (line.startsWith('[offset')) {
          lxlrcLines.push(line)
          lrcLines.push(line)
        }
        for (const { time, text } of this.parseLrc(line)) lrcLines.push(`${this.msFormat(time)}${text}`)
        continue
      }

      const startMsTime = Number(result[1])
      const startTimeStr = this.msFormat(startMsTime)
      if (!startTimeStr) continue
      const words = line.replace(this.rxps.lineTime, '')
      lrcLines.push(`${startTimeStr}${words.replace(this.rxps.wordTimeAll, '')}`)

      let times = words.match(this.rxps.wordTimeAll)
      if (!times) continue
      times = times.map(time => {
        const result = /\((\d+),(\d+)\)/.exec(time)
        return `<${Math.max(Number(result[1]) - startMsTime, 0)},${result[2]}>`
      })
      const wordArr = words.split(this.rxps.wordTime)
      const newWords = times.map((time, index) => `${time}${wordArr[index]}`).join('')
      lxlrcLines.push(`${startTimeStr}${newWords}`)
    }
    return {
      lyric: lrcLines.join('\n'),
      lxlyric: lxlrcLines.join('\n'),
    }
  },
  removeTag(str) {
    return decodeEntities(str.replace(/^[\S\s]*?LyricContent="/, '').replace(/"\s*\/>[\S\s]*$/, ''))
  },
  fixExtendedLyricTimeTags(extended, original) {
    const translated = this.parseLrc(extended).filter(line => line.text && !/^\/+$/u.test(line.text))
    if (!translated.length) return ''
    const lines = []
    // 与 MusicOne 一样，逐行找 600ms 内最近的翻译。找不到就跳过该行，
    // 不能用 shift 耗尽整份原歌词，否则一个无对应行的前奏/署名就会吞掉后面的翻译。
    for (const line of this.parseLrc(original)) {
      if (!line.text) continue
      let nearest = null
      let distance = 601
      for (const candidate of translated) {
        const delta = Math.abs(candidate.time - line.time)
        if (delta < distance) {
          nearest = candidate
          distance = delta
        }
      }
      if (nearest && nearest.text !== line.text) lines.push(`${this.msFormat(line.time)}${nearest.text}`)
    }
    return lines.join('\n')
  },
  parse(lrc, tlrc, rlrc) {
    const info = {
      lyric: '',
      tlyric: '',
      rlyric: '',
      lxlyric: '',
      qqLyricVersion: QQ_LYRIC_CACHE_VERSION,
    }
    if (lrc) Object.assign(info, this.parseLyric(this.removeTag(lrc)))
    if (tlrc) info.tlyric = this.fixExtendedLyricTimeTags(this.parseLyric(this.removeTag(tlrc)).lyric, info.lyric)
    if (rlrc) info.rlyric = this.fixExtendedLyricTimeTags(this.parseLyric(this.removeTag(rlrc)).lyric, info.lyric)
    return info
  },
}

const LYRIC_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
const WEB_LYRIC_URL = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg'
const LYRIC_HEADERS = {
  Referer: 'https://y.qq.com/portal/player.html',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
}

export default {
  async parseLyric(lrc, tlrc, rlrc) {
    const { lyric, tlyric, rlyric } = await decodeLyric(lrc, tlrc, rlrc)
    return parseTools.parse(lyric, tlyric, rlyric)
  },
  getLyric(mInfo) {
    let cancelled = false
    let pendingRequest = null
    const throwIfCancelled = () => {
      if (cancelled) throw new Error(requestMsg.cancelRequest)
    }
    const request = async(url, options = {}) => {
      throwIfCancelled()
      pendingRequest = httpFetch(url, { ...options, headers: LYRIC_HEADERS })
      const { body, statusCode } = await pendingRequest.promise
      throwIfCancelled()
      if (statusCode < 200 || statusCode >= 300) throw new Error(`QQ lyric HTTP ${statusCode}`)
      return body
    }

    return {
      cancelHttp() {
        cancelled = true
        pendingRequest?.cancelHttp()
      },
      promise: (async() => {
        const songmid = String(mInfo?.songmid ?? '')
        const id = Number(mInfo?.songId)
        const songId = Number.isSafeInteger(id) && id > 0 ? id : 0
        if (!songmid && !songId) throw new Error('Get lyric failed: missing song ID')
        try {
          // MusicOne 使用的新歌词参数；同时请求罗马音以保留本项目的显示选项。
          // songMID 可以独立定位歌曲，缺少数字 ID 时无需先请求歌曲详情。
          const body = await request(LYRIC_URL, {
            method: 'post',
            body: {
              comm: { ct: 19, cv: 0, tmeAppID: 'qqmusiclight' },
              req: {
                method: 'GetPlayLyricInfo',
                module: 'music.musichallSong.PlayLyricInfo',
                param: { songMID: songmid, songID: songId, platform: 0, needNew: 1, crypt: 0, qrc: 1, roma: 1, trans: 1 },
              },
            },
          })
          if (body?.code !== 0 || body.req?.code !== 0) throw new Error('Get lyric failed')
          const data = body.req.data
          const info = await this.parseLyric(data?.lyric || data?.qrc, data?.trans, data?.roma)
          throwIfCancelled()
          if (/\[\d+:\d{2}\.\d{3}\]/.test(info.lyric)) return info
        } catch (error) {
          throwIfCancelled()
          if (!songmid) throw error
        }

        // 主接口失败或没有歌词时再走网页接口；正常无翻译的歌曲无需多发一次请求。
        if (!songmid) throw new Error('Get lyric failed')
        const body = await request(`${WEB_LYRIC_URL}?songmid=${encodeURIComponent(songmid)}&format=json&nobase64=1`)
        if (body?.code !== 0) throw new Error('Get lyric failed')
        const info = await this.parseLyric(body.lyric, body.trans, body.roma)
        throwIfCancelled()
        if (!/\[\d+:\d{2}\.\d{3}\]/.test(info.lyric)) throw new Error('Get lyric failed')
        // 网页接口的内容可能缺翻译/逐字时间，只作临时缓存；下次加载仍可重试主接口。
        return { ...info, qqLyricVersion: 0 }
      })().catch(error => {
        throwIfCancelled()
        throw error
      }),
    }
  },
}
