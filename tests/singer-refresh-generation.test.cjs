const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load, deferred, flush } = require('./helpers/load.cjs')

const song = id => ({ id, source: 'tx', name: id, singer: 'Artist', interval: '03:00', meta: { _qualitys: {} } })
const album = id => ({ id, mid: id, name: id, source: 'tx' })
const result = list => ({ list, source: 'tx', total: 2, limit: 1, allPage: 2 })
const ids = list => Array.from(list, item => item.id)

const harness = () => {
  const state = load('src/store/singer/state.ts')
  const utils = { toNewMusicInfo: value => value, deduplicationList: values => values }
  const actions = load('src/store/singer/action.ts', { './state': state, '@/utils': utils }, { setTimeout: () => 1 })
  const values = new Map(); const writes = []; const reads = []; const calls = []
  let readHook = async() => {}
  const sdk = {
    singer: {
      getDetail: async mid => { calls.push('detail'); return { info: state.createSingerRecord(mid).info, songs: result([song('old-song-1')]) } },
      getSongs: async(mid, page) => { calls.push(`songs:${page}`); return result([song(`old-song-${page}`)]) },
      getAlbums: async(mid, page) => { calls.push(`albums:${page}`); return result([album(`old-album-${page}`)]) },
    },
    album: { getSongs: async(mid, page) => { calls.push(`album:${mid}:${page}`); return result([song(`${mid}-old-${page}`)]) } },
  }
  const api = load('src/core/singer.ts', {
    '@/store/singer/state': state,
    '@/store/singer/action': actions,
    '@/utils': utils,
    '@/utils/musicSdk': { default: { tx: sdk } },
    './detailCache': {
      getDetailCache: async key => {
        reads.push(key)
        const value = structuredClone(values.get(key) ?? null)
        await readHook(key)
        return value
      },
      saveDetailCache: (key, value) => { const saved = structuredClone(value); values.set(key, saved); writes.push({ key, value: saved }) },
    },
  })
  const freshDetail = async mid => {
    calls.push('fresh-detail')
    return { info: { ...state.createSingerRecord(mid).info, name: 'Fresh artist' }, songs: result([song('fresh-song-1')]) }
  }
  return {
    api,
    state: state.default,
    actions,
    sdk,
    values,
    writes,
    reads,
    calls,
    freshDetail,
    setRead: callback => { readHook = callback },
    releaseSinger: () => { actions.retainSingerRecord('s'); actions.releaseSingerRecord('s') },
    releaseAlbum: () => { actions.retainAlbumRecord('a'); actions.releaseAlbumRecord('a') },
  }
}

test('refreshing singer songs rejects an earlier second page without set or cache writes', async() => {
  const h = harness(); const gate = deferred()
  await h.api.getSingerDetail('s')
  h.sdk.singer.getSongs = async() => gate.promise
  const old = h.api.getSingerSongs('s', 2)
  h.sdk.singer.getDetail = h.freshDetail
  await h.api.getSingerDetail('s', true)
  const writes = h.writes.length
  gate.resolve(result([song('old-page-2')]))
  await old
  assert.deepEqual(ids(h.state.singers.s.songs.list), ['fresh-song-1'])
  assert.equal(h.state.singers.s.songs.page, 1)
  assert.equal(h.writes.length, writes)
  assert.equal(h.values.has('singer_s::songs:2'), false)
})

test('refreshing singer albums rejects an earlier second page without rewriting its cache', async() => {
  const h = harness(); const gate = deferred()
  await h.api.getSingerAlbums('s', 1)
  h.sdk.singer.getAlbums = async(mid, page) => page === 1 ? result([album('fresh-album-1')]) : gate.promise
  const old = h.api.getSingerAlbums('s', 2)
  await h.api.getSingerAlbums('s', 1, true)
  const writes = h.writes.length
  gate.resolve(result([album('old-page-2')]))
  await old
  assert.deepEqual(ids(h.state.singers.s.albums.list), ['fresh-album-1'])
  assert.equal(h.state.singers.s.albums.page, 1)
  assert.equal(h.writes.length, writes)
  assert.equal(h.values.has('singer_s::albums:2'), false)
})

test('refreshing album songs rejects its earlier second page without rewriting its cache', async() => {
  const h = harness(); const gate = deferred()
  await h.api.getAlbumSongs('a', 1)
  h.sdk.album.getSongs = async(mid, page) => page === 1 ? result([song('fresh-album-song-1')]) : gate.promise
  const old = h.api.getAlbumSongs('a', 2)
  await h.api.getAlbumSongs('a', 1, true)
  const writes = h.writes.length
  gate.resolve(result([song('old-page-2')]))
  await old
  assert.deepEqual(ids(h.state.albumSongs.a.list), ['fresh-album-song-1'])
  assert.equal(h.state.albumSongs.a.page, 1)
  assert.equal(h.writes.length, writes)
  assert.equal(h.values.has('album_a::songs:2'), false)
})

