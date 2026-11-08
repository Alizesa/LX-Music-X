const assert = require('node:assert/strict')
const { test } = require('node:test')
const { EventEmitter } = require('node:events')
const { load, deferred, flush } = require('./helpers/load.cjs')
const { jsx, hookHost, elements } = require('./helpers/react.cjs')

const songs = name => [{ id: name, source: 'tx', name, singer: 'Artist', meta: { picUrl: name + '-cover' } }]
const harness = () => {
  const host = hookHost(), frame = host.frame(), events = new EventEmitter()
  let session = { cookie: 'A', generation: 1, user: null }
  let tree
  const caches = new Map([[1, { daily: songs('cached-A') }]])
  const replies = new Map()
  const toasts = []
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
    '@/components/common/IconAction': {}, '@/components/QQMusicLoginModal': {},
    '@/store/theme/hook': { useTheme: () => ({}) },
    '@/utils/hooks': { useTabletLayout: () => ({ isWide: false, contentWidth: 400 }) },
    '@/utils/tools': { createStyle: value => value, toast: value => toasts.push(value) },
    '@/config/constant': {}, '@/core/homePagerScroll': { setHomePagerHorizontalScroll() {} },
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
    account, caches, replies, events, frame, toasts,
    session: () => session,
    render, settle,
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
