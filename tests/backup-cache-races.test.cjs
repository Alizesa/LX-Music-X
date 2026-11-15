const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load, deferred, flush } = require('./helpers/load.cjs')

test('a failed migration fallback cannot return legacy songs after its cache generation is cleared', async() => {
  const gate = deferred(); let reads = 0
  const legacy = { list: { songs: [{ id: 'obsolete' }], savedAt: 1 } }
  const api = load('src/core/qqMusicPlaylistSongsCache.ts', {
    '@/utils/data': {
      getQQMusicPlaylistSongsCache: async() => ++reads === 1 ? legacy : gate.promise,
      getQQMusicPlaylistSongsIndex: async() => { throw new Error('migration unavailable') },
      removeQQMusicPlaylistSongsIndexAndLegacy: async() => {},
      getQQMusicPlaylistSongsItemKeys: async() => [],
    },
  })
  const pending = api.getCachedPlaylistSongs('list')
  await flush()
  assert.equal(reads, 2)
  await api.clearPlaylistSongsCache()
  gate.resolve(legacy)
  assert.equal(await pending, null)
})

test('concurrent backup file writes have independent intermediate paths and preserve their contents', async() => {
  const files = new Map(); const outputs = new Map(); const compressions = []; const removed = []
  const tools = load('src/utils/tools.ts', {
    'react-native': { Platform: { OS: 'android', constants: { Release: '1' } } },
    '@react-native-clipboard/clipboard': {},
    '@/config/constant': {},
    '@/utils/fs': {
      temporaryDirectoryPath: '/cache',
      writeFile: async(path, data) => { files.set(path, data) },
      gzipFile: async(input, output) => {
        const gate = deferred(); compressions.push({ input, output, gate })
        await gate.promise
        assert.ok(files.has(input))
        outputs.set(output, files.get(input))
      },
      unlink: async path => { files.delete(path); removed.push(path) },
    },
    '@/utils/nativeModules/utils': {},
    '@/utils/musicSdk': {},
    '@/plugins/storage': {},
    'react-native-background-timer': {},
    './pixelRatio': {},
    './index': {},
    'react-native-quick-md5': {},
    '@/utils/windowSizeTools': {},
    './scheduledTask': {},
  })
  const a = tools.handleSaveFile('/a.lxmc', { value: 'A' })
  const b = tools.handleSaveFile('/b.lxmc', { value: 'B' })
  await flush()
  assert.equal(new Set(compressions.map(item => item.input)).size, 2)
  compressions[0].gate.resolve()
  await a
  compressions[1].gate.resolve()
  await b
  assert.equal(JSON.parse(outputs.get('/a.lxmc')).value, 'A')
  assert.equal(JSON.parse(outputs.get('/b.lxmc')).value, 'B')
  assert.equal(files.size, 0)
  assert.equal(removed.length, 2)
})

test('queued exports only read list data when their preceding export has finished, including failure', async() => {
  const gate = deferred(); const written = []; let reads = 0
  const api = load('src/screens/Home/Views/Setting/settings/Backup/actions.ts', {
    '@/core/list': { getListMusics: async() => { reads++; if (reads === 1) await gate.promise; return [{ id: 'song' }] } },
    '@/utils': {},
    '@/utils/log': { log: { error() {} } },
    '@/utils/tools': { toast() {}, handleSaveFile: async path => { written.push(path); if (written.length === 1) throw new Error('write failed') } },
    '@/store/list/state': { default: { userList: [{ id: 'local-list' }] } },
    '@/utils/legacyList': { isRemovedUserList: () => false },
  }, { global: { i18n: { t: value => value } } })
  const first = api.handleExportList('/a')
  const second = api.handleExportList('/b')
  await flush()
  assert.equal(reads, 1)
  assert.equal(written.length, 0)
  gate.resolve()
  await Promise.all([first, second])
  assert.equal(reads, 2)
  assert.deepEqual(written, ['/a/lx_list.lxmc', '/b/lx_list.lxmc'])
})