test('normal subsequent pages and independent singer tabs remain usable during refresh', async() => {
  const h = harness(); const songs = deferred(); const albums = deferred()
  await h.api.getSingerDetail('s')
  await h.api.getSingerAlbums('s', 1)
  h.sdk.singer.getSongs = async() => songs.promise
  const pendingSongs = h.api.getSingerSongs('s', 2)
  h.sdk.singer.getAlbums = async(mid, page) => page === 1 ? result([album('fresh-album-1')]) : albums.promise
  await h.api.getSingerAlbums('s', 1, true)
  songs.resolve(result([song('valid-song-2')]))
  await pendingSongs
  assert.deepEqual(ids(h.state.singers.s.songs.list), ['old-song-1', 'valid-song-2'])
  const pendingAlbums = h.api.getSingerAlbums('s', 2)
  h.sdk.singer.getDetail = h.freshDetail
  await h.api.getSingerDetail('s', true)
  albums.resolve(result([album('valid-album-2')]))
  await pendingAlbums
  assert.deepEqual(ids(h.state.singers.s.albums.list), ['fresh-album-1', 'valid-album-2'])
  assert.deepEqual(ids(h.state.singers.s.songs.list), ['fresh-song-1'])
})

test('refreshing one album does not invalidate another album or ordinary singer pages', async() => {
  const h = harness(); const gate = deferred()
  await h.api.getAlbumSongs('a', 1)
  await h.api.getAlbumSongs('b', 1)
  h.sdk.album.getSongs = async(mid, page) => mid === 'b' && page === 2 ? gate.promise : result([song(`${mid}-fresh-${page}`)])
  const pending = h.api.getAlbumSongs('b', 2)
  await h.api.getAlbumSongs('a', 1, true)
  gate.resolve(result([song('b-valid-2')]))
  await pending
  assert.deepEqual(ids(h.state.albumSongs.b.list), ['b-old-1', 'b-valid-2'])
  await h.api.getSingerDetail('s')
  await h.api.getSingerSongs('s', 2)
  await h.api.getSingerAlbums('s', 1)
  await h.api.getSingerAlbums('s', 2)
  assert.equal(h.state.singers.s.songs.list.length, 2)
  assert.equal(h.state.singers.s.albums.list.length, 2)
})

for (const refreshed of ['songs', 'albums']) {
  test(`a ${refreshed} refresh invalidates its cold restore while preserving the other tab and its disk links`, async() => {
    const h = harness(); const gate = deferred()
    await h.api.getSingerDetail('s')
    await h.api.getSingerSongs('s', 2)
    await h.api.getSingerAlbums('s', 1)
    await h.api.getSingerAlbums('s', 2)
    h.releaseSinger()
    h.setRead(async key => { if (key === `singer_s::${refreshed}:1`) await gate.promise })
    const cold = refreshed === 'songs' ? h.api.getSingerDetail('s') : h.api.getSingerAlbums('s', 1)
    await flush()
    h.sdk.singer.getDetail = h.freshDetail
    h.sdk.singer.getAlbums = async(mid, page) => { h.calls.push(`fresh-albums:${page}`); return result([album(`fresh-album-${page}`)]) }
    if (refreshed === 'songs') await h.api.getSingerDetail('s', true)
    else await h.api.getSingerAlbums('s', 1, true)
    const calls = h.calls.length
    gate.resolve()
    await cold
    assert.deepEqual(ids(h.state.singers.s.songs.list), refreshed === 'songs' ? ['fresh-song-1'] : ['old-song-1', 'old-song-2'])
    assert.deepEqual(ids(h.state.singers.s.albums.list), refreshed === 'albums' ? ['fresh-album-1'] : ['old-album-1', 'old-album-2'])
    h.setRead(async() => {})
    h.releaseSinger()
    await h.api.getSingerDetail('s')
    await h.api.getSingerAlbums('s', 1)
    assert.equal(h.calls.length, calls, 'returning must use valid persisted page links without another request')
    assert.deepEqual(ids(h.state.singers.s.songs.list), refreshed === 'songs' ? ['fresh-song-1'] : ['old-song-1', 'old-song-2'])
    assert.deepEqual(ids(h.state.singers.s.albums.list), refreshed === 'albums' ? ['fresh-album-1'] : ['old-album-1', 'old-album-2'])
  })
}

