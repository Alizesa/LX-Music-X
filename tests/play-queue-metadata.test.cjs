const { test } = require('node:test')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const { load, song, constants, assert } = require('./helpers/playback.cjs')

const metadataKeys = ['sessionId', 'sourceFirstMusicId', 'sourceBatchKey']
const source = constants.QQ_DAILY_RECOMMEND_QUEUE_SOURCE
const setup = (saved = []) => {
  let stored = structuredClone(saved)
  let writes = 0
  let reads = 0
  const state = { playInfo: { playerListId: constants.LIST_IDS.PLAY_QUEUE, playIndex: 10, playerPlayIndex: 10 }, playMusicInfo: { isTempPlay: false } }
  const queue = load('src/core/player/playQueue.ts', {
    '@/utils/data': {
      getPlayQueue: async() => { reads++; return structuredClone(stored) },
      savePlayQueue: async value => { writes++; stored = JSON.parse(JSON.stringify(value)) },
    },
    '@/config/constant': constants,
    '@/store/player/state': { default: state },
    '@/store/player/action': { default: { updatePlayIndex: (playIndex, playerPlayIndex) => { Object.assign(state.playInfo, { playIndex, playerPlayIndex }) } } },
  }, { global: { app_event: { playQueueUpdate() {} } } })
  return { queue, state, disk: () => structuredClone(stored), reads: () => reads, writes: () => writes }
}
const metadata = queue => ({
  sessionId: queue.getPlayQueueSessionId(),
  sourceFirstMusicId: queue.getPlayQueueSourceFirstMusicId(),
  sourceBatchKey: queue.getPlayQueueSourceBatchKey(),
})
const assertSingleOwner = (rows, expected) => {
  assert.deepEqual(Object.fromEntries(metadataKeys.map(key => [key, rows[0][key]])), expected)
  for (const row of rows.slice(1)) {
    for (const key of metadataKeys) assert.equal(Object.hasOwn(row, key), false, `${row.queueId} retains ${key}`)
  }
}
const original = () => Array.from({ length: 20 }, (_, index) => song('original-' + index))

test('repeated head moves keep one metadata copy and a stable serialized queue size', async() => {
  const h = setup()
  const songs = original()
  await h.queue.replacePlayQueue(source, songs, songs[0].id, JSON.stringify(songs.map(song => song.id)))
  await h.queue.appendPlayQueue(source, Array.from({ length: 480 }, (_, index) => song('continued-' + index)))
  const expected = metadata(h.queue)
  const bytes = Buffer.byteLength(JSON.stringify(h.disk()))
  const writes = h.writes()
  for (let move = 0; move < 100; move++) await h.queue.movePlayQueueItem(0, 499)
  assert.equal(h.writes(), writes + 100, 'metadata cleanup must share the existing queue write')
  assert.equal(Buffer.byteLength(JSON.stringify(h.disk())), bytes)
  assertSingleOwner(h.queue.getPlayQueue(), expected)
  assertSingleOwner(h.disk(), expected)
})

test('metadata follows a new head after moving, inserting and removing rows without changing song objects', async() => {
  const h = setup()
  const songs = original()
  await h.queue.replacePlayQueue(source, songs, songs[0].id, JSON.stringify(songs.map(song => song.id)))
  const expected = metadata(h.queue)
  const first = h.queue.getPlayQueue()[0]
  for (const change of [
    async() => h.queue.movePlayQueueItem(0, 10),
    async() => h.queue.movePlayQueueItem(5, 0),
    async() => h.queue.insertPlayQueue(0, [song('inserted')]),
    async() => h.queue.removePlayQueueItem(0),
  ]) {
    await change()
    assertSingleOwner(h.queue.getPlayQueue(), expected)
    assertSingleOwner(h.disk(), expected)
  }
  assert.equal(first.musicInfo, songs[0])
  assert.equal(first.sourceListId, source)
  assert.equal(first.queueId.includes(songs[0].id), true)
})

