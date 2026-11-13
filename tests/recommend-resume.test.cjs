const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load } = require('./helpers/load.cjs')

const song = id => ({ id, source: 'tx', name: id, singer: 'Artist', meta: { picUrl: `${id}-cover` } })
const songs = prefix => Array.from({ length: 20 }, (_, index) => song(`${prefix}-${index}`))
const constants = {
  LIST_IDS: { PLAY_QUEUE: 'play_queue', TEMP: 'temp' },
  QQ_DAILY_RECOMMEND_ID: 'recommend',
  QQ_DAILY_RECOMMEND_QUEUE_SOURCE: 'recommend_queue',
}

// Exercise the actual card refresh, queue metadata, archive I/O and resume logic.
// Only storage, the QQ response and playback execution are controlled here.
const harness = () => {
  let now = new Date(2026, 10, 12, 12).getTime()
  class ClockDate extends Date {
    constructor(value = now) { super(value) }
    static now() { return now }
  }
  const disk = { session: null, queue: [], card: [], refreshDay: null }
  const played = []
  let response = []
  let requests = 0
  const state = {
    playInfo: { playerListId: constants.LIST_IDS.PLAY_QUEUE, playerPlayIndex: 0, playIndex: 0 },
    playMusicInfo: { musicInfo: null, isTempPlay: false },
    isPlay: false,
  }
  const globals = { Date: ClockDate, global: { app_event: { playQueueUpdate() {} }, i18n: { t: key => key } } }
  const data = {
    getPlayQueue: async() => structuredClone(disk.queue),
    savePlayQueue: async queue => { disk.queue = structuredClone(queue) },
    getQQMusicRecommendSession: async() => structuredClone(disk.session),
    saveQQMusicRecommendSession: async session => { disk.session = structuredClone(session) },
    removeQQMusicRecommendSession: async() => { disk.session = null },
    saveQQMusicDailyRecommendCache: async value => { disk.card = structuredClone(value) },
    saveQQMusicRefreshDay: async() => { disk.refreshDay = new ClockDate().toDateString() },
  }
  const queue = load('src/core/player/playQueue.ts', {
    '@/utils/data': data,
    '@/config/constant': constants,
    '@/store/player/state': { default: state },
    '@/store/player/action': {
      default: {
        updatePlayIndex: (playIndex, playerPlayIndex) => { Object.assign(state.playInfo, { playIndex, playerPlayIndex }) },
      },
    },
  }, globals)
  const sessions = load('src/core/qqMusicRecommendSession.ts', {
    '@/core/player/playQueue': queue,
    '@/store/player/state': { default: state },
    '@/utils/data': data,
    '@/config/constant': constants,
  }, globals)
  let selectionRevision = 0
  const player = {
    createPlaySelection: () => {
      const revision = ++selectionRevision
      return () => revision === selectionRevision
    },
    playList: async(listId, index, isCurrent = () => true) => {
      if (!isCurrent()) return
      selectionRevision++
      assert.equal(listId, constants.LIST_IDS.PLAY_QUEUE)
      state.playInfo = { playerListId: listId, playerPlayIndex: index, playIndex: index }
      state.playMusicInfo = { musicInfo: queue.getPlayQueue()[index].musicInfo, isTempPlay: false }
      state.isPlay = true
      played.push(state.playMusicInfo.musicInfo.id)
    },
    play: () => { selectionRevision++; state.isPlay = true },
  }
  const account = { cookie: 'fixture-cookie' }
  const qq = {
    getQQMusicSession: async() => account,
    isQQMusicSessionCurrent: session => session === account,
    getQQMusicDailyRecommendations: async() => { requests++; return response },
    writeQQMusicSessionCache: async(session, write) => { await write(); return true },
  }
  const recommend = load('src/core/qqMusicRecommend.ts', {
    '@/core/player/playQueue': queue,
    '@/core/qqMusic': qq,
    '@/store/list/state': { default: { tempListMeta: {} } },
    '@/store/player/state': { default: state },
    '@/config/constant': constants,
    '@/core/qqMusicRecommendSession': sessions,
    '@/core/player/player': player,
    '@/core/player/playedList': { clearPlayedList() {} },
  }, globals)
  const home = load('src/core/qqMusicHome.ts', {
    './qqMusic': qq,
    '@/utils/data': data,
    './qqMusicRecommendSession': sessions,
  }, globals)
  return {
    disk,
    state,
    queue,
    sessions,
    recommend,
    played,
    now: () => now,
    nextDay: () => { now += 86400000 },
    requests: () => requests,
    refreshCard: async value => { response = value; return home.refreshQQMusicHomeGuess(account) },
    // player.playList parks a recommendation before replacing it with another
    // list. Use those same real operations at the playback boundary.
    switchToDaily: async() => {
      await sessions.parkRecommendQueue()
      await queue.replacePlayQueue(constants.LIST_IDS.TEMP, songs('daily'))
      await player.playList(constants.LIST_IDS.PLAY_QUEUE, 3)
    },
    queueIds: () => Array.from(queue.getPlayQueueMusic(), item => item.id),
  }
}

