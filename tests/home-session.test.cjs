const assert = require('node:assert/strict')
const { test } = require('node:test')
const { EventEmitter } = require('node:events')
const { load, deferred, flush } = require('./helpers/load.cjs')
const { jsx, hookHost, elements } = require('./helpers/react.cjs')
const { harness: playbackHarness, constants } = require('./helpers/playback.cjs')

const songs = name => [{ id: name, source: 'tx', name, singer: 'Artist', meta: { picUrl: name + '-cover' } }]
const harness = (layout = { isWide: false, contentWidth: 400 }, nativeHost = true) => {
  const host = hookHost(); const frame = host.frame(); const events = new EventEmitter()
  let session = { cookie: 'A', generation: 1, user: null }
  let tree
  const caches = new Map([[1, { daily: songs('cached-A') }]])
  const replies = new Map()
  const toasts = []
  const pagerCommands = []
  const player = {}; const recommend = {}; const list = {}; const dailyPosition = {}
  const home = { refreshQQMusicHomeDaily: async owner => replies.get(owner.generation) ?? songs('fresh-' + owner.cookie) }
  const cache = key => caches.get(session.generation)?.[key] ?? (key === 'playlists' ? null : [])
  class SessionExpired extends Error {}
  const account = {
    getQQMusicSession: async() => session,
    isQQMusicSessionCurrent: value => value.generation === session.generation,
    QQMusicSessionExpiredError: SessionExpired,
    getQQMusicSimilarSongs: async() => ({ songs: [] }),
  }
  const component = load('src/screens/Home/Views/Recommend/index.tsx', {
    react: host.react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { View: 'View', ScrollView: 'ScrollView', RefreshControl: 'RefreshControl', TouchableOpacity: 'TouchableOpacity' },
    '@/components/common/Text': {},
    '@/components/common/Image': {},
    '@/components/common/ImageBackground': {},
    '@/components/HorizontalScrollHost': { default: nativeHost ? 'HorizontalScrollHost' : 'View', hasNativeHorizontalScrollHost: nativeHost },
    '@/components/common/IconAction': {},
    '@/components/QQMusicLoginModal': {},
    '@/store/theme/hook': { useTheme: () => ({}) },
    '@/utils/hooks': { useTabletLayout: () => layout },
    '@/utils/tools': { createStyle: value => value, toast: value => toasts.push(value) },
    '@/config/constant': {},
    '@/core/homePagerScroll': { setHomePagerHorizontalScroll: active => pagerCommands.push(active) },
    '@/core/list': list,
    '@/core/player/player': player,
    '@/core/qqMusic': account,
    '@/core/qqMusicHome': home,
    '@/core/qqMusicRecommend': recommend,
    '@/core/qqMusicDailyPosition': dailyPosition,
    '@/navigation': {},
    '@/store/common/state': {},
    '@/utils/data': {
      getPlayHistory: async() => [],
      getQQMusicRefreshDay: async() => new Date().toDateString(),
      getQQMusicDailyPlaylistCache: async() => cache('daily'),
      getQQMusicDailyRecommendCache: async() => cache('guess'),
      getQQMusicHeartRadarCache: async() => cache('radar'),
      getQQMusicRecommendPlaylistsCache: async() => cache('playlists'),
    },
    '@/lang': { useI18n: () => key => key },
  }, { global: { app_event: events } }).default
  const render = () => { tree = host.render(frame, component); return tree }
  const settle = async() => { await flush(); render(); await flush(); render() }
  const refreshControl = () => elements(tree, 'ScrollView')[0].props.refreshControl.props
  return {
    account,
    caches,
    replies,
    events,
    frame,
    toasts,
    pagerCommands,
    player,
    recommend,
    home,
    list,
    dailyPosition,
    session: () => session,
    render,
    settle,
    horizontalRows: () => elements(tree, 'ScrollView').filter(node => node.props.horizontal),
    protectedRows: () => elements(tree, 'HorizontalScrollHost'),
    measure: width => { tree.props.onLayout({ nativeEvent: { layout: { width } } }); render() },
    resize: next => { layout = next; render() },
    mount: async() => { render(); await settle() },
    unmount: () => host.unmount(frame),
    cover: () => elements(tree, 'ScrollView').find(node => node.props.horizontal).props.children[0].props.cover,
    refreshing: () => refreshControl().refreshing,
    refresh: () => refreshControl().onRefresh(),
    playGuess: () => elements(tree, 'ScrollView').find(node => node.props.horizontal).props.children[1].props.onPress(),
    refreshGuess: () => elements(tree, 'ScrollView').find(node => node.props.horizontal).props.children[1].props.action.props.onPress(),
    guessPlaying: () => elements(tree, 'ScrollView').find(node => node.props.horizontal).props.children[1].props.disabled,
    playDaily: () => elements(tree, 'ScrollView').find(node => node.props.horizontal).props.children[0].props.action.props.onPress(),
    changeAccount: cookie => {
      session = { cookie, generation: session.generation + 1, user: null }
      events.emit('qqMusicAccountUpdated')
      render()
    },
  }
}

