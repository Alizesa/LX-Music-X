const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const ts = require('typescript')

const copy = value => value == null ? value : JSON.parse(JSON.stringify(value))
const flush = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve
  const promise = new Promise(_resolve => { resolve = _resolve })
  return { promise, resolve }
}
const gate = () => {
  const entered = deferred()
  const released = deferred()
  return { entered: entered.promise, release: released.resolve, wait: async() => { entered.resolve(); await released.promise } }
}
const load = (file, mocks = {}, appGlobal = {}) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  })
  const context = {
    exports: {},
    AbortController,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    global: { i18n: { t: key => key }, ...appGlobal },
    require: name => {
      assert.ok(Object.hasOwn(mocks, name), `Unexpected import: ${name}`)
      return mocks[name]
    },
  }
  vm.runInNewContext(outputText, context, { filename: file })
  return context.exports
}

const cookieA = 'uin=o0000000111; qm_keyst=Q_KEY_A'
const cookieB = 'uin=o0000000222; qm_keyst=Q_KEY_B'
const playlist = { id: '12345', name: 'Playlist', subscribed: true }
const oldPlaylists = [{ id: '201', name: 'Liked', liked: true, subscribed: false }, playlist]

// Use the production session lifecycle, cache adapters and collection handlers.
// Only storage IO, HTTP and the unrelated native modules are replaced.
const harness = ({
  initialPlaylists = oldPlaylists,
  playlists = async() => copy(initialPlaylists),
  beforeRead = async() => {},
  beforeSessionRead = async() => {},
  beforeSave = async() => {},
  beforeCleanup = async() => {},
  beforeProfile = async() => {},
  beforeWrite = async() => {},
  writeResult = () => ({ code: 0, req_0: { code: 0, data: { result: 0, retCode: 0 } } }),
} = {}) => {
  const constants = load('src/config/constant.ts')
  const keys = constants.storageDataPrefix
  const cookie = load('src/core/qqMusicCookie.ts')
  const values = new Map([
    [keys.qqMusicUser, { uin: '111', nickname: 'Account A' }],
    [keys.qqMusicPlaylists, copy(initialPlaylists)],
  ])
  const secure = new Map([[keys.qqMusicCookie, cookieA]])
  const notices = []
  const writes = []
  let notifications = 0
  const appGlobal = { app_event: { qqMusicPlaylistsUpdated: () => { notifications++ } } }
  const data = load('src/utils/data.ts', {
    '@/config/constant': constants,
    './legacyList': {},
    './common': { throttle: fn => fn },
    './nativeModules/secureStorage': {
      getSecureItem: async key => {
        const value = secure.get(key)
        if (key === keys.qqMusicCookie) await beforeSessionRead()
        return value
      },
      setSecureItem: async(key, value) => { secure.set(key, value) },
      removeSecureItem: async key => { secure.delete(key) },
    },
    '@/plugins/storage': {
      getData: async key => {
        const value = copy(values.get(key))
        if (key === keys.qqMusicPlaylists) await beforeRead()
        return value
      },
      saveData: async(key, value) => {
        if (key === keys.qqMusicPlaylists) await beforeSave()
        values.set(key, copy(value))
      },
      removeData: async key => {
        if (key === keys.qqMusicDailyPlaylist) await beforeCleanup()
        values.delete(key)
      },
    },
  })
  const message = load('src/utils/message.ts')
  const account = load('src/core/qqMusic.ts', {
    '@/utils/abort': load('src/utils/abort.ts', { './message': message }),
    '@/utils/data': data,
    '@/utils': { decodeName: value => value },
    '@/utils/musicSdk': {},
    './qqMusicPlaylistSongsCache': { clearPlaylistSongsCache: async() => {} },
    '@react-native-cookies/cookies': { default: { get: async() => ({}), flush: async() => {} } },
    './qqMusicCookie': cookie,
    './qqMusicLogin': { hasQQMusicRefreshCredential: () => false },
    './qqMusicProfile': load('src/core/qqMusicProfile.ts'),
    '@/utils/request': {
      httpFetch: (url, options) => ({
        cancelHttp() {},
        promise: (async() => {
          if (!options.body) {
            const uin = cookie.getQQMusicUin(options.headers.Cookie)
            await beforeProfile(uin)
            return { statusCode: 200, body: { code: 0, data: { creator: { uin, nick: `Account ${uin}`, headpic: 'https://example.test/avatar.png' } } } }
          }
          writes.push({ cookie: options.headers.Cookie, ...copy(options.body.req_0) })
          await beforeWrite(options.body.req_0)
          return { statusCode: 200, body: writeResult() }
        })(),
      }),
    },
  }, appGlobal)
  account.getQQMusicPlaylists = playlists
  const favorite = load('src/core/qqMusicFavorite.ts', {
    react: {},
    './qqMusic': account,
    '@/utils/data': data,
    './qqMusicPlaylistSongsCache': { dropCachedPlaylistSongs: async() => {} },
    '@/utils/tools': { toast: text => notices.push(text) },
  }, appGlobal)
  const action = load('src/screens/SonglistDetail/listAction.ts', {
    '@/core/list': {},
    '@/core/player/player': {},
    '@/core/songlist': {},
    '@/config/constant': constants,
    '@/store/list/state': {},
    '@/core/qqMusic': account,
    '@/core/qqMusicFavorite': favorite,
    '@/utils/data': data,
    '@/utils/tools': { toast: text => notices.push(text) },
    '@/store/songlist/state': { default: { listDetailInfo: {} } },
  }, appGlobal)
  return {
    account,
    data,
    favorite,
    notices,
    writes,
    collect: () => action.handleCollect(playlist.id, 'tx', playlist.name),
    cached: () => copy(values.get(keys.qqMusicPlaylists) ?? []),
    notifications: () => notifications,
  }
}

