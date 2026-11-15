const assert = require('node:assert/strict')
const { test } = require('node:test')
const { spawnSync } = require('node:child_process')
const { load, deferred, flush } = require('./helpers/load.cjs')
const { hookHost, jsx, elements } = require('./helpers/react.cjs')

const harness = (file, selected = false) => {
  const host = hookHost(); const frame = host.frame(); const ref = { current: null }
  const gate = deferred(); const visibility = []; let popup
  frame.connect = tree => {
    popup = elements(tree, 'Popup')[0]
    popup.props.ref.current = { setVisible: value => { visibility.push(value); if (!value) popup.props.onHide() } }
  }
  const song = { id: 'song', source: 'tx', name: 'Song', meta: {} }
  const Component = load(file, {
    react: host.react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { View: 'View', ScrollView: 'ScrollView', FlatList: 'FlatList', TouchableOpacity: 'Button' },
    '@/lang': { useI18n: () => value => value },
    '@/components/common/Popup': { default: 'Popup' },
    '@/components/common/Text': { default: 'Text' },
    '@/components/common/Image': { default: 'Image' },
    '@/components/common/Icon': {},
    '@/components/common/AddToPlaylistIcon': {},
    '@/components/common/LikedHeart': {},
    '@/components/common/MenuRow': { default: 'MenuRow' },
    '@/store/theme/hook': { useTheme: () => ({}) },
    '@/core/dislikeList': { hasDislike: () => false },
    '@/utils/data': { hasMusicUrlByMusic: async() => false },
    '@/core/player/player': {},
    '@/core/qqMusicFavorite': { useQQMusicLiked: () => false, loadWritableQQMusicPlaylists: () => gate.promise },
    '@/utils/tools': { createStyle: value => value, toast() {} },
    '@/utils/hooks/useScreenVisible': { useScreenVisible: host.visible },
    '@/store/player/state': { default: { playMusicInfo: { musicInfo: song } } },
    '@/store/setting/state': {},
    '@/core/download': {},
  }).default
  const render = () => host.render(frame, () => Component({}, ref))
  return { host, frame, ref, gate, render, visibility, song, selected }
}

for (const file of ['src/components/OnlineList/ListMenu.tsx', 'src/screens/PlayDetail/components/MoreMenu/index.tsx']) {
  test(`${file}: 200 playlist candidates use a virtual list and hiding releases its state`, async() => {
    const h = harness(file)
    h.render()
    h.ref.current.show({ musicInfo: h.song, selectedList: [], single: false, index: 0 })
    let tree = h.render()
    elements(tree, 'MenuRow').find(row => row.props.label === 'qq_playlist_add_to').props.onPress()
    h.gate.resolve(Array.from({ length: 200 }, (_, i) => ({ id: String(i), name: `List ${i}`, cover: `cover-${i}` })))
    await flush()
    tree = h.render()
    const list = elements(tree, 'FlatList')[0]
    assert.equal(list.props.data.length, 200)
    assert.ok(list.props.initialNumToRender <= 6)
    assert.ok(list.props.windowSize <= 3)
    assert.equal(elements(tree, 'Image').length, 0, 'rows are only created by the virtual list renderItem')
    h.frame.visible = false
    tree = h.render()
    assert.equal(h.visibility.at(-1), false)
    assert.ok(!elements(tree, 'FlatList')[0]?.props.data.length)
    h.host.unmount(h.frame)
  })
}

test('V8 releases 5000 selected songs after closing while the playlist source stays pending', () => {
  const result = spawnSync(process.execPath, ['--expose-gc', '-e', `
    const assert = require('node:assert/strict')
    const { load, deferred, flush } = require('./tests/helpers/load.cjs')
    const { hookHost, jsx, elements } = require('./tests/helpers/react.cjs')
    const harness = ${harness.toString()}
    ;(async() => {
      const h = harness('src/components/OnlineList/ListMenu.tsx')
      h.render()
      let selection = { musicInfo: h.song, selectedList: Array.from({ length: 5000 }, (_, i) => ({ id: String(i) })), single: false, index: 0 }
      const reference = new WeakRef(selection.selectedList)
      h.ref.current.show(selection)
      let tree = h.render()
      elements(tree, 'MenuRow').find(row => row.props.label === 'qq_playlist_add_to').props.onPress()
      elements(tree, 'Popup')[0].props.onHide()
      h.render()
      selection = tree = null
      global.keepPendingPicker = h
      for (let i = 0; i < 12; i++) { await flush(); global.gc() }
      assert.equal(reference.deref() === undefined, true, 'pending source must not retain closed selection')
      h.host.unmount(h.frame)
    })().catch(error => { console.error(error); process.exitCode = 1 })
  `], { cwd: process.cwd(), encoding: 'utf8', timeout: 20000 })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
