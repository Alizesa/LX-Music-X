import { waitForRequest } from '../../abortable'
import { httpFetch } from '../../request'
import { weapi } from './utils/crypto'
import { dateFormat2 } from '../../index'

const emojis = [
  ['大笑', '😃'],
  ['可爱', '😊'],
  ['憨笑', '☺️'],
  ['色', '😍'],
  ['亲亲', '😙'],
  ['惊恐', '😱'],
  ['流泪', '😭'],
  ['亲', '😚'],
  ['呆', '😳'],
  ['哀伤', '😔'],
  ['呲牙', '😁'],
  ['吐舌', '😝'],
  ['撇嘴', '😒'],
  ['怒', '😡'],
  ['奸笑', '😏'],
  ['汗', '😓'],
  ['痛苦', '😖'],
  ['惶恐', '😰'],
  ['生病', '😨'],
  ['口罩', '😷'],
  ['大哭', '😂'],
  ['晕', '😵'],
  ['发怒', '👿'],
  ['开心', '😄'],
  ['鬼脸', '😜'],
  ['皱眉', '😞'],
  ['流感', '😢'],
  ['爱心', '❤️'],
  ['心碎', '💔'],
  ['钟情', '💘'],
  ['星星', '⭐️'],
  ['生气', '💢'],
  ['便便', '💩'],
  ['强', '👍'],
  ['弱', '👎'],
  ['拜', '🙏'],
  ['牵手', '👫'],
  ['跳舞', '👯‍♀️'],
  ['禁止', '🙅‍♀️'],
  ['这边', '💁‍♀️'],
  ['爱意', '💏'],
  ['示爱', '👩‍❤️‍👨'],
  ['嘴唇', '👄'],
  ['狗', '🐶'],
  ['猫', '🐱'],
  ['猪', '🐷'],
  ['兔子', '🐰'],
  ['小鸡', '🐤'],
  ['公鸡', '🐔'],
  ['幽灵', '👻'],
  ['圣诞', '🎅'],
  ['外星', '👽'],
  ['钻石', '💎'],
  ['礼物', '🎁'],
  ['男孩', '👦'],
  ['女孩', '👧'],
  ['蛋糕', '🎂'],
  ['18', '🔞'],
  ['圈', '⭕'],
  ['叉', '❌'],
]

const applyEmoji = text => {
  for (const e of emojis) text = text.replaceAll(`[${e[0]}]`, e[1])
  return text
}

const cursorCache = new Map()
const CURSOR_CACHE_MAX = 32
const CURSOR_CACHE_TTL = 15 * 60_000
const trimCursors = () => {
  for (const [key, value] of cursorCache) {
    if (!value.holders && Date.now() - value.savedAt >= CURSOR_CACHE_TTL) cursorCache.delete(key)
  }
  for (const [key, value] of cursorCache) {
    if (cursorCache.size <= CURSOR_CACHE_MAX) break
    if (!value.holders) cursorCache.delete(key)
  }
}
const getCursorRecord = (id, limit) => {
  const key = `${id}_${limit}`
  let value = cursorCache.get(key)
  if (value && !value.holders && Date.now() - value.savedAt >= CURSOR_CACHE_TTL) { cursorCache.delete(key); value = null }
  if (!value) value = { key, holders: 0, request: 0, savedAt: Date.now() }
  cursorCache.delete(key); cursorCache.set(key, value)
  return value
}
export const clearCommentCursorCache = () => {
  for (const [key, value] of cursorCache) if (!value.holders) cursorCache.delete(key)
}
const retainCursor = (id, limit = 15) => {
  const value = getCursorRecord(id, limit)
  value.holders++
  trimCursors()
  let released = false
  return () => {
    if (released) return
    released = true
    value.holders--
    if (!value.holders && cursorCache.get(value.key) === value) cursorCache.delete(value.key)
  }
}
const cursorTools = {
  getCursor(id, page, limit) {
    const cacheData = getCursorRecord(id, limit)
    const request = ++cacheData.request
    let orderType
    let cursor
    let offset
    if (page == 1 || !cacheData.page) {
      cursor = Date.now()
      orderType = 1
      // 游标已淘汰时按首屏锚点计算目标页，只请求目标页一次。
      offset = (page - 1) * limit
    } else if (cacheData.page) {
      cursor = cacheData.cursor
      if (page > cacheData.page) {
        orderType = 1
        offset = (page - cacheData.page - 1) * limit
      } else if (page < cacheData.page) {
        orderType = 0
        offset = (cacheData.page - page - 1) * limit
      } else {
        cursor = cacheData.prevCursor
        offset = cacheData.offset
        orderType = cacheData.orderType
      }
    }
    trimCursors()
    return {
      orderType,
      cursor,
      offset,
      record: cacheData,
      request,
    }
  },
  setCursor(info, cursor, orderType, offset, page) {
    const cacheData = info.record
    if (cursorCache.get(cacheData.key) !== cacheData || cacheData.request !== info.request) return
    cacheData.prevCursor = info.cursor
    cacheData.cursor = cursor
    cacheData.orderType = orderType
    cacheData.offset = offset
    cacheData.page = page
    cacheData.savedAt = Date.now()
    cursorCache.delete(cacheData.key); cursorCache.set(cacheData.key, cacheData)
    trimCursors()
  },
}