const homeApi = (h, requests = {}, drop = async() => {}) => load('src/core/qqMusicHome.ts', {
  './qqMusic': { ...h.account, ...requests },
  '@/utils/data': h.data,
  './qqMusicRecommendSession': { dropRecommendSession: drop },
})

for (const [method, requestMethod, cacheGetter, day] of [
  ['refreshQQMusicHomeDaily', 'getQQMusicDailyPlaylist', 'getQQMusicDailyPlaylistCache', 'playlist'],
  ['refreshQQMusicHomeGuess', 'getQQMusicDailyRecommendations', 'getQQMusicDailyRecommendCache', 'recommend'],
  ['refreshQQMusicHomeRadar', 'getQQMusicHeartRadarSongs', 'getQQMusicHeartRadarCache', 'radar'],
  ['refreshQQMusicHomePlaylists', 'getQQMusicRecommendedPlaylists', 'getQQMusicRecommendPlaylistsCache', null],
]) {
  for (const change of ['logout', 'switch account']) {
    test(`${method} rejects an old response after ${change} without restoring cleared caches`, async() => {
      const h = harness(); const response = gate()
      let dropped = 0
      const home = homeApi(h, { [requestMethod]: async() => { await response.wait(); return [{ id: 'old-account-song' }] } }, async() => { dropped++ })
      const session = await h.account.getQQMusicSession()
      const pending = home[method](session)
      const rejection = assert.rejects(pending, error => error instanceof h.account.QQMusicSessionExpiredError)
      await response.entered
      if (change === 'logout') await h.account.clearQQMusicSession()
      else await h.account.saveQQMusicSession(cookieB)
      response.release()
      await rejection
      const cached = await h.data[cacheGetter]()
      assert.ok(cached == null || cached.length === 0)
      assert.equal(dropped, 0)
      if (day) assert.notEqual(await h.data.getQQMusicRefreshDay(day), new Date().toDateString())
    })
  }
}

test('logout waits for a home cache write and removes both its data and refresh-day marker', async() => {
  const h = harness(); const writing = gate()
  const save = h.data.saveQQMusicDailyPlaylistCache
  h.data.saveQQMusicDailyPlaylistCache = async songs => { await writing.wait(); await save(songs) }
  const home = homeApi(h, { getQQMusicDailyPlaylist: async() => [{ id: 'old-account-song' }] })
  const pending = home.refreshQQMusicHomeDaily(await h.account.getQQMusicSession())
  const rejection = assert.rejects(pending, error => error instanceof h.account.QQMusicSessionExpiredError)
  await writing.entered
  let loggedOut = false
  const logout = h.account.clearQQMusicSession().then(() => { loggedOut = true })
  await flush()
  assert.equal(loggedOut, false)
  writing.release()
  await Promise.all([logout, rejection])
  assert.equal((await h.data.getQQMusicDailyPlaylistCache()).length, 0)
  assert.notEqual(await h.data.getQQMusicRefreshDay('playlist'), new Date().toDateString())
})

