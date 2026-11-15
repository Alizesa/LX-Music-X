const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load, deferred, flush } = require('./helpers/load.cjs')
const { hookHost, jsx, elements } = require('./helpers/react.cjs')

const harness = () => {
  const state = load('src/store/singer/state.ts')
  let conversions = 0
  const utils = { toNewMusicInfo: value => { conversions++; return value }, deduplicationList: values => values }
  const actions = load('src/store/singer/action.ts', { './state': state, '@/utils': utils }, { setTimeout: () => 1 })
  const saved = { ...state.createSingerRecord('s'), infoLoaded: true, songsLoaded: true, albumsLoaded: true, pages: { songs: [], albums: [] } }
  const values = new Map()
  for (const [kind, count, limit] of [['songs', 32, 50], ['albums', 4, 100]]) {
    for (let page = 1; page <= count; page++) {
      const key = `singer_s::${kind}:${page}`
      saved.pages[kind].push(key)
      values.set(key, { list: Array.from({ length: limit }, (_, index) => ({ id: `${kind}-${page}-${index}`, mid: `${kind}-${page}-${index}` })) })
    }
    saved[kind] = { list: [], total: count * limit, page: count, maxPage: count, limit }
  }
  values.set('singer_s', saved)
  const reads = []
  let read = async key => structuredClone(values.get(key) ?? null)
  let requests = 0
  const api = load('src/core/singer.ts', {
    '@/store/singer/state': state,
    '@/store/singer/action': actions,
    '@/utils': utils,
    './detailCache': { getDetailCache: key => { reads.push(key); return read(key) }, saveDetailCache() {} },
    '@/utils/musicSdk': {
      default: {
        tx: {
          singer: {
            getDetail: async() => { requests++; throw new Error('Unexpected network request') },
            getAlbums: async() => { requests++; throw new Error('Unexpected network request') },
          },
        },
      },
    },
  })
  return { api, state, actions, reads, conversions: () => conversions, requests: () => requests, setRead: value => { read = value }, values }
}

test('concurrent singer song and album consumers read 37 pages once and convert 1600 songs once', async() => {
  const h = harness(); const gate = deferred()
  h.setRead(async key => { await gate.promise; return structuredClone(h.values.get(key)) })
  const songs = h.api.getSingerDetail('s')
  const albums = h.api.getSingerAlbums('s', 1)
  await flush()
  assert.equal(h.reads.length, 1)
  gate.resolve()
  const [record, albumPage] = await Promise.all([songs, albums])
  assert.equal(record.songs.list.length, 1600)
  assert.equal(albumPage.list.length, 400)
  assert.equal(h.reads.length, 37)
  assert.equal(new Set(h.reads).size, 37)
  assert.equal(h.conversions(), 1600)
  assert.equal(h.requests(), 0)
})

test('a failed shared restore can retry and a replaced record cannot consume the old restore', async() => {
  const h = harness()
  h.setRead(async() => { throw new Error('disk unavailable') })
  const failures = await Promise.allSettled([h.api.getSingerDetail('s'), h.api.getSingerAlbums('s', 1)])
  assert.ok(failures.every(result => result.status === 'rejected'))
  const gate = deferred()
  h.setRead(async key => { await gate.promise; return structuredClone(h.values.get(key)) })
  const old = h.state.default.singers.s
  const pending = h.api.getSingerDetail('s')
  h.actions.retainSingerRecord('s')
  h.actions.releaseSingerRecord('s')
  const current = h.actions.default.getRecord('s')
  const fresh = h.api.getSingerDetail('s')
  gate.resolve()
  assert.equal(await pending, old)
  assert.equal((await fresh).songs.list.length, 1600)
  assert.equal(old.songs.list.length, 0)
  assert.equal(h.state.default.singers.s, current)
})

test('the singer pager only loads its current tab when returning to a visible screen', async() => {
  const host = hookHost(); const parent = host.frame(); const frames = [host.frame(), host.frame()]
  const calls = [0, 0]
  const common = {
    react: host.react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '@/utils/hooks/useScreenVisible': { useScreenVisible: host.visible, VisibilityBoundary: 'Boundary' },
  }
  const record = { info: { mid: 's' }, songs: { list: [], page: 1, maxPage: 1 } }
  const Songs = load('src/screens/SingerDetail/SingerSongs.tsx', {
    ...common,
    '@/components/OnlineList': { default: 'OnlineList' },
    '@/core/singer': { getSingerDetail: async() => { calls[0]++; return record } },
    '@/store/singer/state': { default: { singers: { s: record } } },
    './listAction': {},
  }).default
  const Albums = load('src/screens/SingerDetail/SingerAlbums.tsx', {
    ...common,
    '@/core/singer': { getSingerAlbums: async() => { calls[1]++; return { list: [], page: 1, maxPage: 1 } } },
    '@/store/singer/state': { default: { singers: {} } },
    '@/navigation': {},
    '@/store/common/state': {},
    './AlbumList': { default: 'AlbumList' },
  }).default
  const Screen = load('src/screens/SingerDetail/index.tsx', {
    ...common,
    'react-native': { View: 'View', TouchableOpacity: 'Button' },
    'react-native-pager-view': { default: 'Pager' },
    '@/components/PageContent': { default: 'PageContent' },
    '@/components/common/StatusBar': {},
    '@/components/player/PlayerBar': {},
    '@/components/common/Text': {},
    '@/core/common': { setComponentId() {} },
    '@/config/constant': { COMPONENT_IDS: {} },
    '@/lang': { useI18n: () => key => key },
    '@/store/theme/hook': { useTheme: () => ({}) },
    '@/utils/tools': { createStyle: value => value },
    '@/utils/pixelRatio': { scaleSizeH: value => value },
    '@/theme': { BorderWidths: {} },
    '@/store/singer/action': { retainSingerRecord() {}, releaseSingerRecord() {} },
    './Header': {},
    './SingerSongs': { default: Songs },
    './SingerAlbums': { default: Albums },
  }).default
  let tree
  const render = async() => {
    tree = host.render(parent, () => Screen({ componentId: 'screen', info: { mid: 's' } }))
    elements(tree, 'Boundary').forEach((boundary, index) => {
      const child = boundary.props.children
      if (!child) return
      frames[index].visible = parent.visible && boundary.props.visible
      host.render(frames[index], () => child.type(child.props))
    })
    await flush()
  }
  await render()
  assert.deepEqual(calls, [1, 0])
  elements(tree, 'Pager')[0].props.onPageSelected({ nativeEvent: { position: 1 } })
  await render()
  assert.deepEqual(calls, [1, 1])
  parent.visible = false
  await render()
  parent.visible = true
  await render()
  assert.deepEqual(calls, [1, 2])
  frames.forEach(frame => host.unmount(frame))
  host.unmount(parent)
})
