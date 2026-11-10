const assert = require('node:assert/strict')
const { test } = require('node:test')
const { EventEmitter } = require('node:events')
const { load, deferred, flush } = require('./helpers/load.cjs')
const { jsx, hookHost, elements } = require('./helpers/react.cjs')

const songs = name => [{ id: name, source: 'tx', name, singer: 'Artist', meta: { picUrl: name + '-cover' } }]
const harness = (layout = { isWide: false, contentWidth: 400 }, nativeHost = true) => {
  const host = hookHost(), frame = host.frame(), events = new EventEmitter()
  let session = { cookie: 'A', generation: 1, user: null }
  let tree
  const caches = new Map([[1, { daily: songs('cached-A') }]])
  const replies = new Map()
  const toasts = []
  const pagerCommands = []
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
    '@/components/common/Text': {}, '@/components/common/Image': {}, '@/components/common/ImageBackground': {},
    '@/components/HorizontalScrollHost': { default: nativeHost ? 'HorizontalScrollHost' : 'View', hasNativeHorizontalScrollHost: nativeHost },
    '@/components/common/IconAction': {}, '@/components/QQMusicLoginModal': {},
    '@/store/theme/hook': { useTheme: () => ({}) },
    '@/utils/hooks': { useTabletLayout: () => layout },
    '@/utils/tools': { createStyle: value => value, toast: value => toasts.push(value) },
    '@/config/constant': {}, '@/core/homePagerScroll': { setHomePagerHorizontalScroll: active => pagerCommands.push(active) },
    '@/core/list': {}, '@/core/player/player': {}, '@/core/qqMusic': account,
    '@/core/qqMusicHome': { refreshQQMusicHomeDaily: async owner => replies.get(owner.generation) ?? songs('fresh-' + owner.cookie) },
    '@/core/qqMusicRecommend': {}, '@/core/qqMusicDailyPosition': {}, '@/navigation': {}, '@/store/common/state': {},
    '@/utils/data': {
      getPlayHistory: async() => [], getQQMusicRefreshDay: async() => new Date().toDateString(),
      getQQMusicDailyPlaylistCache: async() => cache('daily'), getQQMusicDailyRecommendCache: async() => cache('guess'),
      getQQMusicHeartRadarCache: async() => cache('radar'), getQQMusicRecommendPlaylistsCache: async() => cache('playlists'),
    },
    '@/lang': { useI18n: () => key => key },
  }, { global: { app_event: events } }).default
  const render = () => { tree = host.render(frame, component); return tree }
  const settle = async() => { await flush(); render(); await flush(); render() }
  const refreshControl = () => elements(tree, 'ScrollView')[0].props.refreshControl.props
  return {
    account, caches, replies, events, frame, toasts, pagerCommands,
    session: () => session,
    render, settle,
    horizontalRows: () => elements(tree, 'ScrollView').filter(node => node.props.horizontal),
    protectedRows: () => elements(tree, 'HorizontalScrollHost'),
    measure: width => { tree.props.onLayout({ nativeEvent: { layout: { width } } }); render() },
    resize: next => { layout = next; render() },
    mount: async() => { render(); await settle() },
    unmount: () => host.unmount(frame),
    cover: () => elements(tree, 'ScrollView').find(node => node.props.horizontal).props.children[0].props.cover,
    refreshing: () => refreshControl().refreshing,
    refresh: () => refreshControl().onRefresh(),
    changeAccount: cookie => {
      session = { cookie, generation: session.generation + 1, user: null }
      events.emit('qqMusicAccountUpdated')
      render()
    },
  }
}

test('a slow playlist cache does not delay songs or overwrite a completed refresh', async t => {
  const h = harness(), slow = deferred()
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
  const h = harness(), slow = deferred()
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
  const h = harness(), slow = deferred()
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
  const h = harness(), first = deferred(), second = deferred()
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
  const h = harness(), session = deferred()
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
        UIManager: { getViewManagerConfig: name => {
          lookups++
          assert.equal(name, 'LXHorizontalScrollHost')
          return installed ? {} : null
        } },
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