test('a home refresh rejects an obsolete session before making a network request', async() => {
  const h = harness()
  const session = await h.account.getQQMusicSession()
  await h.account.clearQQMusicSession()
  let requests = 0
  const home = homeApi(h, { getQQMusicDailyPlaylist: async() => { requests++; return [] } })
  await assert.rejects(home.refreshQQMusicHomeDaily(session), error => error instanceof h.account.QQMusicSessionExpiredError)
  assert.equal(requests, 0)
})

test('a current home refresh saves songs and the refresh-day marker', async() => {
  const h = harness()
  const home = homeApi(h, { getQQMusicDailyPlaylist: async() => [{ id: 'current-song' }] })
  const songs = await home.refreshQQMusicHomeDaily(await h.account.getQQMusicSession())
  assert.equal(songs[0].id, 'current-song')
  assert.equal((await h.data.getQQMusicDailyPlaylistCache())[0].id, 'current-song')
  assert.equal(await h.data.getQQMusicRefreshDay('playlist'), new Date().toDateString())
})

for (const change of ['logout', 'switch account']) {
  test(`collection cannot restore the old cache during ${change} cleanup`, async() => {
    const refresh = gate()
    const cleanup = gate()
    const h = harness({
      playlists: async() => { await refresh.wait(); return copy(oldPlaylists) },
      beforeCleanup: cleanup.wait,
    })
    const collection = h.collect()
    await refresh.entered
    const changing = change === 'logout' ? h.account.clearQQMusicSession() : h.account.saveQQMusicSession(cookieB)
    await cleanup.entered
    try {
      assert.deepEqual(h.cached(), [])
      refresh.release()
      assert.equal(await collection, false)
    } finally {
      refresh.release()
      cleanup.release()
      await changing
    }
    assert.deepEqual(h.cached(), [])
    assert.equal(h.notifications(), 0)
    assert.equal(h.writes.length, 0)
    assert.equal(h.notices.includes('qq_playlist_faved'), false)
    const session = await h.account.getQQMusicSession()
    assert.equal(h.account.getQQMusicUin(session.cookie), change === 'logout' ? '' : '222')
  })
}

test('logout waits for a cache write already in progress before removing it', async() => {
  const save = gate()
  const h = harness({ beforeSave: save.wait })
  const collection = h.collect()
  await save.entered
  const logout = h.account.clearQQMusicSession()
  await flush()
  save.release()
  await logout
  assert.equal(await collection, false)
  assert.deepEqual(h.cached(), [])
  assert.equal(h.notifications(), 0)
})

test('a collection started during cleanup cannot use the still-stored old cookie', async() => {
  const cleanup = gate()
  const h = harness({ beforeCleanup: cleanup.wait })
  const logout = h.account.clearQQMusicSession()
  await cleanup.entered
  try {
    assert.equal(await h.favorite.toggleQQMusicPlaylistCollected(playlist, true), false)
    assert.equal(h.writes.length, 0)
  } finally {
    cleanup.release()
    await logout
  }
  assert.deepEqual(h.cached(), [])
})

test('a pending favorite write without caller options cannot restore a logged-out cache', async() => {
  const write = gate()
  const h = harness({ beforeWrite: write.wait })
  const collection = h.favorite.toggleQQMusicPlaylistCollected(playlist, true)
  await write.entered
  await h.account.clearQQMusicSession()
  write.release()
  assert.equal(await collection, false)
  assert.deepEqual(h.cached(), [])
  assert.equal(h.notifications(), 0)
  assert.equal(h.notices.includes('qq_playlist_faved'), false)
})

test('logging back into the same account does not reactivate an old collection request', async() => {
  const refresh = gate()
  const h = harness({ playlists: async() => { await refresh.wait(); return copy(oldPlaylists) } })
  const collection = h.collect()
  await refresh.entered
  await h.account.clearQQMusicSession()
  await h.account.saveQQMusicSession(cookieA)
  refresh.release()
  assert.equal(await collection, false)
  assert.deepEqual(h.cached(), [])
  assert.equal(h.notifications(), 0)
})

test('concurrent favorites preserve both cache updates for the current account', async() => {
  const h = harness()
  const additions = [{ id: '20001', name: 'First' }, { id: '20002', name: 'Second' }]
  assert.deepEqual(await Promise.all(additions.map(item => h.favorite.toggleQQMusicPlaylistCollected(item, true))), [true, true])
  assert.deepEqual(h.cached().map(item => item.id).sort(), [...oldPlaylists, ...additions].map(item => item.id).sort())
  assert.equal(h.notifications(), 2)
})

