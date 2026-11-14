const { test } = require('node:test')
const { harness, song, load, deferred, flush, constants, assert } = require('./helpers/playback.cjs')

const QUEUE = constants.LIST_IDS.PLAY_QUEUE
const setup = async(kind, mode = 'listLoop') => {
  const writing = deferred()
  const reading = deferred()
  const writes = []
  const io = { confirm: async() => true }
  const dislike = {}
  const dislikeState = load('src/store/dislikeList/state.ts')
  const h = await harness({
    setting: { 'player.togglePlayMethod': mode },
    localList: { retainLocalList: () => reading.promise, releaseLocalList() {} },
    dislikeState: dislikeState.state,
    dislikeList: dislike,
  })
  const action = load('src/store/dislikeList/action.ts', {
    './state': dislikeState,
    '@/config/constant': constants,
    './event': { event: { dislike_changed() {} } },
  })
  const manage = load('src/utils/dislikeManage.ts', {
    '@/config/constant': constants,
    './data': { getDislikeListRules: async() => '' },
  })
  Object.assign(dislike, load('src/core/dislikeList.ts', {
    '@/store/dislikeList': { action },
    '@/utils/dislikeManage': manage,
  }, { global: h.globals }))
  h.globals.dislike_event = load('src/event/dislikeEvent.ts', {
    '@/utils/dislikeManage': manage,
    './Event': { default: load('src/event/Event.ts', {}, { setImmediate }).default },
    '@/utils/data': { saveDislikeListRules: async rules => { writes.push(rules); await writing.promise } },
    '@/core/dislikeList': dislike,
  }).createDislikeEventHub()
  const online = load('src/components/OnlineList/listAction.ts', {
    '@/config/constant': constants,
    '@/core/player/player': h.player,
    '@/core/player/playQueue': h.queue,
    '@/core/player/tempPlayList': {},
    '@/store/setting/state': { default: { setting: h.setting } },
    '@/utils/tools': { confirmDialog: () => io.confirm(), toast() {} },
    '@/core/dislikeList': dislike,
    '@/store/player/state': { default: h.state },
    '@/utils/data': {},
  }, { global: h.globals })
  await h.player.playList(QUEUE, 1)
  h.lists[constants.LIST_IDS.LOCAL] = [song('pending-local-song')]
  const start = () => kind === 'online menu' ? online.handleDislikeMusic(h.state.playMusicInfo.musicInfo) : h.player.dislikeMusic()
  return { ...h, writing, reading, writes, io, dislike, start }
}

for (const kind of ['online menu', 'player/deeplink']) {
  for (const completion of ['during save', 'after save']) {
    test(`${kind} dislike supersedes older playback whose read finishes ${completion}`, async() => {
      const h = await setup(kind)
      const pending = h.player.playList(constants.LIST_IDS.LOCAL, 0)
      const skipping = h.start()
      await flush()
      assert.equal(h.writes.length, 1)
      if (completion === 'during save') {
        h.reading.resolve()
        await pending
        assert.equal(h.state.playMusicInfo.musicInfo.id, 'B', 'accepting dislike must reserve the user action before storage finishes')
      }
      h.writing.resolve()
      await skipping
      await flush()
      assert.equal(h.state.playMusicInfo.musicInfo.id, 'C')
      h.reading.resolve()
      await pending
      assert.equal(h.state.playMusicInfo.musicInfo.id, 'C')
      assert.equal(h.dislike.hasDislike(h.lists.library[1]), true)
    })
  }

  for (const action of ['pause', 'stop', 'new playback', 'pending selection']) {
    test(`${kind} dislike finishing late cannot override a newer ${action}`, async() => {
      const h = await setup(kind)
      const skipping = h.start()
      await flush()
      let pending
      if (action === 'pending selection') pending = h.player.playList(constants.LIST_IDS.LOCAL, 0)
      else if (action === 'new playback') await h.player.playList(QUEUE, 0)
      else await h.player[action]()
      const selected = h.state.playMusicInfo
      const requested = h.player.isPlayRequested()
      h.writing.resolve()
      await skipping
      await flush()
      assert.equal(h.state.playMusicInfo, selected)
      assert.equal(h.player.isPlayRequested(), requested)
      if (pending) {
        h.reading.resolve()
        await pending
        assert.equal(h.state.playMusicInfo.musicInfo.id, 'pending-local-song')
      }
      assert.equal(h.dislike.hasDislike(h.lists.library[1]), true, 'the accepted blacklist edit still persists')
    })
  }

  test(`${kind} dislike does not skip a different track that advanced automatically during its save`, async() => {
    const h = await setup(kind)
    const skipping = h.start()
    await flush()
    h.globals.app_event.playerEnded()
    await flush()
    assert.equal(h.state.playMusicInfo.musicInfo.id, 'C')
    h.writing.resolve()
    await skipping
    await flush()
    assert.equal(h.state.playMusicInfo.musicInfo.id, 'C')
  })

  test(`${kind} dislike storage failure leaves automatic continuation available`, async() => {
    const h = await setup(kind)
    const skipping = h.start().catch(error => error)
    await flush()
    h.writing.reject(new Error('blacklist write failed'))
    assert.match((await skipping).message, /blacklist write failed/)
    assert.equal(h.state.playMusicInfo.musicInfo.id, 'B')
    h.globals.app_event.playerEnded()
    await flush()
    assert.equal(h.state.playMusicInfo.musicInfo.id, 'C')
  })

  for (const mode of ['list', 'none']) {
    test(`${kind} dislike preserves the ${mode} completion rule without reviving an old selection`, async() => {
      const h = await setup(kind, mode)
      await h.player.playList(QUEUE, 2)
      const pending = h.player.playList(constants.LIST_IDS.LOCAL, 0)
      const skipping = h.start()
      await flush()
      h.writing.resolve()
      await skipping
      await flush()
      assert.equal(h.state.playMusicInfo.musicInfo.id, 'C', 'dislike must not force manual-next wrapping at the end')
      h.reading.resolve()
      await pending
      assert.equal(h.state.playMusicInfo.musicInfo.id, 'C')
    })
  }
}

test('cancelling the dislike confirmation preserves the pending playback selection', async() => {
  const h = await setup('online menu')
  h.io.confirm = async() => false
  const pending = h.player.playList(constants.LIST_IDS.LOCAL, 0)
  await h.start()
  assert.equal(h.writes.length, 0)
  h.reading.resolve()
  await pending
  assert.equal(h.state.playMusicInfo.musicInfo.id, 'pending-local-song')
})
