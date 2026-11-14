const { test } = require('node:test')
const { harness, song, load, deferred, flush, constants, assert } = require('./helpers/playback.cjs')

const QUEUE = constants.LIST_IDS.PLAY_QUEUE
const recommendations = () => Array.from({ length: 20 }, (_, index) => song(`recommend-${index}`))

// Real selection counters, queue, playback, archive and daily-position modules;
// only storage/network/native operations come from the controlled playback host.
const setup = async(options) => {
  const h = await harness(options)
  const disk = { session: null }
  const data = {
    getQQMusicRecommendSession: async() => structuredClone(disk.session),
    saveQQMusicRecommendSession: async value => { disk.session = structuredClone(value) },
    removeQQMusicRecommendSession: async() => { disk.session = null },
  }
  const sessions = load('src/core/qqMusicRecommendSession.ts', {
    '@/core/player/playQueue': h.queue,
    '@/store/player/state': { default: h.state },
    '@/utils/data': data,
    '@/config/constant': constants,
  }, { global: h.globals })
  Object.assign(h.recommendSession, sessions)
  const recommend = load('src/core/qqMusicRecommend.ts', {
    '@/core/player/playQueue': h.queue,
    '@/core/qqMusic': {},
    '@/store/list/state': { default: { tempListMeta: {} } },
    '@/store/player/state': { default: h.state },
    '@/config/constant': constants,
    '@/core/qqMusicRecommendSession': sessions,
    '@/core/player/player': h.player,
    '@/core/player/playedList': h.played,
  }, { global: h.globals })
  const dailyData = {
    getQQMusicDailyPosition: async() => null,
    getQQMusicHeartRadarPosition: async() => null,
    saveQQMusicDailyPosition: async() => {},
    saveQQMusicHeartRadarPosition: async() => {},
    removeQQMusicDailyPosition: async() => {},
    removeQQMusicHeartRadarPosition: async() => {},
  }
  const daily = load('src/core/qqMusicDailyPosition.ts', {
    '@/utils/data': Object.fromEntries(Object.keys(dailyData).map(key => [key, (...args) => dailyData[key](...args)])),
    '@/core/list': { setTempList: async(id, songs) => { h.lists[constants.LIST_IDS.TEMP] = songs } },
    '@/core/player/player': h.player,
    '@/core/player/playQueue': h.queue,
    '@/store/list/state': { default: { tempListMeta: {} } },
    '@/store/player/state': { default: h.state },
    '@/config/constant': constants,
  }, { global: h.globals })
  await h.player.playList(QUEUE, 0)
  const archive = () => {
    const songs = recommendations()
    disk.session = { songs, index: 4, savedAt: Date.now(), sourceFirstMusicId: songs[0].id }
    return songs
  }
  const holdRead = () => {
    const gate = deferred()
    const snapshot = structuredClone(disk.session)
    data.getQQMusicRecommendSession = async() => { await gate.promise; return snapshot }
    return gate
  }
  return { ...h, disk, data, sessions, recommend, daily, dailyData, archive, holdRead }
}

test('an archive read cannot override a later playlist selection', async() => {
  const h = await setup(); const songs = h.archive(); const read = h.holdRead()
  const restoring = h.recommend.continueRecommendQueue(songs)
  await flush()
  await h.player.playList('library', 1)
  read.resolve()
  assert.equal(await restoring, null)
  assert.equal(h.state.playMusicInfo.musicInfo.id, 'B')
  assert.deepEqual(Array.from(h.queue.getPlayQueueMusic(), item => item.id), ['A', 'B', 'C'])
  assert.ok(h.disk.session, 'an obsolete selection must not discard a still-usable archive')
})

for (const action of ['pause', 'stop', 'playNext', 'playPrev']) {
  test(`${action} invalidates an unfinished recommendation restore`, async() => {
    const h = await setup(); const songs = h.archive(); const read = h.holdRead()
    const restoring = h.recommend.continueRecommendQueue(songs)
    await flush()
    await h.player[action]()
    const selected = h.state.playMusicInfo
    read.resolve()
    assert.equal(await restoring, null)
    assert.equal(h.state.playMusicInfo, selected)
  })
}

for (const method of ['playQQMusicDailyPlaylist', 'playQQMusicHeartRadarPlaylist']) {
  test(`${method} reserves the newer selection before its position read finishes`, async() => {
    const h = await setup(); const songs = h.archive(); const read = h.holdRead(); const position = deferred()
    h.dailyData[method === 'playQQMusicDailyPlaylist' ? 'getQQMusicDailyPosition' : 'getQQMusicHeartRadarPosition'] = () => position.promise
    const restoring = h.recommend.continueRecommendQueue(songs)
    await flush()
    const daily = h.daily[method]([song('daily')])
    read.resolve()
    assert.equal(await restoring, null)
    assert.equal(h.state.playMusicInfo.musicInfo.id, 'A', 'the new selection is still reading its position')
    position.resolve(null)
    await daily
    assert.equal(h.state.playMusicInfo.musicInfo.id, 'daily')
  })
}