const playbackHome = async(t, cached = true) => {
  const playback = await playbackHarness(); const h = harness(); const started = []; const temporary = []; const fetched = []
  t.after(h.unmount)
  await playback.player.playList(constants.LIST_IDS.PLAY_QUEUE, 0)
  Object.assign(h.player, playback.player)
  h.list.setTempList = async(...args) => temporary.push(args)
  h.recommend.continueRecommendQueue = async() => false
  h.recommend.initQQMusicRecommendAutoRefresh = () => {}
  h.recommend.startRecommendQueue = async(value, index, firstId, isCurrent) => {
    assert.equal(isCurrent(), true)
    started.push(value)
  }
  h.home.refreshQQMusicHomeGuess = async() => { fetched.push(true); return songs('fresh-guess') }
  if (cached) h.caches.get(1).guess = songs('cached-guess')
  await h.mount()
  return { ...h, playback, started, temporary, fetched }
}

test('an obsolete recommendation result ends the card action without starting a fallback queue', async t => {
  const h = await playbackHome(t)
  h.recommend.continueRecommendQueue = async() => null
  h.playGuess()
  await h.settle()
  assert.equal(h.started.length, 0)
  assert.equal(h.temporary.length, 0)
  assert.equal(h.fetched.length, 0)
  assert.equal(h.guessPlaying(), false)
})

test('daily playback from the home card supersedes a pending recommendation restore', async t => {
  const h = await playbackHome(t); const reading = deferred(); const daily = []
  h.recommend.continueRecommendQueue = async(value, isCurrent) => { await reading.promise; return isCurrent() ? false : null }
  h.dailyPosition.playQQMusicDailyPlaylist = async(value, isCurrent) => {
    assert.equal(isCurrent(), true)
    daily.push(value)
  }
  h.playGuess()
  await h.settle()
  h.playDaily()
  reading.resolve()
  await h.settle()
  assert.equal(daily.length, 1)
  assert.equal(h.started.length, 0)
  assert.equal(h.fetched.length, 0)
})

test('refreshing the recommendation card invalidates an old restore before the refresh returns', async t => {
  const h = await playbackHome(t); const reading = deferred(); const refreshing = deferred()
  h.recommend.continueRecommendQueue = async(value, isCurrent) => { await reading.promise; return isCurrent() ? false : null }
  h.home.refreshQQMusicHomeGuess = () => refreshing.promise
  h.playGuess()
  await h.settle()
  h.refreshGuess()
  reading.resolve()
  await h.settle()
  assert.equal(h.started.length, 0)
  assert.equal(h.temporary.length, 0)
  refreshing.resolve(songs('fresh-guess'))
  await h.settle()
  assert.equal(h.started.length, 0)
})

for (const superseded of [false, true]) {
  test(`a card fetch ${superseded ? 'stops when another song is selected' : 'can start the batch requested by its own playback action'}`, async t => {
    const h = await playbackHome(t, false); const response = deferred()
    let requests = 0
    h.home.refreshQQMusicHomeGuess = () => { requests++; return response.promise }
    h.playGuess()
    await h.settle()
    assert.equal(requests, 1)
    if (superseded) await h.playback.player.playList(constants.LIST_IDS.PLAY_QUEUE, 1)
    response.resolve(songs('fresh-guess'))
    await h.settle()
    assert.equal(h.started.length, superseded ? 0 : 1)
    if (!superseded) assert.equal(h.started[0][0].id, 'fresh-guess')
    else assert.equal(h.playback.state.playMusicInfo.musicInfo.id, 'B')
    assert.equal(h.temporary.length, 0, 'recommendation queues no longer overwrite the shared temporary playlist')
    assert.equal(h.guessPlaying(), false)
  })
}