for (const crossDay of [true, false]) {
  test(`${crossDay ? 'next-day' : 'same-day'} card refresh cannot restore an old queue parked after the refresh`, async() => {
    const h = harness()
    const original = songs('old')
    const fresh = songs('fresh')
    await h.recommend.startRecommendQueue(original, 6)
    await h.queue.appendPlayQueue(constants.QQ_DAILY_RECOMMEND_QUEUE_SOURCE, [song('continued')])
    if (crossDay) h.nextDay()
    await h.refreshCard(fresh)
    assert.equal(h.disk.card[0].id, fresh[0].id)
    assert.equal(h.queueIds()[0], original[0].id, 'Refreshing a card must not interrupt the current queue')
    assert.equal(h.disk.session, null)

    await h.switchToDaily()
    assert.equal(h.disk.session.savedAt, h.now(), 'Parking the old queue stamps it with the current day')
    assert.equal(h.disk.session.sourceFirstMusicId, original[0].id)
    const before = h.played.length
    assert.equal(await h.recommend.continueRecommendQueue(h.disk.card), false)
    assert.equal(h.played.length, before, 'A stale archive must never reach playback')
    assert.equal(h.queueIds()[0], 'daily-0')
    assert.equal(h.disk.session, null)

    // The card uses its already loaded songs when continuation returns false.
    await h.recommend.startRecommendQueue(h.disk.card)
    assert.equal(h.played.at(-1), fresh[0].id)
    assert.equal(h.state.playInfo.playerPlayIndex, 0)
    assert.deepEqual(h.queueIds(), fresh.map(item => item.id))
    assert.equal(h.requests(), 1, 'Switching back must not request another recommendation batch')
  })
}

test('a matching archive preserves continuation tracks and position even after its original first song was removed', async() => {
  const h = harness()
  const original = songs('same')
  await h.recommend.startRecommendQueue(original, 6)
  await h.queue.appendPlayQueue(constants.QQ_DAILY_RECOMMEND_QUEUE_SOURCE, [song('continued')])
  await h.queue.removePlayQueueItem(0)
  const expected = h.queueIds()
  const index = h.state.playInfo.playerPlayIndex
  assert.notEqual(expected[0], original[0].id)
  assert.equal(h.queue.getPlayQueueSourceFirstMusicId(), original[0].id)
  await h.switchToDaily()

  assert.equal(await h.recommend.continueRecommendQueue(original), true)
  assert.deepEqual(h.queueIds(), expected)
  assert.equal(h.state.playInfo.playerPlayIndex, index)
  assert.equal(h.played.at(-1), original[6].id)
  assert.equal(h.disk.session, null)
  assert.equal(h.requests(), 0)
})

test('a current-day archive still resumes when no recommendation card has loaded yet', async() => {
  const h = harness()
  const original = songs('cached')
  await h.recommend.startRecommendQueue(original, 4)
  await h.switchToDaily()
  assert.equal(await h.recommend.continueRecommendQueue([]), true)
  assert.equal(h.played.at(-1), original[4].id)
  assert.equal(h.requests(), 0)
})

test('an archive without a batch identifier cannot override a populated current card', async() => {
  const h = harness()
  h.disk.session = { songs: songs('legacy'), index: 3, savedAt: h.now() }
  assert.equal(await h.recommend.continueRecommendQueue(songs('fresh')), false)
  assert.equal(h.played.length, 0)
  assert.equal(h.disk.session, null)
})
