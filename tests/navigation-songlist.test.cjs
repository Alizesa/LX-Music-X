const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const ts = require('typescript')

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
  }
  vm.runInNewContext(outputText, context, { filename: file })
  return context.exports
}

const constants = load('src/config/constant.ts')
const navigationHarness = savedId => {
  const state = { navActiveId: 'nav_mine' }
  const writes = []
  const data = load('src/utils/data.ts', {
    '@/plugins/storage': { getData: async() => ({ id: savedId }) },
    '@/config/constant': constants,
    './legacyList': {},
    './common': { throttle: fn => fn },
    './nativeModules/secureStorage': {},
  })
  const api = load('src/core/common.ts', {
    './desktopLyric': {},
    '@/utils/nativeModules/utils': {},
    '@/plugins/player/utils': {},
    '@/config/setting': {},
    '@/lang/i18n': {},
    '@/store/setting/action': { default: {} },
    '@/store/setting/state': { default: {} },
    '@/store/common/action': {
      default: { setNavActiveId: id => { state.navActiveId = id } },
    },
    '@/store/common/state': { default: state },
    '@/config/constant': constants,
    '@/plugins/storage': {},
    '@/utils/common': { throttle: fn => fn },
    '@/utils/data': { saveViewPrevState: value => writes.push(value.id) },
    '@/navigation': {},
    '@/utils/nativeModules/lyricDesktop': {},
  })
  return { state, writes, data, api }
}

test('restoring removed or unknown page IDs returns to a current home tab', async() => {
  for (const id of [
    'nav_search', 'nav_songlist', 'nav_top', 'nav_love', 'nav_qq',
    'nav_download', 'nav_setting', 'nav_history', 'unknown_page',
  ]) {
    const h = navigationHarness(id)
    const restored = await h.data.getViewPrevState()
    h.api.setNavActiveId(restored.id)
    assert.equal(h.state.navActiveId, 'nav_home', id)
    assert.deepEqual(h.writes, ['nav_home'], id)
  }
})

test('current tabs remain selectable and selecting the active tab does not persist again', () => {
  const h = navigationHarness('nav_mine')
  h.api.setNavActiveId('nav_mine')
  assert.deepEqual(h.writes, [])
  h.api.setNavActiveId('nav_home')
  h.api.setNavActiveId('nav_home')
  h.api.setNavActiveId('nav_mine')
  assert.equal(h.state.navActiveId, 'nav_mine')
  assert.deepEqual(h.writes, ['nav_home', 'nav_mine'])
})

const sources = ['kw', 'kg', 'tx', 'wy', 'mg']
const ids = list => Array.from(list, info => info.id)
const expectedIds = (id, start = 1, end = 75) => Array.from({ length: end - start + 1 }, (_, index) => `${id}_${start + index}`)
const songlistHarness = (beforeRequest = () => {}) => {
  const requests = []
  const sdk = Object.fromEntries(sources.map(source => [source, {
    songList: {
      getListDetail: async(id, page) => {
        const request = { source, id, page }
        requests.push(request)
        await beforeRequest(request)
        const list = expectedIds(id).map(songId => ({ id: songId, source }))
        return {
          list: list.slice((page - 1) * 50, page * 50),
          total: list.length,
          limit: 50,
          page,
          source,
          info: { name: id },
        }
      },
    },
  }]))
  const api = load('src/core/songlist.ts', {
    '@/store/songlist/action': { default: {} },
    '@/utils': {
      toNewMusicInfo: info => info,
      deduplicationList: list => [...new Map(list.map(info => [info.id, info])).values()],
    },
    '@/utils/musicSdk': { default: sdk },
  })
  return { api, requests }
}

for (const source of sources) {
  test(`${source} playlist details preserve pagination and reuse complete cached songs`, async() => {
    const h = songlistHarness()
    const id = `${source}_playlist`
    const thirdPage = await h.api.getListDetail(id, source, 3)
    assert.deepEqual(ids(thirdPage.list), expectedIds(id, 61, 75))
    assert.equal(thirdPage.total, 75)
    assert.equal(thirdPage.limit, 30)
    assert.deepEqual(h.requests, [
      { source, id, page: 1 },
      { source, id, page: 2 },
    ])
    const all = await h.api.getListDetailAll(source, id)
    assert.deepEqual(ids(all), expectedIds(id))
    await h.api.getListDetail(id, source, 3)
    assert.equal(h.requests.length, 2)
  })
}