test('an earlier card action cannot clear the busy state of a newer restore', async t => {
  const h = await playbackHome(t); const requests = []
  h.recommend.continueRecommendQueue = async() => {
    const gate = deferred()
    requests.push(gate)
    await gate.promise
    return false
  }
  h.playGuess()
  h.playGuess()
  await h.settle()
  requests[0].resolve()
  await h.settle()
  assert.equal(h.guessPlaying(), true)
  assert.equal(h.started.length, 0)
  requests[1].resolve()
  await h.settle()
  assert.equal(h.guessPlaying(), false)
  assert.equal(h.started.length, 1)
})

test('a slow playlist cache does not delay songs or overwrite a completed refresh', async t => {
  const h = harness(); const slow = deferred()
  t.after(h.unmount)
  h.caches.get(1).playlists = slow.promise
  await h.mount()
  assert.equal(h.cover(), 'cached-A-cover')
  h.refresh()
  await h.settle()
  assert.equal(h.cover(), 'fresh-A-cover')
  slow.resolve({ list: [] })
  await h.settle()
  assert.equal(h.cover(), 'fresh-A-cover')
})

test('a song cache read cannot replace a newer successful refresh', async t => {
  const h = harness(); const slow = deferred()
  t.after(h.unmount)
  h.caches.get(1).daily = slow.promise
  await h.mount()
  h.refresh()
  await h.settle()
  assert.equal(h.cover(), 'fresh-A-cover')
  slow.resolve(songs('cached-A'))
  await h.settle()
  assert.equal(h.cover(), 'fresh-A-cover')
})

test('old cache reads cannot repopulate the home screen after switching accounts', async t => {
  const h = harness(); const slow = deferred()
  t.after(h.unmount)
  h.caches.get(1).daily = slow.promise
  await h.mount()
  h.caches.set(2, { daily: songs('cached-B') })
  h.changeAccount('B')
  await h.settle()
  assert.equal(h.cover(), 'cached-B-cover')
  slow.resolve(songs('cached-A'))
  await h.settle()
  assert.equal(h.cover(), 'cached-B-cover')
})

test('an old account refresh cannot clear the new account refresh indicator or display old songs', async t => {
  const h = harness(); const first = deferred(); const second = deferred()
  t.after(h.unmount)
  h.replies.set(1, first.promise)
  h.replies.set(2, second.promise)
  await h.mount()
  h.refresh()
  await h.settle()
  h.changeAccount('B')
  await h.settle()
  h.refresh()
  await h.settle()
  assert.equal(h.refreshing(), true)
  first.resolve(songs('fresh-A'))
  await h.settle()
  assert.equal(h.refreshing(), true)
  assert.equal(h.cover(), undefined)
  assert.equal(h.toasts.length, 0)
  second.resolve(songs('fresh-B'))
  await h.settle()
  assert.equal(h.refreshing(), false)
  assert.equal(h.cover(), 'fresh-B-cover')
})

test('unmount invalidates an unfinished account read and removes the listener', async() => {
  const h = harness(); const session = deferred()
  h.account.getQQMusicSession = async() => session.promise
  h.render()
  h.unmount()
  h.frame.dirty = false
  session.resolve(h.session())
  await flush()
  assert.equal(h.frame.dirty, false)
  assert.equal(h.events.listenerCount('qqMusicAccountUpdated'), 0)
})

test('both recommendation rows keep a horizontal scroll range on phone and narrow tablet windows', async t => {
  for (const { contentWidth, measuredWidth } of [
    { contentWidth: 400, measuredWidth: 400 },
    { contentWidth: 600, measuredWidth: 600 },
    { contentWidth: 840, measuredWidth: 808 },
  ]) {
    const h = harness({ isWide: false, contentWidth })
    t.after(h.unmount)
    h.caches.get(1).playlists = { list: Array.from({ length: 20 }, (_, id) => ({ id: String(id), name: 'Playlist ' + id })) }
    await h.mount()
    h.measure(measuredWidth)
    const [cards, playlists] = h.horizontalRows().map(row => row.props)
    const width = measuredWidth - 28
    assert.equal(cards.style.width, width)
    assert.equal(playlists.style.width, width)
    const thirdStart = cards.children[0].props.width * 2 + cards.contentContainerStyle.gap * 2
    assert.ok(thirdStart < width, 'the next card remains visible as a swipe hint')
    assert.ok(thirdStart + cards.children[2].props.width > width, 'the row must have room to scroll')
    const playlistWidth = playlists.children.reduce((total, item) => total + item.props.style.width + item.props.style.marginRight, 0)
    assert.ok(playlistWidth > width, 'playlist content must overflow the viewport')
    assert.equal(h.protectedRows().length, 2)
    assert.ok(h.protectedRows().every(row => row.props.children.props.horizontal))
  }
})

