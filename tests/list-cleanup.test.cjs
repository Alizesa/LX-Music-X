const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const ts = require('typescript')

// Exercise the production handlers with in-memory storage; no native runtime or QQ requests.
const load = (file, mocks = {}) => {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  })
  const context = {
    exports: {},
    require: name => {
      assert.ok(Object.hasOwn(mocks, name), `Unexpected import: ${name}`)
      return mocks[name]
    },
    global: {
      i18n: { t: key => key },
      app_event: { qqMusicPlaylistsUpdated() {} },
      ...(mocks.__global ?? {}),
    },
    console: { log() {}, error() {} },
  }
  vm.runInNewContext(outputText, context, { filename: file })
  return context.exports
}
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value))
const flush = () => new Promise(resolve => setImmediate(resolve))
const legacy = load('src/utils/legacyList.ts')
const constants = load('src/config/constant.ts')
const songs = [{ id: 'tx_test' }]
const old = { id: 'userlist_old', name: 'QQ · 我喜欢', source: 'tx', sourceListId: '201', list: songs }
const custom = { id: 'userlist_custom', name: 'QQ · 我喜欢', list: songs }

test('recognize legacy origins, preserving same-name and partial-source user lists', () => {
  assert.equal(legacy.isRemovedUserList(old), true)
  assert.equal(legacy.isRemovedUserList({ ...old, name: 'Renamed', sourceListId: '201.0' }), true)
  assert.equal(legacy.isRemovedUserList({ id: 'default' }), true)
  assert.equal(legacy.isRemovedUserList({ id: 'love' }), true)
  for (const list of [custom, { ...custom, source: 'tx' }, { ...custom, sourceListId: '201' }]) {
    assert.equal(legacy.isRemovedUserList(list), false)
  }
})

test('startup removes legacy songs and metadata while protecting local music and queues', async() => {
  const keys = constants.storageDataPrefix
  const protectedIds = ['local', 'temp', 'play_queue']
  const lists = [old, custom, ...protectedIds.map(id => ({ ...old, id }))]
  const values = new Map([
    [keys.userList, lists],
    [keys.list + old.id, songs],
    [keys.list + custom.id, songs],
    [keys.listScrollPosition, { [old.id]: 42, [custom.id]: 10 }],
    [keys.listUpdateInfo, { [old.id]: { updateTime: 1 }, [custom.id]: { updateTime: 2 } }],
    ...protectedIds.map(id => [keys.list + id, songs]),
  ])
  const storage = {
    getData: async key => copy(values.get(key)),
    saveData: async(key, value) => { values.set(key, copy(value)) },
    removeData: async key => { values.delete(key) },
    removeDataMultiple: async ids => { ids.forEach(id => values.delete(id)) },
  }
  const data = load('src/utils/data.ts', {
    '@/plugins/storage': storage,
    '@/config/constant': constants,
    './legacyList': legacy,
    './common': { throttle: fn => fn },
    './nativeModules/secureStorage': {},
  })
  assert.deepEqual(copy(await data.getUserLists()), [custom])
  assert.equal(values.has(keys.list + old.id), false)
  assert.equal(values.get(keys.listScrollPosition)[old.id], undefined)
  assert.equal(values.get(keys.listUpdateInfo)[old.id], undefined)
  for (const id of [custom.id, ...protectedIds]) assert.deepEqual(values.get(keys.list + id), songs)
  assert.deepEqual(copy(await data.getUserLists()), [custom])
})

const backupHarness = (config, failSave = false) => {
  const messages = []
  const writes = []
  const created = []
  let exported
  const api = load('src/screens/Home/Views/Setting/settings/Backup/actions.ts', {
    '@/core/list': {
      getListMusics: async() => songs,
      overwriteListFull: async value => { writes.push(copy(value)) },
      createList: async value => { created.push(copy(value)) },
    },
    '@/utils': { filterMusicList: value => value, fixNewMusicInfoQuality: value => value, toNewMusicInfo: value => value },
    '@/utils/log': { log: { error() {} } },
    '@/utils/tools': {
      confirmDialog: async() => true,
      handleReadFile: async() => copy(config),
      handleSaveFile: async(_path, value) => {
        if (failSave) throw new Error('write failed')
        exported = copy(value)
      },
      toast: value => messages.push(value),
    },
    '@/store/list/state': { default: { userList: [old, custom], allList: [] } },
    '@/utils/legacyList': legacy,
  })
  return { api, messages, writes, created, getExport: () => exported }
}

test('both list formats and all-data formats reject legacy snapshots on import', async() => {
  for (const type of ['playList', 'playList_v2', 'allData', 'allData_v2']) {
    const lists = [old, { ...custom, id: 'imported' }, { id: 'love', list: songs }]
    const h = backupHarness({ type, data: lists, playList: lists })
    h.api.handleImportList('mock.lxmc')
    await flush()
    assert.deepEqual(h.writes[0].userList.map(list => list.id), [custom.id, 'imported'], type)
  }
})

