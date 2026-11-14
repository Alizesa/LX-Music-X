const { test } = require('node:test')
const { harness, song, load, deferred, flush, constants, assert } = require('./helpers/playback.cjs')
const { hookHost, jsx, elements } = require('./helpers/react.cjs')

const setup = async(kind, stage = 'save') => {
  const h = await harness()
  await h.player.playList('library', 0)
  const gate = deferred()
  const songs = [song('entry-song'), song('second-song')]
  const full = [...songs, song('later-page')]
  const writes = []
  const requests = []
  const listState = { tempListMeta: {} }
  const listApi = {
    setTempList: async(id, songs) => {
      writes.push({ id, songs })
      h.lists[constants.LIST_IDS.TEMP] = songs
      if (stage === 'save' && writes.length === 1) await gate.promise
      listState.tempListMeta = { id }
    },
  }
  const details = {
    getListDetail: async() => {
      requests.push('first')
      if (stage === 'first page') await gate.promise
      return { list: stage === 'empty first page' ? [] : songs }
    },
    getListDetailAll: async() => {
      requests.push('all')
      if (stage === 'full list' || stage === 'empty first page') await gate.promise
      return full
    },
  }
  const dependencies = {
    '@/config/constant': constants,
    '@/core/list': listApi,
    '@/core/player/player': h.player,
    '@/core/songlist': details,
    '@/store/list/state': { default: listState },
    '@/core/qqMusic': {},
    '@/core/qqMusicFavorite': {},
    '@/utils/tools': {},
    '@/store/songlist/state': { default: {} },
  }
  let start
  let close = () => {}
  if (kind === 'singer' || kind === 'album') {
    const folder = kind === 'singer' ? 'SingerDetail' : 'AlbumDetail'
    const action = load(`src/screens/${folder}/listAction.ts`, dependencies)
    start = () => action.handlePlay('fixture', songs)
  } else if (kind === 'songlist') {
    const action = load('src/screens/SonglistDetail/listAction.ts', dependencies)
    start = () => action.handlePlay('fixture', 'tx', stage === 'save' ? songs : undefined)
  } else if (kind === 'deeplink') {
    const action = load('src/core/init/deeplink/playSonglist.ts', dependencies)
    start = () => action.playSonglist('tx', 'fixture')
  } else if (kind === 'online menu') {
    let commits = 0
    h.io.savePlayQueue = async() => { if (++commits === 1 && stage === 'save') await gate.promise }
    const action = load('src/components/OnlineList/listAction.ts', {
      ...dependencies,
      '@/core/player/playQueue': h.queue,
      '@/core/player/tempPlayList': {},
      '@/store/setting/state': { default: { setting: h.setting } },
      '@/store/player/state': { default: h.state },
      '@/core/dislikeList': {},
      '@/utils/data': {},
    })
    start = () => action.handlePlay(songs[0])
  } else {
    const host = hookHost()
    const frame = host.frame()
    const translate = key => key
    frame.connect = tree => { elements(tree, 'OnlineList')[0].props.ref.current = { setStatus() {}, setList() {} } }
    const Component = load('src/screens/QQPlaylist/index.tsx', {
      ...dependencies,
      react: host.react,
      'react/jsx-runtime': { jsx, jsxs: jsx },
      'react-native': { View: 'View', TouchableOpacity: 'TouchableOpacity' },
      '@/utils/hooks/useScreenVisible': { useScreenVisible: host.visible },
      '@/components/PageContent': { default: 'PageContent' },
      '@/components/common/StatusBar': {},
      '@/components/SimpleHeader': {},
      '@/components/player/PlayerBar': {},
      '@/components/OnlineList': { default: 'OnlineList' },
      '@/components/common/Text': {},
      '@/components/common/ImageBackground': {},
      '@/components/common/Icon': {},
      '@/components/common/IconAction': {},
      '@/components/common/PlusMinusIcon': {},
      '@/core/common': { setComponentId() {} },
      '@/core/qqMusicHome': {},
      '@/core/qqMusicPlaylistSongsCache': {},
      '@/core/qqMusicDailyPosition': { QQ_DAILY_PLAYLIST_ID: 'qq_daily_playlist' },
      '@/utils/data': { getQQMusicDailyPlaylistCache: async() => songs },
      '@/utils/tools': { createStyle: value => value, toast() {} },
      '@/utils/pixelRatio': { scaleSizeW: value => value },
      '@/utils/hooks': {},
      '@/lang': { useI18n: () => translate },
    }).default
    const tree = host.render(frame, () => Component({ componentId: 'daily', info: { id: 'daily', name: 'Daily', daily: true } }))
    await flush()
    start = () => elements(tree, 'OnlineList')[0].props.onPlayList(0)
    close = () => host.unmount(frame)
  }
  return { ...h, gate, writes, requests, listState, full, start, close }
}

