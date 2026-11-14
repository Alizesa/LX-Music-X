const { test } = require('node:test')
const { spawnSync } = require('node:child_process')
const { harness, song, constants, assert, flush } = require('./helpers/playback.cjs')

test('queue replacement preserves matching played IDs using current song objects and releases removed songs', async() => {
  const h = await harness({ setting: { 'player.togglePlayMethod': 'random' } })
  await h.player.playList('library', 0)
  await h.player.playList(constants.LIST_IDS.PLAY_QUEUE, 1)
  const replacement = { ...song('B'), name: 'Updated B' }
  await h.queue.replacePlayQueue('another-list', [replacement, song('D')])
  assert.deepEqual(Array.from(h.state.playedList, item => item.musicInfo.id), ['B'])
  assert.equal(h.state.playedList[0].musicInfo, replacement)
  await h.player.clearQueue()
  assert.equal(h.state.playedList.length, 0)
})

test('random replay in the same queue still honors the automatic-clean setting', async() => {
  const h = await harness({ setting: { 'player.togglePlayMethod': 'random', 'player.isAutoCleanPlayedList': false } })
  await h.player.playList('library', 0)
  await h.player.playList(constants.LIST_IDS.PLAY_QUEUE, 1)
  assert.deepEqual(Array.from(h.state.playedList, item => item.musicInfo.id), ['A', 'B'])
  await h.player.playPrev()
  assert.equal(h.state.playMusicInfo.musicInfo.id, 'A')
  await h.player.playNext()
  assert.equal(h.state.playMusicInfo.musicInfo.id, 'B')
  h.setting['player.isAutoCleanPlayedList'] = true
  await h.player.playList(constants.LIST_IDS.PLAY_QUEUE, 2)
  assert.deepEqual(Array.from(h.state.playedList, item => item.musicInfo.id), ['C'])
})

test('recommendation trimming and explicit row removal also prune obsolete random-history objects', async() => {
  const h = await harness()
  const songs = Array.from({ length: 500 }, (_, i) => song(`song-${i}`))
  await h.queue.replacePlayQueue('recommend', songs)
  h.state.playInfo.playerListId = constants.LIST_IDS.PLAY_QUEUE
  h.state.playInfo.playIndex = h.state.playInfo.playerPlayIndex = 450
  for (const musicInfo of songs) h.played.addPlayedList({ musicInfo, listId: constants.LIST_IDS.PLAY_QUEUE, isTempPlay: false })
  await flush()
  await h.queue.appendPlayQueue('recommend', [song('next-1'), song('next-2')])
  assert.equal(h.state.playedList.length, 498)
  assert.equal(h.state.playedList[0].musicInfo.id, 'song-2')
  await h.queue.removePlayQueueItem(0)
  assert.equal(h.state.playedList[0].musicInfo.id, 'song-3')
})

test('obsolete songs become collectible after repeated random queue replacement and clearing', () => {
  const result = spawnSync(process.execPath, ['--expose-gc', '-e', `
    const { harness, song, flush, assert } = require('./tests/helpers/playback.cjs')
    ;(async () => {
      const h = await harness({ setting: { 'player.togglePlayMethod': 'random', 'player.isAutoCleanPlayedList': false } })
      let reference
      for (let index = 0; index < 1000; index++) {
        h.lists.library = [song('old-' + index)]
        if (!index) reference = new WeakRef(h.lists.library[0])
        await h.player.playList('library', 0)
        if (index % 25 === 0) await flush()
      }
      h.lists.library = []
      await h.player.clearQueue()
      await flush()
      assert.equal(h.state.playedList.length, 0)
      for (let index = 0; index < 10; index++) { await flush(); global.gc() }
      assert.equal(reference.deref(), undefined)
    })().catch(error => { console.error(error); process.exitCode = 1 })
  `], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('bulk queue insertion uses a linear ID lookup and deduplicates the incoming batch in order', async t => {
  const h = await harness()
  let reads = 0
  const existing = Array.from({ length: 1000 }, (_, i) => ({ ...song(`old-${i}`), get id() { reads++; return `old-${i}` } }))
  await h.queue.replacePlayQueue('library', existing)
  reads = 0
  const incoming = Array.from({ length: 1000 }, (_, i) => song(`new-${i}`))
  const added = await h.player.addToPlayQueue([...incoming, incoming[0], incoming[999], song('old-0')])
  assert.equal(added, 1000)
  assert.ok(reads <= 3000, `read existing IDs ${reads} times`)
  t.diagnostic(`metrics: existing_queue=1000, incoming_unique=1000, existing_id_reads=${reads}`)
  assert.deepEqual(Array.from(h.queue.getPlayQueue().slice(1000), row => row.musicInfo.id), incoming.map(item => item.id))
})

test('deduplicated queue insertion keeps the current track, source and insertion position', async() => {
  const h = await harness()
  await h.player.playList('library', 1)
  const source = h.queue.getPlayQueue()[0].sourceListId
  assert.equal(await h.player.addToPlayQueue([song('X'), song('B'), song('X'), song('Y')]), 2)
  assert.deepEqual(Array.from(h.queue.getPlayQueue(), row => row.musicInfo.id), ['A', 'B', 'X', 'Y', 'C'])
  assert.equal(h.state.playMusicInfo.musicInfo.id, 'B')
  assert.equal(h.state.playInfo.playerPlayIndex, 1)
  assert.ok(h.queue.getPlayQueue().every(row => row.sourceListId === source))
})
