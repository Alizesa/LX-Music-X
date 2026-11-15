const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load } = require('./helpers/load.cjs')
const { hookHost } = require('./helpers/react.cjs')

test('a released songlist restores three pages from disk and continues from source page four', async() => {
  const state = load('src/store/songlist/state.ts')
  const actions = load('src/store/songlist/action.ts', { './state': state })
  const rows = new Map(); let index = {}; const requests = []; const reads = []
  const cache = load('src/core/detailCache.ts', {
    '@/utils/data': {
      getBrowseDetailCache: async key => { reads.push(key); return rows.has(key) ? JSON.parse(rows.get(key)) : null },
      saveBrowseDetailCache: async(key, value) => { rows.set(key, JSON.stringify(value)) },
      getBrowseDetailCacheIndex: async() => ({ ...index }),
      saveBrowseDetailCacheIndex: async value => { index = { ...value } },
      removeBrowseDetailCaches: async keys => { for (const key of rows.keys()) if (keys.some(group => key === group || key.startsWith(group + '::'))) rows.delete(key) },
    },
  })
  const api = load('src/core/songlist.ts', {
    '@/store/songlist/action': actions,
    '@/utils': { toNewMusicInfo: value => value, deduplicationList: value => value },
    '@/utils/musicSdk': {
      default: {
        kw: {
          songList: {
            getListDetail: async(id, page) => {
              requests.push(page)
              return { id, source: 'kw', list: Array.from({ length: 30 }, (_, i) => ({ id: `${page}-${i}` })), total: 300, limit: 30, info: {} }
            },
          },
        },
      },
    },
    './detailCache': cache,
  })
  api.retainSonglistDetail('kw', 's')
  for (let page = 1; page <= 3; page++) await api.getListDetail('s', 'kw', page)
  await cache.getDetailCache('sdetail__kw__s')
  api.releaseSonglistDetail('kw', 's')
  api.retainSonglistDetail('kw', 's')
  reads.length = 0
  const restored = []
  for (let page = 1; page <= 3; page++) restored.push(...(await api.getListDetail('s', 'kw', page)).list)
  assert.equal(restored.length, 90)
  assert.deepEqual(requests, [1, 2, 3])
  assert.equal(reads.length, 4)
  const next = await api.getListDetail('s', 'kw', 4)
  assert.equal(next.list[0].id, '4-0')
  assert.deepEqual(requests, [1, 2, 3, 4])
  api.releaseSonglistDetail('kw', 's')
})

test('hiding all timeout UI consumers removes its ticker while retaining the background exit timer', () => {
  const host = hookHost(); const frame = host.frame()
  const timers = new Map(); const background = new Map(); let next = 0; let now = 0; let exits = 0
  const api = load('src/core/player/timeoutExit.ts', {
    react: host.react,
    'react-native-background-timer': {
      default: {
        setTimeout: fn => { const id = ++next; background.set(id, fn); return id },
        clearTimeout: id => background.delete(id),
      },
    },
    '@/core/common': { exitApp: () => exits++ },
    '@/store/player/state': { default: { isPlay: false } },
    '@/store/setting/state': { default: { setting: {} } },
    '@/utils/hooks/useScreenVisible': { useScreenVisible: host.visible },
  }, {
    global: { lx: { isPlayedStop: false } },
    performance: { now: () => now },
    setInterval: fn => { const id = ++next; timers.set(id, fn); return id },
    clearInterval: id => timers.delete(id),
  })
  host.render(frame, api.useTimeoutExitTimeInfo)
  api.startTimeoutExit(60)
  assert.equal(timers.size, 1)
  assert.equal(background.size, 1)
  frame.visible = false
  host.render(frame, api.useTimeoutExitTimeInfo)
  assert.equal(timers.size, 0)
  assert.equal(background.size, 1)
  now = 60_000
  background.values().next().value()
  assert.equal(exits, 1)
  assert.equal(background.size, 0)
  host.unmount(frame)
})
