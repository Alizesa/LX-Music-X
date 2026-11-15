const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load, deferred, flush } = require('./helpers/load.cjs')

const TTL = 15 * 60 * 1000
const clock = () => {
  let now = 1000
  return { Date: class extends Date { static now() { return now } }, advance: value => { now += value }, now: () => now }
}
const miguHarness = ({ summary = 'Description', handler } = {}) => {
  const time = clock(); const requests = []
  const reply = url => {
    const id = new URL(url).searchParams.get('playlistId') ?? url.split('/').at(-1)
    if (url.startsWith('https://short.test')) return { statusCode: 200, url: `https://h5.nf.migu.cn/app/share/playlist/index.html?id=${id}` }
    const body = url.includes('/playlist/song/')
      ? { code: '000000', data: { songList: [{ id: 'song-' + id }], totalCount: 1 } }
      : { code: '000000', data: { title: 'Playlist ' + id, imgItem: { img: 'cover-' + id }, summary, ownerName: 'Owner', opNumItem: { playNum: 1 } } }
    return { statusCode: 200, body, url }
  }
  const api = load('src/utils/musicSdk/mg/songList.js', {
    '../../request': { httpFetch: (url, options) => { requests.push({ url, options }); return { promise: handler?.(url, reply) ?? Promise.resolve(reply(url)) } } },
    '../../index': { formatPlayCount: String },
    './musicInfo': { filterMusicInfoListV5: value => value },
    './musicSearch': {},
    './utils/index': {},
  }, { Date: time.Date })
  return { ...api, requests, time }
}

test('Migu detail and redirect lookups stay bounded and a cached redirect only requests the new song page', async() => {
  const h = miguHarness()
  for (let i = 0; i < 64; i++) {
    const result = await h.default.getListDetail('https://short.test/' + i, 1)
    assert.equal(result.info.name, 'Playlist ' + i)
  }
  assert.equal(h.default.cachedDetailInfo.size, 16)
  assert.equal(h.default.cachedUrl.size, 32)
  const count = h.requests.length
  await h.default.getListDetail('https://short.test/63', 2)
  assert.equal(h.requests.length, count + 1)
  assert.match(h.requests.at(-1).url, /playlist\/song/)
  h.time.advance(TTL + 1)
  await h.default.getListDetail('https://short.test/63', 1)
  assert.equal(h.requests.length, count + 4)
})

test('Migu description storage has a character budget and oversized metadata is returned without retention', async() => {
  const h = miguHarness({ summary: 'x'.repeat(60000) })
  for (let i = 0; i < 16; i++) await h.default.getListDetailInfo(String(i))
  assert.ok([...h.default.cachedDetailInfo.values()].reduce((sum, value) => sum + value.desc.length, 0) <= 256 * 1024)
  const oversized = miguHarness({ summary: 'x'.repeat(300000) })
  assert.equal((await oversized.default.getListDetailInfo('large')).desc.length, 300000)
  assert.equal(oversized.default.cachedDetailInfo.size, 0)
})

for (const stage of ['metadata', 'redirect']) {
  test(`clearing Migu lookups while ${stage} is pending prevents the old chain from restoring either cache`, async() => {
    const gate = deferred(); let held = false
    const h = miguHarness({
      handler: (url, reply) => {
        if (!held && (stage === 'metadata' || url.startsWith('https://short.test'))) { held = true; return gate.promise.then(() => reply(url)) }
      },
    })
    const pending = stage === 'metadata' ? h.default.getListDetailInfo('1') : h.default.getListDetail('https://short.test/1', 1)
    await flush()
    h.clearMiguSongListCache()
    gate.resolve()
    await pending
    assert.equal(h.default.cachedDetailInfo.size, 0)
    assert.equal(h.default.cachedUrl.size, 0)
  })
}

test('Migu metadata failure retries only metadata and stops after three failed responses', async() => {
  const h = miguHarness({ handler: async() => ({ body: { code: 'bad-code' } }) })
  await assert.rejects(h.default.getListDetailInfo('1'), /try max num/)
  assert.equal(h.requests.length, 3)
  assert.ok(h.requests.every(request => request.url.includes('/resource/playlist/v2.0')))
})

const wyHarness = ({ handler } = {}) => {
  const time = clock(); const requests = []
  const reply = form => ({ statusCode: 200, body: { code: 200, data: { cursor: `cursor:${form.rid}:${form.pageNo}`, comments: [], totalCount: 1000 } } })
  const api = load('src/utils/musicSdk/wy/comment.js', {
    '../../abortable': load('src/utils/abortable.ts', { './message': load('src/utils/message.ts') }),
    '../../request': { httpFetch: (_url, { form }) => { requests.push(form); return { promise: handler?.(form, reply) ?? Promise.resolve(reply(form)), cancelHttp() {} } } },
    './utils/crypto': { weapi: value => value },
    '../../index': { dateFormat2: String },
  }, { Date: time.Date })
  return { ...api, requests, time }
}

