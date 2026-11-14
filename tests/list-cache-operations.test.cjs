const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load, deferred, flush } = require('./helpers/load.cjs')

const copy = value => JSON.parse(JSON.stringify(value))
const harness = () => {
  const disk = new Map()
  const removed = []
  const timers = new Set()
  const player = { playInfo: {}, playMusicInfo: {} }
  const globals = {
    global: { lx: {}, app_event: { myListMusicUpdate() {} } },
    setImmediate,
    setTimeout: fn => { timers.add(fn); return fn },
  }
  const data = {
    getUserLists: async() => [],
    getListMusics: async id => copy(disk.get(id) ?? []),
    saveUserList: async() => {},
    saveListMusics: async lists => {
      for (const { id, musics } of lists) {
        assert.ok(Array.isArray(musics), `missing data for ${id}`)
        disk.set(id, copy(musics))
      }
    },
    removeListMusics: async ids => { for (const id of ids) { removed.push(id); disk.delete(id) } },
    overwriteListPosition() {},
    overwriteListUpdateInfo() {},
    removeListPosition() {},
    removeListUpdateInfo() {},
  }
  const constants = { LIST_IDS: { LOCAL: 'local', TEMP: 'temp' } }
  const index = { syncLocalMatchIndexWithList: async() => {}, markLocalMatchIndexDirty: async() => {}, rebuildLocalMatchIndexFromList: async() => {} }
  const lists = load('src/utils/listManage.ts', {
    '@/utils/data': data,
    '@/utils/common': { arrPush: (a, b) => a.push(...b), arrUnshift: (a, b) => a.unshift(...b) },
    '@/utils/localMatchIndex': index,
    '@/config/constant': constants,
    '@/store/player/state': { default: player },
    '@/core/player/playQueue': { isPlayQueueFromList: () => false },
  }, globals)
  const { ListEvent } = load('src/event/listEvent.ts', {
    './Event': load('src/event/Event.ts', {}, globals),
    '@/utils/data': data,
    '@/utils/localMatchIndex': index,
    '@/utils/listManage': lists,
    '@/config/constant': constants,
    '@/core/list': { setUserList() {} },
  }, globals)
  const prune = () => { for (const timer of [...timers]) { timers.delete(timer); timer() } }
  return { disk, data, lists, events: new ListEvent(), removed, player, prune }
}
const song = id => ({ id })

test('import survives ordinary, background and queue eviction at every pending save', async() => {
  const h = harness()
  h.lists.setUserLists([{ id: 'a' }, { id: 'removed' }])
  h.disk.set('a', [song('old')])
  h.disk.set('removed', [song('old')])
  h.disk.set('local', [song('local')])
  const save = h.data.saveListMusics
  h.data.saveListMusics = async lists => {
    await flush()
    h.prune()
    h.lists.releaseIdleListCaches(true)
    h.lists.releaseIdleListCaches()
    await save(lists)
  }
  h.data.saveUserList = async() => {
    await flush()
    h.lists.releaseIdleListCaches(true)
  }
  await h.events.list_data_overwrite({ userList: ['a', 'b', 'c'].map(id => ({ id, list: [song(id)] })) })
  assert.deepEqual(h.removed, ['removed'])
  for (const id of ['a', 'b', 'c', 'local']) assert.deepEqual(h.disk.get(id), [song(id)])
  h.lists.releaseIdleListCaches(true)
  assert.equal(h.lists.allMusicList.size, 0)
})

test('moving songs protects both lists while loading and persisting', async() => {
  const h = harness()
  h.disk.set('a', [song('move')])
  h.disk.set('b', [song('keep')])
  const read = h.data.getListMusics
  h.data.getListMusics = async id => {
    h.lists.releaseIdleListCaches(true)
    await flush()
    return read(id)
  }
  const save = h.data.saveListMusics
  h.data.saveListMusics = async lists => { h.lists.releaseIdleListCaches(true); await save(lists) }
  await h.events.list_music_move('a', 'b', [song('move')], 'bottom')
  assert.deepEqual(h.disk.get('a'), [])
  assert.deepEqual(h.disk.get('b'), [song('keep'), song('move')])
})

test('pressure can release the newest oversized idle list but protects playback and operations', async() => {
  const h = harness()
  h.lists.setMusicList('large', Array.from({ length: 20000 }, (_, i) => song(String(i))))
  h.prune()
  assert.equal(h.lists.allMusicList.has('large'), true)
  const gate = deferred()
  const operation = h.lists.withListCacheProtection(['large'], async() => gate.promise)
  h.lists.releaseIdleListCaches(true)
  assert.equal(h.lists.allMusicList.has('large'), true)
  gate.resolve()
  await operation
  assert.equal(h.lists.allMusicList.has('large'), false)
  h.lists.setMusicList('large', [song('playing')])
  h.player.playInfo.playerListId = 'large'
  h.lists.releaseIdleListCaches(true)
  assert.equal(h.lists.allMusicList.has('large'), true)
  h.player.playInfo.playerListId = ''
  h.lists.releaseIdleListCaches(true)
  assert.equal(h.lists.allMusicList.has('large'), false)
})

test('a failed operation releases protection and subsequent edits can still commit', async() => {
  const h = harness()
  const save = h.data.saveListMusics
  h.data.saveListMusics = async() => { throw new Error('disk full') }
  await assert.rejects(h.events.list_music_overwrite('a', [song('failed')]), /disk full/)
  h.lists.releaseIdleListCaches(true)
  assert.equal(h.lists.allMusicList.has('a'), false)
  h.data.saveListMusics = save
  await h.events.list_music_overwrite('a', [song('new')])
  assert.deepEqual(h.disk.get('a'), [song('new')])
})

test('an edit queued behind import sees the imported snapshot', async() => {
  const h = harness()
  const gate = deferred()
  h.data.saveUserList = async() => gate.promise
  const importing = h.events.list_data_overwrite({ userList: [{ id: 'a', list: [song('imported')] }] })
  const adding = h.events.list_music_add('a', [song('added')], 'bottom')
  await flush()
  gate.resolve()
  await Promise.all([importing, adding])
  assert.deepEqual(h.disk.get('a'), [song('imported'), song('added')])
})

test('only explicitly supplied built-in lists are overwritten', async() => {
  const h = harness()
  h.lists.setMusicList('local', [song('local')])
  h.disk.set('local', [song('local')])
  await h.events.list_data_overwrite({ userList: [], tempList: [song('temp')] })
  assert.deepEqual(h.disk.get('local'), [song('local')])
  assert.deepEqual(h.disk.get('temp'), [song('temp')])
})

test('a cold read finishing after deletion cannot resurrect the removed cache', async() => {
  const h = harness(); const gate = deferred()
  h.data.getListMusics = async() => gate.promise
  const reading = h.lists.getListMusics('removed')
  h.lists.removeMusicList('removed')
  gate.resolve([song('old')])
  await reading
  assert.equal(h.lists.allMusicList.has('removed'), false)
})

test('an obsolete cold read cannot replace a new read or remove its in-flight entry', async() => {
  const h = harness(); const old = deferred(); const fresh = deferred()
  h.data.getListMusics = async() => old.promise
  const oldRead = h.lists.getListMusics('a')
  h.lists.removeMusicList('a')
  h.data.getListMusics = async() => fresh.promise
  const newRead = h.lists.getListMusics('a')
  old.resolve([song('old')])
  await oldRead
  assert.equal(h.lists.allMusicList.has('a'), false)
  fresh.resolve([song('new')])
  await newRead
  assert.deepEqual(h.lists.allMusicList.get('a'), [song('new')])
})