for (const kind of ['singer', 'album', 'songlist', 'deeplink', 'online menu', 'QQ playlist row']) {
  for (const action of ['pause', 'new selection']) {
    test(`${kind} cannot override a later ${action} after waiting for storage`, async t => {
      const h = await setup(kind)
      t.after(h.close)
      const pending = h.start()
      await flush()
      if (action === 'pause') await h.player.pause()
      else if (kind === 'online menu') await h.player.playList(constants.LIST_IDS.PLAY_QUEUE, 0)
      else await h.player.playList('library', 2)
      const current = h.state.playMusicInfo
      const requested = h.player.isPlayRequested()
      h.gate.resolve()
      await pending
      await flush()
      assert.equal(h.state.playMusicInfo, current)
      assert.equal(h.player.isPlayRequested(), requested)
    })
  }

  test(`${kind} still plays the current selection after storage completes`, async t => {
    const h = await setup(kind)
    t.after(h.close)
    const pending = h.start()
    await flush()
    h.gate.resolve()
    await pending
    await flush()
    assert.equal(h.state.playMusicInfo.musicInfo.id, 'entry-song')
    assert.equal(h.player.isPlayRequested(), true)
  })

  test(`${kind} survives the previous track ending while storage is pending`, async t => {
    const h = await setup(kind)
    t.after(h.close)
    const pending = h.start()
    await flush()
    h.globals.app_event.playerEnded()
    await flush()
    h.gate.resolve()
    await pending
    await flush()
    assert.equal(h.state.playMusicInfo.musicInfo.id, 'entry-song')
    assert.equal(h.player.isPlayRequested(), true)
  })
}

for (const next of ['temporary playback', 'empty queue']) {
  test(`a pending user selection survives automatic ${next}`, async() => {
    const h = await setup('singer')
    const pending = h.start()
    await flush()
    if (next === 'temporary playback') h.state.tempPlayList.push({ listId: null, musicInfo: song('temporary'), isTempPlay: true })
    else await h.queue.clearPlayQueue()
    h.globals.app_event.playerEnded()
    await flush()
    h.gate.resolve()
    await pending
    await h.advance(0)
    assert.equal(h.state.playMusicInfo.musicInfo.id, 'entry-song')
    assert.equal(h.player.isPlayRequested(), true)
  })
}

test('a failed user preparation does not prevent the existing queue from advancing', async() => {
  const h = await setup('singer')
  const pending = h.start().catch(error => error)
  await flush()
  h.gate.reject(new Error('write failed'))
  assert.match((await pending).message, /write failed/)
  h.globals.app_event.playerEnded()
  await flush()
  assert.equal(h.state.playMusicInfo.musicInfo.id, 'B')
})

for (const kind of ['songlist', 'deeplink']) {
  test(`${kind} keeps the pending user choice through an automatic track change during the first request`, async() => {
    const h = await setup(kind, 'first page')
    const pending = h.start()
    await flush()
    h.globals.app_event.playerEnded()
    await flush()
    h.gate.resolve()
    await pending
    await flush()
    assert.equal(h.state.playMusicInfo.musicInfo.id, 'entry-song')
    assert.deepEqual(h.requests, ['first', 'all'])
  })
  for (const stage of ['first page', 'empty first page', 'full list']) {
    test(`${kind} drops an obsolete ${stage} response before modifying the temporary list`, async t => {
      const h = await setup(kind, stage)
      t.after(h.close)
      const pending = h.start()
      await flush()
      await h.player.playList('library', 2)
      const current = h.state.playMusicInfo
      const writes = h.writes.length
      h.gate.resolve()
      await pending
      await flush()
      assert.equal(h.state.playMusicInfo, current)
      assert.equal(h.writes.length, writes)
      if (stage === 'first page') assert.deepEqual(h.requests, ['first'])
    })
  }

  test(`${kind} can complete its own full-list request after committing playback`, async() => {
    const h = await setup(kind, 'full list')
    const pending = h.start()
    await flush()
    assert.equal(h.state.playMusicInfo.musicInfo.id, 'entry-song')
    h.gate.resolve()
    await pending
    await flush()
    assert.deepEqual(Array.from(h.writes.at(-1).songs, item => item.id), h.full.map(item => item.id))
    assert.equal(h.state.playMusicInfo.musicInfo.id, 'entry-song')
    assert.deepEqual(h.requests, ['first', 'all'])
  })

  test(`${kind} starts from the full list when the first page is empty`, async() => {
    const h = await setup(kind, 'empty first page')
    const pending = h.start()
    await flush()
    assert.equal(h.state.playMusicInfo.musicInfo.id, 'A')
    h.gate.resolve()
    await pending
    await flush()
    assert.equal(h.state.playMusicInfo.musicInfo.id, 'entry-song')
    assert.equal(h.writes.length, 1)
  })
}