test('NetEase cursor eviction and expiry address the requested page directly with one HTTP request', async() => {
  const h = wyHarness()
  for (let id = 0; id < 64; id++) await h.default.getComment({ songmid: id }, 1, 20)
  await h.default.getComment({ songmid: 0 }, 2, 20)
  assert.equal(h.requests.at(-1).cursor, h.time.now())
  assert.equal(h.requests.at(-1).offset, 20)
  await h.default.getComment({ songmid: 63 }, 2, 20)
  assert.equal(h.requests.at(-1).cursor, 'cursor:R_SO_4_63:1')
  const count = h.requests.length
  h.time.advance(TTL + 1)
  await h.default.getComment({ songmid: 63 }, 3, 20)
  assert.equal(h.requests.length, count + 1)
  assert.equal(h.requests.at(-1).cursor, h.time.now())
  assert.equal(h.requests.at(-1).offset, 40)
})

test('NetEase repeated, forward and backward pages keep their cursor anchors and different limits use independent records', async() => {
  const h = wyHarness()
  await h.default.getComment({ songmid: 1 }, 1, 20)
  await h.default.getComment({ songmid: 1 }, 3, 20)
  assert.equal(h.requests.at(-1).cursor, 'cursor:R_SO_4_1:1')
  assert.equal(h.requests.at(-1).offset, 20)
  await h.default.getComment({ songmid: 1 }, 3, 20)
  assert.equal(h.requests.at(-1).cursor, 'cursor:R_SO_4_1:1')
  assert.equal(h.requests.at(-1).offset, 20)
  await h.default.getComment({ songmid: 1 }, 2, 20)
  assert.equal(h.requests.at(-1).cursor, 'cursor:R_SO_4_1:3')
  assert.equal(h.requests.at(-1).orderType, 0)
  assert.equal(h.requests.at(-1).offset, 0)
  await h.default.getComment({ songmid: 1 }, 2, 15)
  assert.equal(h.requests.at(-1).cursor, h.time.now())
  assert.equal(h.requests.at(-1).offset, 15)
})

test('active NetEase cursor leases survive idle clearing and the last release removes their record', async() => {
  const h = wyHarness()
  const first = h.default.retainCursor(1, 20)
  const second = h.default.retainCursor(1, 20)
  await h.default.getComment({ songmid: 1 }, 1, 20)
  for (let id = 2; id < 64; id++) await h.default.getComment({ songmid: id }, 1, 20)
  h.clearCommentCursorCache(); h.time.advance(TTL + 1)
  first(); first()
  await h.default.getComment({ songmid: 1 }, 2, 20)
  assert.equal(h.requests.at(-1).cursor, 'cursor:R_SO_4_1:1')
  second()
  await h.default.getComment({ songmid: 1 }, 3, 20)
  assert.equal(h.requests.at(-1).cursor, h.time.now())
  assert.equal(h.requests.at(-1).offset, 40)
})

test('a cleared or superseded NetEase request cannot recreate a stale cursor record', async() => {
  const gate = deferred(); let held = false
  const h = wyHarness({
    handler: (form, reply) => {
      if (!held) { held = true; return gate.promise.then(() => reply(form)) }
    },
  })
  const pending = h.default.getComment({ songmid: 1 }, 1, 20)
  h.clearCommentCursorCache()
  await h.default.getComment({ songmid: 1 }, 1, 20)
  await h.default.getComment({ songmid: 1 }, 3, 20)
  gate.resolve(); await pending
  await h.default.getComment({ songmid: 1 }, 4, 20)
  assert.equal(h.requests.at(-1).cursor, 'cursor:R_SO_4_1:3')
  assert.equal(h.requests.at(-1).offset, 0)
})

test('the production comment controller pairs a NetEase cursor lease with disposal', async() => {
  const h = wyHarness()
  const utils = load('src/screens/Comment/utils.ts', {
    '@/utils': { toOldMusicInfo: value => ({ songmid: value.id }) }, '@/utils/musicSdk': { default: { wy: { comment: h.default } } },
  })
  const controller = load('src/screens/Comment/controller.ts', { './utils': utils }).createCommentController({ id: 1, source: 'wy' }, 'new', () => {}, () => {})
  await controller.refresh()
  h.clearCommentCursorCache()
  await controller.next()
  assert.equal(h.requests.at(-1).cursor, 'cursor:R_SO_4_1:1')
  controller.dispose(); controller.dispose()
  await h.default.getComment({ songmid: 1 }, 2, 15)
  assert.equal(h.requests.at(-1).cursor, h.time.now())
  assert.equal(h.requests.at(-1).offset, 15)
})