test('full-screen tablet card sizing returns unchanged after split-screen and small-window transitions', async t => {
  const h = harness({ isWide: true, contentWidth: 1112 })
  t.after(h.unmount)
  await h.mount()
  const assertWide = width => {
    const row = h.horizontalRows()[0].props
    assert.equal(row.children.length, 3)
    assert.equal(row.contentContainerStyle.justifyContent, 'center')
    for (const card of row.children) {
      assert.equal(card.props.width, 340)
      assert.equal(card.props.height, 190)
    }
    assert.ok(row.children[0].props.width * 3 + row.contentContainerStyle.gap * 2 <= width - 48)
  }
  h.measure(1112)
  assertWide(1112)
  for (const width of [600, 400]) {
    h.resize({ isWide: false, contentWidth: width })
    h.measure(width)
    const row = h.horizontalRows()[0].props
    assert.equal(row.style.width, width - 28)
    assert.ok(row.children[0].props.width * 3 > row.style.width)
  }
  h.resize({ isWide: true, contentWidth: 1512 })
  h.measure(1512)
  assertWide(1512)
})

test('the horizontal host uses native touch protection when installed and remains compatible with older APKs', () => {
  for (const { os, installed } of [
    { os: 'android', installed: true },
    { os: 'android', installed: false },
    { os: 'ios', installed: false },
  ]) {
    const registered = []
    let lookups = 0
    const module = load('src/components/HorizontalScrollHost.tsx', {
      'react-native': {
        Platform: { OS: os },
        UIManager: {
          getViewManagerConfig: name => {
            lookups++
            assert.equal(name, 'LXHorizontalScrollHost')
            return installed ? {} : null
          },
        },
        View: 'View',
        requireNativeComponent: name => { registered.push(name); return 'NativeHorizontalScrollHost' },
      },
    })
    assert.equal(module.default, installed ? 'NativeHorizontalScrollHost' : 'View')
    assert.equal(module.hasNativeHorizontalScrollHost, installed)
    assert.equal(registered.length, installed ? 1 : 0)
    assert.equal(lookups, os === 'android' ? 1 : 0)
  }
})

test('native-protected rows send no JS pager commands during touch, resize, logout or unmount', async t => {
  const h = harness()
  t.after(h.unmount)
  h.caches.get(1).playlists = { list: [{ id: 'playlist', name: 'Playlist' }] }
  await h.mount()
  for (const { props } of h.horizontalRows()) {
    props.onTouchStart?.()
    props.onTouchCancel?.()
    props.onTouchEnd?.()
  }
  h.resize({ isWide: true, contentWidth: 1112 })
  h.measure(1112)
  h.resize({ isWide: false, contentWidth: 600 })
  h.measure(600)
  h.changeAccount('')
  await h.settle()
  h.unmount()
  assert.deepEqual(h.pagerCommands, [])
  assert.equal(h.events.listenerCount('qqMusicAccountUpdated'), 0)
})

test('older APKs retain their JS touch locks and release them when the page unmounts', async t => {
  const h = harness(undefined, false)
  t.after(h.unmount)
  h.caches.get(1).playlists = { list: [{ id: 'playlist', name: 'Playlist' }] }
  await h.mount()
  for (const { props } of h.horizontalRows()) {
    h.pagerCommands.length = 0
    props.onTouchStart()
    props.onTouchEnd()
    props.onTouchStart()
    props.onTouchCancel()
    assert.deepEqual(h.pagerCommands, [true, false, true, false])
  }
  h.pagerCommands.length = 0
  h.unmount()
  assert.deepEqual(h.pagerCommands, [false])
  assert.equal(h.events.listenerCount('qqMusicAccountUpdated'), 0)
})
