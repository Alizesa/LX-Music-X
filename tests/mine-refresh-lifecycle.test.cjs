const assert = require('node:assert/strict')
const { test } = require('node:test')
const { EventEmitter } = require('node:events')
const { load, deferred, flush } = require('./helpers/load.cjs')
const { hookHost, jsx, elements } = require('./helpers/react.cjs')

const playlists = id => [{ id: 'liked', name: 'Liked', liked: true, trackCount: 1 }, { id, name: id }]
const harness = async(initial = playlists('initial')) => {
  const host = hookHost(); const frame = host.frame(); const events = new EventEmitter(); const requests = []
  let session = { cookie: 'same-account', generation: 1, user: { uin: '42', nickname: 'User', avatar: 'https://avatar.test/u.png' } }
  let cache = initial; let likedRefreshes = 0; let cacheWrites = 0; let sessionCurrent = true
  let nextSessionGate; let cacheGate
  let active = true
  const toasts = []
  events.qqMusicPlaylistsUpdated = () => events.emit('qqMusicPlaylistsUpdated')
  const t = key => key
  const Component = load('src/screens/Home/Views/Mine/index.tsx', {
    react: host.react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': { View: 'View', SectionList: 'SectionList', RefreshControl: 'RefreshControl', TouchableOpacity: 'TouchableOpacity' },
    '@/components/common/Text': { default: 'Text' },
    '@/components/common/Icon': {},
    '@/components/common/Image': {},
    '@/components/QQMusicLoginModal': {},
    '@/components/QQMusicPhoneLoginModal': {},
    '@/components/QQPlaylistEditModal': {},
    '@/store/theme/hook': { useTheme: () => ({}) },
    '@/store/download/hook': { useDownloadCount: () => 0 },
    '@/utils/hooks': { useTabletLayout: () => ({ isWide: false, contentWidth: 400 }) },
    '@/utils/tools': { createStyle: value => value, toast: message => toasts.push(message) },
    '@/utils/pixelRatio': { scaleSizeW: value => value },
    '@/core/qqMusic': {
      getQQMusicSession: async() => { const gate = nextSessionGate; nextSessionGate = null; if (gate) await gate.promise; return session },
      isQQMusicSessionCurrent: owner => owner === session && sessionCurrent,
      filterVisiblePlaylists: value => value,
      getQQMusicPlaylists: async() => { const gate = deferred(); requests.push(gate); return gate.promise },
      updateQQMusicPlaylistsCache: async(owner, update) => {
        if (cacheGate) await cacheGate.promise
        if (!sessionCurrent) return false
        const next = update(cache)
        if (next !== null) { cache = next; cacheWrites++; events.qqMusicPlaylistsUpdated() }
        return true
      },
    },
    '@/core/qqMusicFavorite': { getQQMusicLikedCount: () => 1, ensureQQMusicLikedCount: async() => 1, refreshQQMusicLikedSongs: async() => { likedRefreshes++ } },
    '@/core/qqMusicProfile': {},
    '@/utils/localMatchIndex': { getLocalMusicCount: async() => 0 },
    '@/navigation': {},
    '@/store/common/state': {},
    '@/utils/data': { getPlayHistoryCount: async() => 0, getQQMusicPlaylistsCache: async() => cache },
    '@/lang': { useI18n: () => t },
    '@/utils/hooks/useScreenVisible': { useScreenVisible: host.visible },
  }, { global: { app_event: events, list_event: new EventEmitter() } }).default
  const render = () => host.render(frame, () => Component({ active }))
  const list = () => elements(render(), 'SectionList')[0]
  const settle = async() => { await flush(); render(); await flush(); return render() }
  render(); await settle()
  return {
    requests,
    frame,
    events,
    toasts,
    settle,
    refresh: async() => { list().props.refreshControl.props.onRefresh(); await flush() },
    refreshing: () => list().props.refreshControl.props.refreshing,
    ids: () => Array.from(list()?.props.sections.flatMap(section => section.data.flat()).map(item => item.id) ?? []),
    cachedIds: () => cache.map(item => item.id),
    writes: () => cacheWrites,
    likedRefreshes: () => likedRefreshes,
    render,
    active: value => { active = value; return render() },
    visible: value => { frame.visible = value; render() },
    unmount: () => host.unmount(frame),
    pauseNextSession: () => { nextSessionGate = deferred(); return nextSessionGate },
    pauseCache: () => { cacheGate = deferred(); return cacheGate },
    expireSession: () => { sessionCurrent = false },
    changeAccount: cookie => {
      session = { ...session, cookie, generation: session.generation + 1 }
      cache = []
      sessionCurrent = true
      events.emit('qqMusicAccountUpdated', session.user)
    },
  }
}