test('a failed cache write does not block subsequent writes or logout cleanup', async() => {
  let fail = true
  const h = harness({ beforeSave: async() => { if (fail) { fail = false; throw new Error('storage unavailable') } } })
  await h.favorite.toggleQQMusicPlaylistCollected({ id: '20001', name: 'First' }, true)
  assert.equal(await h.favorite.toggleQQMusicPlaylistCollected({ id: '20002', name: 'Second' }, true), true)
  assert.ok(h.cached().some(item => item.id === '20002'))
  await h.account.clearQQMusicSession()
  assert.deepEqual(h.cached(), [])
})

test('account switching waits for an in-progress cache write before clearing it', async() => {
  const save = gate()
  const h = harness({ beforeSave: save.wait })
  const collection = h.collect()
  await save.entered
  const switching = h.account.saveQQMusicSession(cookieB)
  await flush()
  save.release()
  await switching
  assert.equal(await collection, false)
  assert.deepEqual(h.cached(), [])
  assert.equal(h.notifications(), 0)
  assert.equal(h.account.getQQMusicUin((await h.account.getQQMusicSession()).cookie), '222')
})

test('logout invalidates a cache read before it can become a write', async() => {
  const read = gate()
  const h = harness({ beforeRead: read.wait })
  const collection = h.collect()
  await read.entered
  const logout = h.account.clearQQMusicSession()
  read.release()
  await logout
  assert.equal(await collection, false)
  assert.deepEqual(h.cached(), [])
  assert.equal(h.notifications(), 0)
})

test('a session read spanning an account switch cannot attach the new generation to the old cookie', async() => {
  const read = gate()
  const h = harness({ beforeSessionRead: read.wait })
  const reading = h.account.getQQMusicSession()
  await read.entered
  const switching = h.account.saveQQMusicSession(cookieB)
  await flush()
  read.release()
  await switching
  const old = await reading
  assert.equal(old.cookie, '')
  assert.equal(h.account.isQQMusicSessionCurrent(old), false)
  const current = await h.account.getQQMusicSession()
  assert.equal(h.account.getQQMusicUin(current.cookie), '222')
  assert.equal(h.account.isQQMusicSessionCurrent(current), true)
})

test('a caller-provided snapshot stays invalid after the same account logs in again', async() => {
  const h = harness()
  const session = await h.account.getQQMusicSession()
  await h.account.saveQQMusicSession(cookieA)
  assert.equal(await h.favorite.toggleQQMusicPlaylistCollected(playlist, true, { session }), false)
  assert.equal(h.writes.length, 0)
  assert.equal(h.notifications(), 0)
  assert.deepEqual(h.cached(), oldPlaylists)
})

for (const collected of [true, false]) {
  test(`an old ${collected ? 'favorite' : 'unfavorite'} response preserves the new account cache`, async() => {
    const write = gate()
    const h = harness({ beforeWrite: write.wait })
    const collection = h.favorite.toggleQQMusicPlaylistCollected(playlist, collected)
    await write.entered
    await h.account.saveQQMusicSession(cookieB)
    const session = await h.account.getQQMusicSession()
    const next = [{ id: '30001', name: 'Account B playlist', subscribed: false }]
    assert.equal(await h.account.updateQQMusicPlaylistsCache(session, () => next), true)
    const notifications = h.notifications()
    write.release()
    assert.equal(await collection, false)
    assert.deepEqual(h.cached(), next)
    assert.equal(h.notifications(), notifications)
    assert.equal(h.notices.length, 0)
  })
}

test('search collection uses its session for the server write after refreshing the cache', async() => {
  const h = harness({ playlists: async() => [copy(oldPlaylists[0])] })
  assert.equal(await h.collect(), true)
  assert.equal(h.writes.length, 1)
  assert.equal(h.account.getQQMusicUin(h.writes[0].cookie), '111')
  assert.equal(h.writes[0].method, 'FavPlaylist')
  assert.deepEqual(h.writes[0].param.v_playlistId, [Number(playlist.id)])
  assert.ok(h.cached().some(item => item.id === playlist.id && item.subscribed))
  assert.equal(h.notifications(), 2)
})

