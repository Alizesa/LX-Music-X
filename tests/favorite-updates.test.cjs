const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load, deferred, flush } = require('./helpers/load.cjs')

const song = id => ({ id, name: id, source: 'tx', meta: { id: id.charCodeAt(0) } })
const ids = songs => Array.from(songs, item => item.id).sort()
const harness = ({ initial = [], beforeStale = async() => {}, beforeRead = async() => {} } = {}) => {
  let disk = initial.slice()
  let stale = false
  let reads = 0
  let timerId = 0
  const timers = new Map()
  const writes = []
  const api = load('src/core/qqMusicFavorite.ts', {
    react: {},
    './qqMusic': {
      getQQMusicSession: async() => ({ cookie: 'fixture' }),
      isQQMusicSessionCurrent: () => true,
      updateQQMusicPlaylistsCache: async() => true,
      postAuthedMusicu: async() => ({ req_0: { code: 0, data: { retCode: 0 } } }),
    },
    '@/utils/data': {
      getQQMusicLikedSongsCache: async() => { const songs = disk.slice(); await beforeRead(++reads); return songs },
      saveQQMusicLikedSongsCache: async songs => { disk = Array.from(songs); writes.push(ids(songs)) },
      getQQMusicLikedSongsStale: async() => stale,
      saveQQMusicLikedSongsStale: async value => { await beforeStale(value); stale = value },
      removeQQMusicLikedSongsCache: async() => { disk = [] },
      removeQQMusicLikedSongsStale: async() => { stale = false },
    },
    './qqMusicPlaylistSongsCache': {},
    '@/utils/tools': {},
    '@/utils/hooks/useScreenVisible': {},
  }, {
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id },
    clearTimeout: id => timers.delete(id),
    global: { app_event: { qqMusicLikedUpdated() {} }, i18n: { t: key => key } },
  })
  return { api, writes, timers, disk: () => disk, stale: () => stale }
}

for (const full of [false, true]) {
  for (const changes of [
    [['one', true], ['two', true]],
    [['one', true], ['base', false]],
    [['base', false], ['kept', false]],
  ]) {
    test(`concurrent favorite changes ${JSON.stringify(changes)} agree in ${full ? 'full-list' : 'ID-only'} memory and storage`, async() => {
      const gate = deferred()
      const initial = [song('base'), song('kept')]
      const h = harness({ initial, beforeStale: async value => { if (value) await gate.promise } })
      if (full) await h.api.loadQQMusicLikedSongsCache()
      else await h.api.ensureQQMusicLikedIds()
      const pending = Promise.all(changes.map(([id, liked]) => h.api.setQQMusicTrackLiked(song(id), liked)))
      await flush()
      gate.resolve()
      await pending
      await flush()
      const expected = new Set(initial.map(item => item.id))
      changes.forEach(([id, liked]) => { if (liked) expected.add(id); else expected.delete(id) })
      assert.deepEqual(ids(h.disk()), [...expected].sort())
      assert.equal(h.api.getQQMusicLikedCount(), expected.size)
      for (const id of ['base', 'kept', 'one', 'two']) assert.equal(h.api.isQQMusicTrackLiked(id), expected.has(id), id)
      if (full) assert.deepEqual(ids(h.api.getQQMusicLikedSongs()), [...expected].sort())
      else assert.equal(h.api.getQQMusicLikedSongs(), null)
    })
  }
}

test('opening the full favorite cache during a pending mark retains the successful change', async() => {
  const gate = deferred()
  const h = harness({ initial: [song('base')], beforeStale: async() => gate.promise })
  await h.api.ensureQQMusicLikedIds()
  const marking = h.api.setQQMusicTrackLiked(song('one'), true)
  await flush()
  const reading = h.api.loadQQMusicLikedSongsCache()
  await flush()
  gate.resolve()
  await Promise.all([marking, reading])
  await flush()
  assert.deepEqual(ids(h.api.getQQMusicLikedSongs()), ['base', 'one'])
  assert.deepEqual(ids(h.disk()), ['base', 'one'])
  assert.equal(h.api.getQQMusicLikedCount(), 2)
})

test('a cold read begun before a favorite write cannot restore the earlier snapshot', async() => {
  const read = deferred()
  const h = harness({ initial: [song('base')], beforeRead: async count => { if (count === 2) await read.promise } })
  await h.api.ensureQQMusicLikedIds()
  const reading = h.api.loadQQMusicLikedSongsCache()
  await flush()
  await h.api.setQQMusicTrackLiked(song('one'), true)
  read.resolve()
  await reading
  assert.deepEqual(ids(h.api.getQQMusicLikedSongs()), ['base', 'one'])
  assert.equal(h.api.getQQMusicLikedCount(), 2)
})

test('account clearing follows an in-progress stale mark and removes all of its old data', async() => {
  const gate = deferred()
  const h = harness({ initial: [song('base')], beforeStale: async() => gate.promise })
  await h.api.ensureQQMusicLikedIds()
  const marking = h.api.setQQMusicTrackLiked(song('one'), true)
  await flush()
  h.api.clearQQMusicLikedSongs()
  const reading = h.api.loadQQMusicLikedSongsCache()
  await flush()
  gate.resolve()
  await Promise.all([marking, reading])
  await flush()
  assert.deepEqual(ids(h.disk()), [])
  assert.equal(h.stale(), false)
  assert.equal(h.api.getQQMusicLikedCount(), 0)
  assert.equal(h.api.isQQMusicTrackLiked('one'), false)
})

test('a failed stale mark does not poison the next favorite cache write', async() => {
  let fail = true
  const h = harness({
    initial: [song('base')],
    beforeStale: async() => { if (fail) { fail = false; throw new Error('storage unavailable') } },
  })
  await h.api.ensureQQMusicLikedIds()
  await h.api.setQQMusicTrackLiked(song('one'), true)
  await h.api.setQQMusicTrackLiked(song('two'), true)
  await flush()
  assert.deepEqual(ids(h.disk()), ['base', 'two'])
  assert.equal(h.api.isQQMusicTrackLiked('two'), true)
  assert.equal(h.stale(), true)
})