test('releasing idle playlist caches preserves the displayed playlist until it is released', async() => {
  const h = songlistHarness()
  h.api.retainSonglistDetail('tx', 'displayed')
  await h.api.getListDetail('displayed', 'tx', 1)
  await h.api.getListDetail('idle', 'tx', 1)
  h.api.releaseIdleSonglistCaches()
  await h.api.getListDetail('displayed', 'tx', 1)
  assert.equal(h.requests.length, 2)
  await h.api.getListDetail('idle', 'tx', 1)
  assert.equal(h.requests.length, 3)
  h.api.releaseSonglistDetail('tx', 'displayed')
  h.api.releaseIdleSonglistCaches()
  await h.api.getListDetail('displayed', 'tx', 1)
  assert.equal(h.requests.length, 4)
})

test('releasing idle caches during a detail request preserves the pending result', async() => {
  let finish
  let started
  const blocked = new Promise(resolve => { finish = resolve })
  const entered = new Promise(resolve => { started = resolve })
  const h = songlistHarness(async() => {
    started()
    await blocked
  })
  const pending = h.api.getListDetail('loading', 'tx', 1)
  await entered
  h.api.releaseIdleSonglistCaches()
  finish()
  const result = await pending
  assert.deepEqual(ids(result.list), expectedIds('loading', 1, 30))
  await h.api.getListDetail('loading', 'tx', 1)
  assert.equal(h.requests.length, 1)
})

test('failed pagination can retry and explicit refresh fetches fresh playlist data', async() => {
  let fail = true
  const h = songlistHarness(({ page }) => {
    if (page == 2 && fail) {
      fail = false
      throw new Error('temporary failure')
    }
  })
  await assert.rejects(h.api.getListDetail('retry', 'tx', 3), /temporary failure/)
  const result = await h.api.getListDetail('retry', 'tx', 3)
  assert.deepEqual(ids(result.list), expectedIds('retry', 61, 75))
  assert.deepEqual(h.requests.map(request => request.page), [1, 2, 2])
  await h.api.getListDetailAll('tx', 'retry', true)
  assert.deepEqual(h.requests.map(request => request.page), [1, 2, 2, 1, 2])
})

test('two consumers of the same playlist retain its cache until both release it', async() => {
  const h = songlistHarness()
  h.api.retainSonglistDetail('tx', 'shared')
  h.api.retainSonglistDetail('tx', 'shared')
  await h.api.getListDetail('shared', 'tx', 1)
  h.api.releaseSonglistDetail('tx', 'shared')
  h.api.releaseIdleSonglistCaches()
  await h.api.getListDetail('shared', 'tx', 1)
  assert.equal(h.requests.length, 1)
  h.api.releaseSonglistDetail('tx', 'shared')
  h.api.releaseIdleSonglistCaches()
  await h.api.getListDetail('shared', 'tx', 1)
  assert.equal(h.requests.length, 2)
})

test('concurrent UI and full-playlist reads share source pages without corrupting the first page', async() => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const h = songlistHarness(async() => gate)
  const first = h.api.getListDetail('shared', 'tx', 1)
  const all = h.api.getListDetailAll('tx', 'shared')
  await new Promise(resolve => setImmediate(resolve))
  release()
  assert.deepEqual(ids((await first).list), expectedIds('shared', 1, 30))
  assert.deepEqual(ids(await all), expectedIds('shared'))
  assert.deepEqual(h.requests.map(request => request.page), [1, 2])
})

test('cache pressure cannot evict a full-playlist load between its source pages', async() => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const h = songlistHarness(async({ page }) => { if (page === 1) await gate })
  const pending = Array.from({ length: 10 }, (_, i) => h.api.getListDetailAll('tx', `list-${i}`))
  await new Promise(resolve => setImmediate(resolve))
  h.api.releaseIdleSonglistCaches()
  release()
  const lists = await Promise.all(pending)
  lists.forEach((list, index) => { assert.deepEqual(ids(list), expectedIds(`list-${index}`)) })
  assert.equal(h.requests.length, 20)
})