test('covering the mine tab retains its playlist view before the return animation and session read finish', async t => {
  const h = await harness()
  t.after(h.unmount)
  for (let index = 0; index < 3; index++) {
    h.visible(false)
    assert.notEqual(h.render(), null, 'the playlist view must stay mounted underneath the next screen')
    assert.deepEqual(h.ids(), ['initial'])
    assert.equal(h.events.listenerCount('qqMusicAccountUpdated'), 0)
    assert.equal(h.events.listenerCount('qqMusicPlaylistsUpdated'), 0)
    const session = h.pauseNextSession()
    h.visible(true)
    assert.deepEqual(h.ids(), ['initial'])
    await h.settle()
    assert.deepEqual(h.ids(), ['initial'])
    session.resolve()
    await h.settle()
    assert.deepEqual(h.ids(), ['initial'])
    assert.equal(h.requests.length, 0)
  }
})

test('returning to another account clears retained playlists even if the new account has no cache and its request fails', async t => {
  const h = await harness()
  t.after(h.unmount)
  h.visible(false)
  h.changeAccount('another-account')
  h.visible(true)
  await h.settle()
  assert.deepEqual(h.ids(), [], 'the previous account playlists must be removed before recovery completes')
  assert.equal(h.requests.length, 1)
  h.requests[0].reject(new Error('playlist recovery failed'))
  await h.settle()
  assert.deepEqual(h.ids(), [])
  assert.deepEqual(h.cachedIds(), [])
})

test('switching away from the mine tab still releases playlist rows and restores its local cache on return', async t => {
  const h = await harness()
  t.after(h.unmount)
  h.frame.visible = false
  assert.equal(h.active(false), null)
  assert.deepEqual(h.ids(), [])
  assert.equal(h.events.listenerCount('qqMusicAccountUpdated'), 0)
  h.frame.visible = true
  h.active(true)
  await h.settle()
  assert.deepEqual(h.ids(), ['initial'])
  assert.equal(h.requests.length, 0)
})

test('an older refresh cannot replace the page or shared cache after hide and reopen', async() => {
  const h = await harness()
  const old = h.refresh(); await flush(); h.visible(false); h.visible(true); await h.settle()
  const fresh = h.refresh(); await flush()
  h.requests[1].resolve(playlists('fresh')); await fresh; await h.settle()
  h.requests[0].resolve(playlists('stale')); await old; await h.settle()
  assert.deepEqual(h.ids(), ['fresh'])
  assert.deepEqual(h.cachedIds(), ['liked', 'fresh'])
  assert.equal(h.writes(), 1)
  assert.equal(h.likedRefreshes(), 1)
  h.unmount()
})

test('the finally block of an old refresh cannot unlock a newer pending request', async() => {
  const h = await harness()
  const old = h.refresh(); await flush(); h.visible(false); h.visible(true); await h.settle()
  const fresh = h.refresh(); await flush()
  h.requests[0].resolve(playlists('stale')); await old; await h.settle()
  assert.equal(h.refreshing(), true)
  await h.refresh(); await flush()
  assert.equal(h.requests.length, 2, 'only the current refresh owns the refresh lock')
  h.requests[1].resolve(playlists('fresh')); await fresh; await h.settle()
  assert.equal(h.refreshing(), false)
  h.unmount()
})

