const assert = require('node:assert/strict')
const { test } = require('node:test')
const { spawnSync } = require('node:child_process')
const { EventEmitter } = require('node:events')
const { load, deferred, flush } = require('./helpers/load.cjs')
const { hookHost } = require('./helpers/react.cjs')

const harness = (read = async() => []) => {
  const host = hookHost(); const frame = host.frame(); const timers = new Map()
  let reads = 0; let next = 0
  const app = Object.assign(new EventEmitter(), { qqMusicLikedUpdated() { this.emit('qqMusicLikedUpdated') } })
  const api = load('src/core/qqMusicFavorite.ts', {
    react: host.react,
    './qqMusic': { getQQMusicSession: async() => ({ cookie: '' }) },
    '@/utils/data': {
      getQQMusicLikedSongsCache: async() => { reads++; return read(reads) },
      removeQQMusicLikedSongsCache: async() => {},
      removeQQMusicLikedSongsStale: async() => {},
    },
    './qqMusicPlaylistSongsCache': {},
    '@/utils/tools': {},
    '@/utils/hooks/useScreenVisible': { useScreenVisible: host.visible },
  }, { global: { app_event: app }, setTimeout: (fn, delay) => { const id = ++next; timers.set(id, { fn, delay }); return id }, clearTimeout: id => timers.delete(id) })
  return { api, host, frame, app, timers, reads: () => reads, render: id => host.render(frame, () => api.useQQMusicLiked(id)) }
}

test('favorite ID, count and full-list readers share one cold read and release its successful promise', async() => {
  const gate = deferred(); const h = harness(() => gate.promise)
  const requests = [h.api.loadQQMusicLikedSongsCache(), h.api.ensureQQMusicLikedCount(), ...Array.from({ length: 8 }, () => h.api.ensureQQMusicLikedIds())]
  await flush()
  const initialReads = h.reads()
  gate.resolve([{ id: 'one' }, { id: 'two' }])
  await Promise.all(requests)
  assert.equal(initialReads, 1)
  assert.equal(h.api.getQQMusicLikedCount(), 2)
  for (const { fn } of h.timers.values()) fn()
  h.timers.clear()
  assert.equal(h.api.getQQMusicLikedSongs(), null)
  await h.api.loadQQMusicLikedSongsCache()
  assert.equal(h.reads(), 2)
})

test('account replacement invalidates an old read without clearing a newer shared read', async() => {
  const old = deferred(); const current = deferred()
  const h = harness(count => count === 1 ? old.promise : current.promise)
  const first = h.api.loadQQMusicLikedSongsCache()
  await flush()
  h.api.clearQQMusicLikedSongs()
  const second = h.api.loadQQMusicLikedSongsCache()
  await flush()
  old.resolve([{ id: 'old' }])
  assert.equal((await first).length, 0)
  const third = h.api.ensureQQMusicLikedIds()
  await flush()
  const readsBeforeCurrent = h.reads()
  current.resolve([{ id: 'current' }])
  await Promise.all([second, third])
  assert.equal(readsBeforeCurrent, 2)
  assert.equal(h.api.isQQMusicTrackLiked('old'), false)
  assert.equal(h.api.isQQMusicTrackLiked('current'), true)
})

test('a failed shared favorite read is retryable and empty results remain cached', async() => {
  const failed = deferred(); const h = harness(count => count === 1 ? failed.promise : Promise.resolve([]))
  const pending = Promise.allSettled(Array.from({ length: 4 }, () => h.api.ensureQQMusicLikedIds()))
  await flush()
  failed.reject(new Error('disk busy'))
  const results = await pending
  assert.ok(results.every(result => result.status === 'rejected'))
  await h.api.ensureQQMusicLikedIds()
  await h.api.ensureQQMusicLikedIds()
  assert.equal(h.reads(), 2)
  assert.equal(h.api.getQQMusicLikedCount(), 0)
})

test('hidden and empty heart controls avoid cold reads and subscriptions, and ignore late UI updates', async() => {
  const gate = deferred(); const h = harness(() => gate.promise)
  h.frame.visible = false
  h.render('one')
  await flush()
  assert.equal(h.reads(), 0)
  assert.equal(h.app.listenerCount('qqMusicLikedUpdated'), 0)
  h.frame.visible = true
  h.render(null)
  await flush()
  assert.equal(h.reads(), 0)
  h.render('one')
  await flush()
  h.frame.visible = false
  h.render('one')
  assert.equal(h.app.listenerCount('qqMusicLikedUpdated'), 0)
  gate.resolve([{ id: 'one' }])
  await flush()
  assert.equal(h.frame.dirty, false)
  h.frame.visible = true
  assert.equal(h.render('one'), true)
  h.host.unmount(h.frame)
})

test('ID-only initialization does not retain the full favorite array after collection', () => {
  const result = spawnSync(process.execPath, ['--expose-gc', '-e', `
    const assert = require('node:assert/strict')
    const { load, flush } = require('./tests/helpers/load.cjs')
    ;(async () => {
      let reference
      const api = load('src/core/qqMusicFavorite.ts', {
        react: {}, './qqMusic': { getQQMusicSession: async () => ({ cookie: '' }) },
        '@/utils/data': { getQQMusicLikedSongsCache: async () => {
          const list = Array.from({ length: 5000 }, (_, i) => ({ id: String(i), meta: { name: 'Track ' + i } }))
          reference = new WeakRef(list)
          return list
        } },
        './qqMusicPlaylistSongsCache': {}, '@/utils/tools': {}, '@/utils/hooks/useScreenVisible': {},
      }, { global: { app_event: { qqMusicLikedUpdated() {} } } })
      await api.ensureQQMusicLikedIds()
      for (let index = 0; index < 10; index++) { await flush(); global.gc() }
      assert.equal(reference.deref(), undefined)
      assert.equal(api.getQQMusicLikedSongs(), null)
      assert.equal(api.getQQMusicLikedCount(), 5000)
    })().catch(error => { console.error(error); process.exitCode = 1 })
  `], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})