test('a pending writable-playlist refresh cannot restore a logged-out cache', async() => {
  const refresh = gate()
  const owned = { id: '40001', name: 'Owned', subscribed: false }
  const h = harness({
    initialPlaylists: [owned],
    playlists: async() => { await refresh.wait(); return [{ ...owned, dirId: 1 }] },
  })
  const loading = h.favorite.loadWritableQQMusicPlaylists()
  await refresh.entered
  await h.account.clearQQMusicSession()
  refresh.release()
  assert.deepEqual(copy(await loading), [])
  assert.deepEqual(h.cached(), [])
  assert.equal(h.notifications(), 0)
})

test('a refresh after creating a playlist cannot restore a logged-out cache', async() => {
  const refresh = gate()
  const h = harness({ playlists: async() => { await refresh.wait(); return copy(oldPlaylists) } })
  const creating = h.favorite.createQQMusicPlaylist('New playlist')
  await refresh.entered
  await h.account.clearQQMusicSession()
  refresh.release()
  await creating
  assert.deepEqual(h.cached(), [])
  assert.equal(h.notifications(), 0)
})

for (const operation of ['rename', 'delete']) {
  test(`a pending playlist ${operation} cannot restore a logged-out cache`, async() => {
    const write = gate()
    const owned = { id: '40001', name: 'Owned', dirId: 1, subscribed: false }
    const h = harness({ initialPlaylists: [owned], beforeWrite: write.wait })
    const editing = operation === 'rename'
      ? h.favorite.renameQQMusicPlaylist(owned, 'Renamed')
      : h.favorite.deleteQQMusicPlaylist(owned)
    await write.entered
    await h.account.clearQQMusicSession()
    write.release()
    await editing
    assert.deepEqual(h.cached(), [])
    assert.equal(h.notifications(), 0)
  })
}

test('an expired response from a previous session cannot log out the same account after a new login', async() => {
  const write = gate()
  const h = harness({ beforeWrite: write.wait, writeResult: () => ({ code: 1000 }) })
  const collection = h.favorite.toggleQQMusicPlaylistCollected(playlist, true)
  await write.entered
  await h.account.clearQQMusicSession()
  await h.account.saveQQMusicSession(cookieA)
  const session = await h.account.getQQMusicSession()
  write.release()
  assert.equal(await collection, false)
  await flush()
  assert.equal(h.account.isQQMusicSessionCurrent(session), true)
  assert.equal(h.account.getQQMusicUin((await h.account.getQQMusicSession()).cookie), '111')
  assert.deepEqual(h.cached(), [])
})

for (const loginAgain of [false, true]) {
  test(`a login profile arriving after logout cannot ${loginAgain ? 'replace the newer login' : 'restore the session'}`, async() => {
    const profile = gate()
    const h = harness({ beforeProfile: async uin => { if (uin === '222') await profile.wait() } })
    const login = h.account.saveQQMusicSession(cookieB)
    await profile.entered
    await h.account.clearQQMusicSession()
    if (loginAgain) await h.account.saveQQMusicSession(cookieA)
    profile.release()
    await assert.rejects(login, error => error instanceof h.account.QQMusicSessionExpiredError)
    const current = await h.account.getQQMusicSession()
    assert.equal(h.account.getQQMusicUin(current.cookie), loginAgain ? '111' : '')
    assert.deepEqual(h.cached(), [])
  })
}

for (const operation of ['rename', 'delete']) {
  test(`a pending ${operation} preserves concurrent favorites and unfavorites`, async() => {
    const write = gate()
    const owned = { id: '40001', name: 'Owned', dirId: 1, subscribed: false }
    const added = { id: '40002', name: 'New favorite' }
    const h = harness({
      initialPlaylists: [owned, playlist],
      beforeWrite: async request => { if (request.method === (operation === 'rename' ? 'EditPlaylist' : 'DelPlaylist')) await write.wait() },
    })
    const editing = operation === 'rename'
      ? h.favorite.renameQQMusicPlaylist(owned, 'Renamed')
      : h.favorite.deleteQQMusicPlaylist(owned)
    await write.entered
    try {
      assert.equal(await h.favorite.toggleQQMusicPlaylistCollected(added, true), true)
      assert.equal(await h.favorite.toggleQQMusicPlaylistCollected(playlist, false), true)
    } finally {
      write.release()
      await editing
    }
    assert.ok(h.cached().some(item => item.id === added.id))
    assert.ok(!h.cached().some(item => item.id === playlist.id))
    assert.equal(h.cached().find(item => item.id === owned.id)?.name, operation === 'rename' ? 'Renamed' : undefined)
  })
}