for (const result of ['success', 'error']) {
  test('a hidden refresh finishing with ' + result + ' cannot replace retained rows, write cache, refresh likes or toast', async() => {
    const h = await harness(); const request = h.refresh(); await flush(); h.visible(false)
    if (result === 'success') h.requests[0].resolve(playlists('hidden'))
    else h.requests[0].reject(new Error('obsolete failure'))
    await request; await h.settle()
    assert.deepEqual(h.ids(), ['initial'])
    assert.deepEqual(h.cachedIds(), ['liked', 'initial'])
    assert.equal(h.writes(), 0)
    assert.equal(h.likedRefreshes(), 0)
    assert.deepEqual(h.toasts, [])
    assert.equal(h.frame.slots.some(slot => Array.isArray(slot?.value) && slot.value.some(item => item?.id === 'hidden')), false)
    h.unmount()
  })
}

test('unmounting invalidates an in-flight refresh before it can commit shared effects', async() => {
  const h = await harness(); const request = h.refresh(); await flush(); h.unmount()
  h.requests[0].resolve(playlists('late')); await request; await flush()
  assert.deepEqual(h.cachedIds(), ['liked', 'initial'])
  assert.equal(h.writes(), 0)
  assert.equal(h.likedRefreshes(), 0)
})

test('hiding during the session read prevents provider work from starting', async() => {
  const h = await harness(); const gate = h.pauseNextSession(); const request = h.refresh()
  h.visible(false); gate.resolve(); await flush()
  const started = h.requests.length
  if (started) h.requests[0].resolve(playlists('late'))
  await request
  assert.equal(started, 0)
  h.unmount()
})

test('a refresh queued behind cache work rechecks ownership inside its cache callback', async() => {
  const h = await harness(); const gate = h.pauseCache(); const request = h.refresh(); await flush()
  h.requests[0].resolve(playlists('late')); await flush(); h.visible(false); gate.resolve(); await request; await h.settle()
  assert.deepEqual(h.cachedIds(), ['liked', 'initial'])
  assert.equal(h.writes(), 0)
  assert.equal(h.likedRefreshes(), 0)
  h.unmount()
})

test('an expired account cannot show a late refresh failure', async() => {
  const h = await harness(); const request = h.refresh(); await flush(); h.expireSession()
  h.requests[0].reject(new Error('old account failure')); await request; await h.settle()
  assert.deepEqual(h.toasts, [])
  assert.equal(h.refreshing(), false)
  h.unmount()
})

test('automatic playlist recovery cannot write a result after its page is hidden', async() => {
  const h = await harness([])
  assert.equal(h.requests.length, 1)
  h.visible(false); h.requests[0].resolve(playlists('late')); await h.settle()
  assert.equal(h.writes(), 0)
  assert.deepEqual(h.cachedIds(), [])
  h.unmount()
})

test('a visible refresh coalesces duplicate gestures and commits its current result once', async() => {
  const h = await harness(); const request = h.refresh(); await h.refresh(); await flush()
  assert.equal(h.requests.length, 1)
  h.requests[0].resolve(playlists('fresh')); await request; await h.settle()
  assert.deepEqual(h.ids(), ['fresh'])
  assert.deepEqual(h.cachedIds(), ['liked', 'fresh'])
  assert.equal(h.writes(), 1)
  assert.equal(h.likedRefreshes(), 1)
  assert.equal(h.refreshing(), false)
  h.unmount()
})


test('an old refresh failure cannot toast or clear a newer refresh indicator', async() => {
  const h = await harness()
  await h.refresh(); h.visible(false); h.visible(true); await h.settle()
  await h.refresh()
  h.requests[0].reject(new Error('obsolete failure')); await h.settle()
  assert.deepEqual(h.toasts, [])
  assert.equal(h.refreshing(), true)
  h.requests[1].resolve(playlists('fresh')); await h.settle()
  assert.deepEqual(h.ids(), ['fresh'])
  h.unmount()
})

test('a current visible failure reports once and releases its refresh lock for retry', async() => {
  const h = await harness(); await h.refresh()
  h.requests[0].reject(new Error('network failure')); await h.settle()
  assert.equal(h.toasts.length, 1)
  assert.equal(h.refreshing(), false)
  await h.refresh()
  assert.equal(h.requests.length, 2)
  h.requests[1].resolve(playlists('retry')); await h.settle()
  assert.deepEqual(h.ids(), ['retry'])
  h.unmount()
})