test('single-list imports skip legacy snapshots and explain the skip', async() => {
  for (const type of ['playListPart', 'playListPart_v2']) {
    const h = backupHarness({ type, data: old })
    h.api.handleImportList('mock.lxmc')
    await flush()
    assert.equal(h.created.length, 0)
    assert.ok(h.messages.includes('setting_backup_part_import_list_tip_removed'))
    assert.ok(!h.messages.includes('setting_backup_part_import_list_tip_success'))
  }
})

test('exports exclude legacy snapshots and propagate write failures', async() => {
  const h = backupHarness()
  h.api.handleExportList('mock')
  await flush()
  assert.deepEqual(h.getExport().data.map(list => list.id), [custom.id])
  const failed = backupHarness(null, true)
  failed.api.handleExportList('mock')
  await flush()
  assert.ok(!failed.messages.includes('setting_backup_part_export_list_tip_success'))
  assert.ok(failed.messages.some(message => message.startsWith('setting_backup_part_export_list_tip_failed')))
})

test('search collection uses the QQ account and never creates a local list', async() => {
  const requests = []
  let cached = []
  const api = load('src/screens/SonglistDetail/listAction.ts', {
    '@/core/list': { createList() { assert.fail('Local snapshot must not be created') } },
    '@/core/player/player': {},
    '@/core/songlist': { getListDetailAll() { assert.fail('Collection must not fetch all songs') } },
    '@/config/constant': constants,
    '@/store/list/state': {},
    '@/core/qqMusic': {
      getQQMusicSession: async() => ({ cookie: 'x' }),
      getQQMusicPlaylists: async() => cached,
      getQQMusicUin: cookie => cookie,
      QQMusicSessionExpiredError: class extends Error {},
    },
    '@/core/qqMusicFavorite': { toggleQQMusicPlaylistCollected: async(...args) => { requests.push(copy(args)); return true } },
    '@/utils/data': { getQQMusicPlaylistsCache: async() => cached, saveQQMusicPlaylistsCache: async() => {} },
    '@/utils/tools': { toast() {} },
    '@/store/songlist/state': { default: { listDetailInfo: { id: '12345', source: 'tx', total: 50, info: { img: 'cover' } } } },
  })
  assert.equal(await api.handleCollect('12345', 'tx', 'Playlist'), true)
  assert.deepEqual(requests, [[{ id: '12345', name: 'Playlist', cover: 'cover', trackCount: 50 }, true]])
  assert.equal(await api.handleCollect('12345', 'wy', 'Playlist'), false)
  cached = [{ id: '12345', subscribed: false }]
  assert.equal(await api.handleCollect('12345', 'tx', 'Playlist'), false)
  cached = [{ id: '12345', subscribed: true }]
  assert.equal(await api.handleCollect('12345', 'tx', 'Playlist'), true)
  assert.equal(requests.length, 1)
})

const collectHarness = ({ session, playlists, notified = () => {} }) => {
  const requests = []
  return {
    api: load('src/screens/SonglistDetail/listAction.ts', {
      '@/core/list': { createList() { assert.fail('Local snapshot must not be created') } },
      '@/core/player/player': {},
      '@/core/songlist': { getListDetailAll() { assert.fail('Collection must not fetch all songs') } },
      '@/config/constant': constants,
      '@/store/list/state': {},
      '@/core/qqMusic': {
        getQQMusicSession: session,
        getQQMusicPlaylists: playlists,
        getQQMusicUin: cookie => cookie,
        QQMusicSessionExpiredError: class extends Error {},
      },
      '@/core/qqMusicFavorite': { toggleQQMusicPlaylistCollected: async(...args) => { requests.push(copy(args)); return true } },
      '@/utils/data': { saveQQMusicPlaylistsCache: async() => {} },
      '@/utils/tools': { toast() {} },
      '@/store/songlist/state': { default: { listDetailInfo: { id: '12345', source: 'tx', total: 50, info: {} } } },
      __global: { app_event: { qqMusicPlaylistsUpdated: notified } },
    }),
    requests,
  }
}

test('collection aborts if the account changes during the refresh request', async() => {
  let calls = 0
  const h = collectHarness({
    session: async() => ({ cookie: ++calls === 1 ? 'account-a' : 'account-b' }),
    playlists: async() => [{ id: '12345', subscribed: true }],
  })
  assert.equal(await h.api.handleCollect('12345', 'tx', 'Playlist'), false)
  assert.equal(h.requests.length, 0)
})

test('collection refreshes the cache and notifies the mine page before deciding', async() => {
  let fetches = 0
  let notifications = 0
  const h = collectHarness({
    session: async() => ({ cookie: 'account-a' }),
    playlists: async() => {
      fetches++
      return [{ id: '12345', subscribed: true }]
    },
    notified: () => { notifications++ },
  })
  assert.equal(await h.api.handleCollect('12345', 'tx', 'Playlist'), true)
  assert.equal(fetches, 1)
  assert.equal(notifications, 1)
  assert.equal(h.requests.length, 0)
})