test('trimming played rows during continuation transfers metadata to the remaining head', async() => {
  const h = setup()
  const songs = original()
  await h.queue.replacePlayQueue(source, songs, songs[0].id, JSON.stringify(songs.map(song => song.id)))
  await h.queue.appendPlayQueue(source, Array.from({ length: 480 }, (_, index) => song('continued-' + index)))
  const oldHead = h.queue.getPlayQueue()[0]
  const expected = metadata(h.queue)
  h.state.playInfo.playIndex = h.state.playInfo.playerPlayIndex = 450
  await h.queue.appendPlayQueue(source, [song('new-1'), song('new-2')])
  assert.equal(h.queue.getPlayQueue().length, 500)
  assert.equal(h.state.playInfo.playerPlayIndex, 448)
  assertSingleOwner(h.queue.getPlayQueue(), expected)
  assertSingleOwner(h.disk(), expected)
  for (const key of metadataKeys) assert.equal(Object.hasOwn(oldHead, key), false)
})

test('clearing and replacing a queue release the previous owner and reset batch metadata', async() => {
  const h = setup()
  const songs = original()
  await h.queue.replacePlayQueue(source, songs, songs[0].id, JSON.stringify(songs.map(song => song.id)))
  const oldHead = h.queue.getPlayQueue()[0]
  await h.queue.clearPlayQueue()
  assert.equal(h.queue.getPlayQueueSourceBatchKey(), undefined)
  assert.equal(h.queue.getPlayQueueSourceFirstMusicId(), undefined)
  assert.equal(h.queue.getPlayQueueSessionId(), '')
  for (const key of metadataKeys) assert.equal(Object.hasOwn(oldHead, key), false)
  await h.queue.replacePlayQueue('library', [song('library')])
  const libraryHead = h.queue.getPlayQueue()[0]
  assert.equal(h.queue.getPlayQueueSourceBatchKey(), undefined)
  await h.queue.replacePlayQueue(source, [song('next-batch')], 'next-batch', '["next-batch"]')
  for (const key of metadataKeys) assert.equal(Object.hasOwn(libraryHead, key), false)
  assertSingleOwner(h.disk(), metadata(h.queue))
})

test('old snapshots lose duplicate non-head metadata on read and persist the repair with the next normal edit', async() => {
  const first = setup()
  const songs = original()
  await first.queue.replacePlayQueue(source, songs, songs[0].id, JSON.stringify(songs.map(song => song.id)))
  const expected = metadata(first.queue)
  const duplicate = first.disk()
  for (const row of duplicate.slice(1)) Object.assign(row, { sessionId: 'stale', sourceFirstMusicId: 'stale-first', sourceBatchKey: '["stale-batch"]' })
  const h = setup(duplicate)
  await h.queue.initPlayQueue()
  assert.equal(h.reads(), 1)
  assert.equal(h.writes(), 0, 'loading must not add a redundant startup write')
  assertSingleOwner(h.queue.getPlayQueue(), expected)
  assert.deepEqual(Array.from(h.queue.getPlayQueueMusic(), song => song.id), songs.map(song => song.id))
  await h.queue.movePlayQueueItem(0, 2)
  assert.equal(h.writes(), 1)
  assertSingleOwner(h.disk(), expected)
  await h.queue.initPlayQueue()
  assert.equal(h.reads(), 1)
})

test('legacy snapshots without metadata retain their original anchor after a head change', async() => {
  const rows = original().map((musicInfo, index) => ({ queueId: 'legacy-' + index, sourceListId: source, musicInfo }))
  const h = setup(rows)
  await h.queue.initPlayQueue()
  const expected = { sessionId: rows[0].queueId, sourceFirstMusicId: rows[0].musicInfo.id, sourceBatchKey: undefined }
  await h.queue.movePlayQueueItem(0, 2)
  assertSingleOwner(h.queue.getPlayQueue(), expected)
  assertSingleOwner(h.disk(), expected)
})

test('metadata ownership does not retain a removed queue row after clear or replacement', () => {
  const result = spawnSync(process.execPath, ['--expose-gc', '-e', `
    const { harness, song, flush, assert } = require('./tests/helpers/playback.cjs')
    ;(async() => {
      const h = await harness()
      for (const mode of ['clear', 'replace']) {
        await h.queue.replacePlayQueue('recommend', [song('old-owner')], 'old-owner', '["old-owner"]')
        const reference = new WeakRef(h.queue.getPlayQueue()[0])
        if (mode === 'clear') await h.queue.clearPlayQueue()
        else await h.queue.replacePlayQueue('new-library', [song('new-owner')])
        await flush()
        global.gc()
        assert.equal(reference.deref(), undefined, mode + ' retained the old metadata owner')
      }
    })().catch(error => { console.error(error); process.exitCode = 1 })
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 15000 })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