test('a slower daily-position read cannot override a more recent recommendation selection', async() => {
  const h = await setup(); const songs = h.archive(); const position = deferred()
  h.dailyData.getQQMusicDailyPosition = () => position.promise
  const daily = h.daily.playQQMusicDailyPlaylist([song('daily')])
  assert.equal(await h.recommend.continueRecommendQueue(songs), true)
  position.resolve(null)
  await daily
  assert.equal(h.state.playMusicInfo.musicInfo.id, 'recommend-4')
  assert.equal(h.lists[constants.LIST_IDS.TEMP], undefined, 'stale reads must stop before changing the temporary list')
})

test('a slow recommendation queue save neither replays a newer queue nor deletes its new archive', async() => {
  const h = await setup(); const songs = h.archive(); const saving = deferred()
  let writes = 0
  h.io.savePlayQueue = async() => { if (++writes === 1) await saving.promise }
  const restoring = h.recommend.continueRecommendQueue(songs)
  await flush()
  assert.equal(h.state.playMusicInfo.musicInfo.id, 'recommend-4', 'selection does not wait on queue persistence')
  await h.player.playList('library', 1)
  const latestArchive = structuredClone(h.disk.session)
  assert.equal(latestArchive.index, 4)
  saving.resolve()
  await restoring
  assert.equal(h.state.playMusicInfo.musicInfo.id, 'B')
  assert.deepEqual(h.disk.session, latestArchive)
})

test('concurrent archive restores commit only the most recent selection', async() => {
  const h = await setup(); const songs = h.archive(); const read = h.holdRead()
  let writes = 0
  h.io.savePlayQueue = async() => { writes++ }
  const first = h.recommend.continueRecommendQueue(songs)
  const latest = h.recommend.continueRecommendQueue(songs)
  read.resolve()
  assert.equal(await first, null)
  assert.equal(await latest, true)
  assert.equal(writes, 1)
  assert.equal(h.state.playMusicInfo.musicInfo.id, 'recommend-4')
})

test('discarding a mismatched archive cannot turn a cancelled selection into a fresh start', async() => {
  const h = await setup(); const removal = deferred()
  h.archive()
  h.data.removeQQMusicRecommendSession = () => removal.promise
  const restoring = h.recommend.continueRecommendQueue([song('fresh')])
  await flush()
  await h.player.playList(QUEUE, 1)
  removal.resolve()
  assert.equal(await restoring, null)
  assert.equal(h.state.playMusicInfo.musicInfo.id, 'B')
})

test('expired archives still allow a fresh recommendation queue', async() => {
  const h = await setup(); const songs = h.archive()
  h.disk.session.savedAt -= 2 * 86400000
  assert.equal(await h.recommend.continueRecommendQueue(songs), false)
  assert.equal(h.disk.session, null)
  await h.recommend.startRecommendQueue(songs)
  assert.equal(h.state.playMusicInfo.musicInfo.id, 'recommend-0')
})

for (const method of ['playList', 'playListById']) {
  test(`${method} reserves local playback before waiting for the local list`, async() => {
    const local = deferred()
    const h = await setup({ localList: { retainLocalList: () => local.promise, releaseLocalList() {} } })
    const songs = h.archive(); const read = h.holdRead()
    h.lists[constants.LIST_IDS.LOCAL] = [song('local')]
    const restoring = h.recommend.continueRecommendQueue(songs)
    await flush()
    const selection = h.player[method](constants.LIST_IDS.LOCAL, method === 'playList' ? 0 : 'local')
    read.resolve()
    assert.equal(await restoring, null)
    local.resolve(h.lists[constants.LIST_IDS.LOCAL])
    await selection
    assert.equal(h.state.playMusicInfo.musicInfo.id, 'local')
  })
}

for (const method of ['playQQMusicDailyPlaylist', 'playQQMusicHeartRadarPlaylist']) {
  test(`an older queue clear cannot invalidate a pending ${method} selection`, async() => {
    const h = await setup()
    await h.recommend.startRecommendQueue(recommendations(), 6)
    const saving = deferred()
    const position = deferred()
    const save = h.data.saveQQMusicRecommendSession
    h.data.saveQQMusicRecommendSession = async value => { await saving.promise; await save(value) }
    h.dailyData[method === 'playQQMusicDailyPlaylist' ? 'getQQMusicDailyPosition' : 'getQQMusicHeartRadarPosition'] = () => position.promise

    const clearing = h.player.clearQueue()
    await flush()
    const selected = h.daily[method]([song('latest-selection')])
    await flush()
    saving.resolve()
    await clearing
    assert.equal(h.state.playMusicInfo.musicInfo?.id, 'recommend-6', 'an obsolete clear must leave playback alone while the new selection loads')
    assert.equal(h.queue.getPlayQueue().length, 20)

    position.resolve(null)
    await selected
    assert.equal(h.state.playMusicInfo.musicInfo.id, 'latest-selection')
    assert.equal(h.player.isPlayRequested(), true)
  })
}