test('refreshing album songs invalidates an in-flight cold page restore', async() => {
  const h = harness(); const gate = deferred()
  await h.api.getAlbumSongs('a', 1)
  await h.api.getAlbumSongs('a', 2)
  h.releaseAlbum()
  h.setRead(async key => { if (key === 'album_a::songs:1') await gate.promise })
  const cold = h.api.getAlbumSongs('a', 1)
  await flush()
  h.sdk.album.getSongs = async() => { h.calls.push('fresh-album-songs'); return result([song('fresh-album-song-1')]) }
  await h.api.getAlbumSongs('a', 1, true)
  const calls = h.calls.length
  gate.resolve()
  await cold
  assert.deepEqual(ids(h.state.albumSongs.a.list), ['fresh-album-song-1'])
  assert.equal(h.state.albumSongs.a.page, 1)
  h.setRead(async() => {})
  h.releaseAlbum()
  await h.api.getAlbumSongs('a', 1)
  assert.equal(h.calls.length, calls)
})

test('a failed cold refresh keeps the previous offline snapshot while invalidating the already-started restore', async() => {
  const h = harness(); const read = deferred(); const network = deferred()
  await h.api.getSingerDetail('s')
  await h.api.getSingerSongs('s', 2)
  await h.api.getSingerAlbums('s', 1)
  h.releaseSinger()
  h.setRead(async key => { if (key === 'singer_s::songs:1') await read.promise })
  const cold = h.api.getSingerDetail('s')
  await flush()
  h.sdk.singer.getDetail = async() => { h.calls.push('failed-refresh'); return network.promise }
  const refresh = h.api.getSingerDetail('s', true)
  const failed = assert.rejects(refresh, /offline/)
  read.resolve()
  await cold
  assert.equal(h.state.singers.s.infoLoaded, false, 'the old restore must not apply its refreshed song tab')
  network.reject(new Error('offline'))
  await failed
  const calls = h.calls.length
  h.setRead(async() => {})
  await h.api.getSingerDetail('s')
  assert.deepEqual(ids(h.state.singers.s.songs.list), ['old-song-1', 'old-song-2'])
  assert.equal(h.calls.length, calls, 'failed refresh must not destroy the previous usable offline snapshot')
})

test('ordinary consumers share the current refreshed first-page request and ignore earlier refresh responses', async() => {
  const h = harness(); const old = deferred(); const fresh = deferred()
  h.sdk.singer.getDetail = async() => { h.calls.push('detail'); return h.calls.length === 1 ? old.promise : fresh.promise }
  const first = h.api.getSingerDetail('s', true)
  const latest = h.api.getSingerDetail('s', true)
  const consumer = h.api.getSingerDetail('s')
  assert.equal(h.calls.length, 2)
  fresh.resolve({ info: { mid: 's', name: 'Latest' }, songs: result([song('latest-song-1')]) })
  await Promise.all([latest, consumer])
  const writes = h.writes.length
  old.resolve({ info: { mid: 's', name: 'Old' }, songs: result([song('old-song-1')]) })
  await first
  assert.deepEqual(ids(h.state.singers.s.songs.list), ['latest-song-1'])
  assert.equal(h.state.singers.s.info.name, 'Latest')
  assert.equal(h.writes.length, writes)
})

for (const kind of ['songs', 'albums', 'albumSongs']) {
  test(`${kind}: a new second page waits for its refreshed first page instead of being overwritten`, async() => {
    const h = harness(); const first = deferred(); let laterCalls = 0
    let refresh; let later
    if (kind === 'songs') {
      await h.api.getSingerDetail('s')
      h.sdk.singer.getDetail = async() => first.promise
      h.sdk.singer.getSongs = async() => { laterCalls++; return result([song('fresh-2')]) }
      refresh = h.api.getSingerDetail('s', true)
      later = h.api.getSingerSongs('s', 2)
    } else if (kind === 'albums') {
      await h.api.getSingerAlbums('s', 1)
      h.sdk.singer.getAlbums = async(mid, page) => {
        if (page === 1) return first.promise
        laterCalls++
        return result([album('fresh-2')])
      }
      refresh = h.api.getSingerAlbums('s', 1, true)
      later = h.api.getSingerAlbums('s', 2)
    } else {
      await h.api.getAlbumSongs('a', 1)
      h.sdk.album.getSongs = async(mid, page) => {
        if (page === 1) return first.promise
        laterCalls++
        return result([song('fresh-2')])
      }
      refresh = h.api.getAlbumSongs('a', 1, true)
      later = h.api.getAlbumSongs('a', 2)
    }
    await flush()
    assert.equal(laterCalls, 0)
    const initial = result([kind === 'albums' ? album('fresh-1') : song('fresh-1')])
    first.resolve(kind === 'songs' ? { info: { mid: 's' }, songs: initial } : initial)
    await Promise.all([refresh, later])
    const info = kind === 'albumSongs' ? h.state.albumSongs.a : h.state.singers.s[kind]
    assert.deepEqual(ids(info.list), ['fresh-1', 'fresh-2'])
    assert.equal(laterCalls, 1)
  })
}
