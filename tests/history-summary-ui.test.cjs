const assert = require('node:assert/strict')
const { test } = require('node:test')
const { EventEmitter } = require('node:events')
const { load, deferred, flush } = require('./helpers/load.cjs')
const { hookHost, jsx, elements } = require('./helpers/react.cjs')
const { harness, summaryKey } = require('./helpers/history-summary.cjs')

test('recommendations consume a compact history seed without loading the 300-song body', async() => {
  const history = harness([[summaryKey, JSON.stringify({ v: 1, count: 300, qqSeed: { id: '42', name: 'Seed title' } })]])
  const host = hookHost(); const frame = host.frame(); const events = new EventEmitter(); const requests = []
  const session = { cookie: 'A', generation: 1, user: null }
  const Component = load('src/screens/Home/Views/Recommend/index.tsx', {
    react: host.react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { View: 'View', ScrollView: 'ScrollView', RefreshControl: 'RefreshControl', TouchableOpacity: 'TouchableOpacity' },
    '@/components/common/Text': { default: 'Text' },
    '@/components/common/Image': {},
    '@/components/common/ImageBackground': {},
    '@/components/common/IconAction': {},
    '@/components/HorizontalScrollHost': { default: 'View', hasNativeHorizontalScrollHost: true },
    '@/components/QQMusicLoginModal': {},
    '@/store/theme/hook': { useTheme: () => ({}) },
    '@/utils/hooks': { useTabletLayout: () => ({ isWide: false, contentWidth: 400 }) },
    '@/utils/tools': { createStyle: value => value, toMD5: String },
    '@/config/constant': {},
    '@/core/homePagerScroll': { setHomePagerHorizontalScroll() {} },
    '@/core/list': {},
    '@/core/player/player': {},
    '@/core/qqMusicHome': {},
    '@/core/qqMusicRecommend': {},
    '@/core/qqMusicDailyPosition': {},
    '@/navigation': {},
    '@/store/common/state': {},
    '@/core/qqMusic': {
      getQQMusicSession: async() => session,
      isQQMusicSessionCurrent: owner => owner === session,
      getQQMusicSimilarSongs: async(cookie, id) => { requests.push([cookie, id]); return { title: '', songs: [{ id: 'similar', name: 'Similar song', meta: {} }] } },
    },
    '@/utils/data': {
      getPlayHistory: async() => { throw new Error('the history body is unnecessary') },
      getPlayHistoryQQSeed: history.api.getPlayHistoryQQSeed,
      getQQMusicRefreshDay: async() => '',
      getQQMusicDailyPlaylistCache: async() => [],
      getQQMusicDailyRecommendCache: async() => [],
      getQQMusicHeartRadarCache: async() => [],
      getQQMusicRecommendPlaylistsCache: async() => null,
    },
    '@/lang': { useI18n: () => (key, params) => key === 'home_similar_title' ? `Similar: ${params.name}` : key },
    '@/utils/hooks/useScreenVisible': { useScreenVisible: host.visible },
    '@/core/detailCache': { getDetailCache: async() => null, saveDetailCache() {} },
  }, { global: { app_event: events, list_event: new EventEmitter() } }).default
  let tree
  for (let index = 0; index < 4; index++) { tree = host.render(frame, Component); await flush() }
  assert.deepEqual(requests, [['A', '42']])
  assert.ok(elements(tree, 'Text').some(node => node.props.children === 'Similar: Seed title'))
  assert.deepEqual(history.reads, [summaryKey])
  host.unmount(frame)
})

test('Mine uses the count getter and an initial late count cannot override a history update', async() => {
  const host = hookHost(); const frame = host.frame(); const events = new EventEmitter(); const gate = deferred()
  let reads = 0
  const Component = load('src/screens/Home/Views/Mine/index.tsx', {
    react: host.react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': { View: 'View', SectionList: 'SectionList', RefreshControl: 'RefreshControl', TouchableOpacity: 'TouchableOpacity' },
    '@/components/common/Text': { default: 'Text' },
    '@/components/common/Icon': {},
    '@/components/common/Image': {},
    '@/components/QQMusicLoginModal': {},
    '@/components/QQMusicPhoneLoginModal': {},
    '@/components/QQPlaylistEditModal': {},
    '@/store/theme/hook': { useTheme: () => ({}) },
    '@/store/download/hook': { useDownloadCount: () => 0 },
    '@/utils/hooks': { useTabletLayout: () => ({ isWide: false, contentWidth: 400 }) },
    '@/utils/tools': { createStyle: value => value },
    '@/utils/pixelRatio': { scaleSizeW: value => value },
    '@/core/qqMusic': { getQQMusicSession: async() => ({ cookie: '', user: null }), isQQMusicSessionCurrent: () => true },
    '@/core/qqMusicFavorite': { getQQMusicLikedCount: () => 0, ensureQQMusicLikedCount: async() => 0 },
    '@/core/qqMusicProfile': {},
    '@/utils/localMatchIndex': { getLocalMusicCount: async() => 0 },
    '@/navigation': {},
    '@/store/common/state': {},
    '@/utils/data': { getPlayHistoryCount: () => { reads++; return gate.promise }, getPlayHistory: async() => { throw new Error('count must not load songs') } },
    '@/lang': { useI18n: () => key => key },
    '@/utils/hooks/useScreenVisible': { useScreenVisible: host.visible },
  }, { global: { app_event: events, list_event: new EventEmitter() } }).default
  host.render(frame, Component)
  events.emit('playHistoryUpdate', new Array(42))
  gate.resolve(300)
  await flush()
  const header = elements(host.render(frame, Component), 'SectionList')[0].props.ListHeaderComponent
  const findEntry = node => {
    if (Array.isArray(node)) return node.map(findEntry).find(Boolean)
    if (!node || typeof node !== 'object') return null
    return node.props?.label === 'nav_history' ? node : findEntry(node.props?.children)
  }
  assert.equal(findEntry(header).props.count, 42)
  assert.equal(reads, 1)
  frame.visible = false
  host.render(frame, Component)
  assert.equal(events.listenerCount('playHistoryUpdate'), 0)
  host.unmount(frame)
})