test('the latest queue clear still stops playback and preserves its recommendation archive', async() => {
  const h = await setup()
  await h.recommend.startRecommendQueue(recommendations(), 6)
  await h.player.clearQueue()
  assert.equal(h.state.playMusicInfo.musicInfo, null)
  assert.equal(h.queue.getPlayQueue().length, 0)
  assert.equal(h.player.isPlayRequested(), false)
  assert.equal(h.disk.session.index, 6)
  assert.equal(h.disk.session.songs.length, 20)
})

test('migrating legacy recommendation metadata cannot replay after a newer selection', async() => {
  const h = await setup()
  const songs = recommendations()
  await h.queue.replacePlayQueue(constants.QQ_DAILY_RECOMMEND_QUEUE_SOURCE, songs)
  await h.player.playList(QUEUE, 6)
  const saving = deferred()
  let writes = 0
  h.io.savePlayQueue = async() => { if (++writes === 1) await saving.promise }
  const resuming = h.recommend.continueRecommendQueue(songs)
  await flush()
  await h.player.playList('library', 1)
  saving.resolve()
  assert.equal(await resuming, null)
  assert.equal(h.state.playMusicInfo.musicInfo.id, 'B')
  assert.equal(h.queue.getPlayQueueSourceBatchKey(), undefined, 'a different playlist must not inherit the recommendation batch')
})

test('a queue clear remains the latest user request when the previous track ends during its archive write', async() => {
  const h = await setup()
  await h.recommend.startRecommendQueue(recommendations(), 6)
  const saving = deferred()
  const save = h.data.saveQQMusicRecommendSession
  h.data.saveQQMusicRecommendSession = async value => { await saving.promise; await save(value) }
  const clearing = h.player.clearQueue()
  await flush()
  h.globals.app_event.playerEnded()
  await flush()
  saving.resolve()
  await clearing
  assert.equal(h.queue.getPlayQueue().length, 0)
  assert.equal(h.state.playMusicInfo.musicInfo, null)
  assert.equal(h.player.isPlayRequested(), false)
})

test('an archive restore survives an automatic track change while its read is pending', async() => {
  const h = await setup()
  const songs = h.archive()
  const reading = h.holdRead()
  const restoring = h.recommend.continueRecommendQueue(songs)
  await flush()
  h.globals.app_event.playerEnded()
  await flush()
  reading.resolve()
  assert.equal(await restoring, true)
  assert.equal(h.state.playMusicInfo.musicInfo.id, 'recommend-4')
})

test('a committed selection stays complete across automatic playback and loses feedback ownership to a new user action', async() => {
  const h = await setup()
  const selection = h.player.createPlaySelection()
  await h.player.playList(QUEUE, 1, selection)
  assert.equal(selection(), false)
  assert.equal(selection.isLatest(), true)
  h.globals.app_event.playerEnded()
  await flush()
  assert.equal(selection(), false)
  assert.equal(selection.isLatest(), true)
  await h.player.pause()
  assert.equal(selection.isLatest(), false)
})

for (const method of ['playNext', 'playPrev']) {
  for (const empty of [false, true]) {
    test(`an older manual ${method} cannot ${empty ? 'stop an empty queue over' : 'replace'} a newer pending selection`, async() => {
      const h = await setup()
      if (empty) await h.queue.clearPlayQueue()
      const current = h.state.playMusicInfo
      const changing = h.player[method]()
      const selection = h.player.createPlaySelection()
      await changing
      assert.equal(selection(), true)
      assert.equal(h.state.playMusicInfo, current)
      await h.player.playList('library', 2, selection)
      assert.equal(h.state.playMusicInfo.musicInfo.id, 'C')
    })
  }
}

test('an explicit temporary-track selection still supersedes pending user playback', async() => {
  const h = await setup()
  h.state.tempPlayList.push({ listId: null, musicInfo: song('temporary'), isTempPlay: true })
  const selection = h.player.createPlaySelection()
  await h.player.playTempPlayMusic(0)
  assert.equal(selection(), false)
  assert.equal(selection.isLatest(), false)
  assert.equal(h.state.playMusicInfo.musicInfo.id, 'temporary')
})