export default {
  retainCursor,
  async getComment({ songmid }, page = 1, limit = 20, signal) {
    const id = 'R_SO_4_' + songmid

    const cursorInfo = cursorTools.getCursor(songmid, page, limit)

    const _requestObj = httpFetch('https://music.163.com/weapi/comment/resource/comments/get', {
      method: 'post',
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36',
        origin: 'https://music.163.com',
        Refere: 'http://music.163.com/',
      },
      form: weapi({
        cursor: cursorInfo.cursor,
        offset: cursorInfo.offset,
        orderType: cursorInfo.orderType,
        pageNo: page,
        pageSize: limit,
        rid: id,
        threadId: id,
      }),
    })
    const { body, statusCode } = await waitForRequest(_requestObj, signal)
    if (statusCode != 200 || body.code !== 200) throw new Error('获取评论失败')
    cursorTools.setCursor(cursorInfo, body.data.cursor, cursorInfo.orderType, cursorInfo.offset, page)
    return { source: 'wy', comments: this.filterComment(body.data.comments), total: body.data.totalCount, page, limit, maxPage: Math.ceil(body.data.totalCount / limit) || 1 }
  },
  async getHotComment({ songmid }, page = 1, limit = 100, signal) {
    const id = 'R_SO_4_' + songmid

    const _requestObj2 = httpFetch(`https://music.163.com/weapi/v1/resource/hotcomments/${id}`, {
      method: 'post',
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36',
        origin: 'https://music.163.com',
        Refere: 'http://music.163.com/',
      },
      form: weapi({
        rid: id,
        limit,
        offset: limit * (page - 1),
        beforeTime: Date.now().toString(),
      }),
    })
    const { body, statusCode } = await waitForRequest(_requestObj2, signal)
    if (statusCode != 200 || body.code !== 200) throw new Error('获取热门评论失败')
    const total = body.total ?? 0
    return { source: 'wy', comments: this.filterComment(body.hotComments), total, page, limit, maxPage: Math.ceil(total / limit) || 1 }
  },
  filterComment(rawList) {
    return rawList.map(item => {
      let data = {
        id: item.commentId,
        text: item.content ? applyEmoji(item.content) : '',
        time: item.time ? item.time : '',
        timeStr: item.time ? dateFormat2(item.time) : '',
        location: item.ipLocation?.location,
        userName: item.user.nickname,
        avatar: item.user.avatarUrl,
        userId: item.user.userId,
        likedCount: item.likedCount,
        reply: [],
      }

      let replyData = item.beReplied && item.beReplied[0]
      return replyData
        ? {
            id: item.commentId,
            rootId: replyData.beRepliedCommentId,
            text: replyData.content ? applyEmoji(replyData.content) : '',
            time: item.time,
            timeStr: null,
            location: replyData.ipLocation?.location,
            userName: replyData.user.nickname,
            avatar: replyData.user.avatarUrl,
            userId: replyData.user.userId,
            likedCount: null,
            reply: [data],
          }
        : data
    })
  },
}
