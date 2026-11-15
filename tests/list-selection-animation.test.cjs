const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load } = require('./helpers/load.cjs')
const { hookHost, jsx } = require('./helpers/react.cjs')

test('1000 selected songs pass a boolean to each row throughout 100 deselections', () => {
  const host = hookHost(); const frame = host.frame(); const ref = { current: null }
  const List = load('src/components/OnlineList/List.tsx', {
    react: host.react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { FlatList: 'FlatList', View: 'View', RefreshControl: 'RefreshControl' },
    './ListItem': { default: 'ListItem', ITEM_HEIGHT: 50 },
    '@/utils/tools': { createStyle: value => value, getRowInfo: () => ({ rowNum: 1 }) },
    '@/store/theme/hook': { useTheme: () => ({}) },
    '@/store/setting/state': { default: { setting: {} } },
    './MultipleModeBar': { MULTI_SELECT_BAR_HEIGHT: 40 },
    '@/lang': { useI18n: () => value => value },
    '@/components/common/Text': { default: 'Text' },
    './listAction': {},
    '@/store/setting/hook': { useSettingValue: () => false },
    '@/utils/hooks/useScreenVisible': { useScreenVisible: host.visible },
    '@/utils/hooks/useListScrollRestore': { useListScrollRestore: () => ({}) },
  }, { requestAnimationFrame: fn => fn() }).default
  const props = { releaseOnHide: true, onRefresh() {}, onLoadMore() {}, onSelectAll() {} }
  const render = () => host.render(frame, () => List(props, ref))
  render()
  const songs = Array.from({ length: 1000 }, (_, i) => ({ id: String(i) }))
  ref.current.setList(songs, false, false)
  render()
  ref.current.setIsMultiSelectMode(true)
  ref.current.selectAll(true)
  let tree = render()
  const retainedRows = []
  const stablePress = tree.props.renderItem({ item: songs[0], index: 0 }).props.onPress
  for (let index = 0; index < 100; index++) {
    const row = tree.props.renderItem({ item: songs[index], index })
    assert.equal(row.props.isSelected, true)
    assert.equal(row.props.onPress, stablePress)
    assert.equal(Object.hasOwn(row.props, 'selectedList'), false)
    retainedRows.push(row)
    row.props.onPress(songs[index], index)
    tree = render()
    assert.equal(tree.props.renderItem({ item: songs[index], index }).props.isSelected, false)
  }
  assert.equal(ref.current.getSelectedList().length, 900)
  assert.ok(retainedRows.every(row => Object.values(row.props).every(value => !Array.isArray(value))))
  host.unmount(frame)
})

test('30 text segments start no animations at first render and stop animations on replacement or unmount', () => {
  const host = hookHost(); const frames = Array.from({ length: 30 }, () => host.frame())
  const started = []; const stopped = []
  class Value {
    interpolate(config) { return config }
  }
  const native = {
    Animated: {
      Value,
      timing: (value, config) => ({
        start(callback) { started.push({ value, config, callback }) },
        stop() { stopped.push(value) },
      }),
    },
  }
  const color = load('src/utils/hooks/useAnimateColor.ts', { react: host.react, 'react-native': native })
  const number = load('src/utils/hooks/useAnimateNumber.ts', { react: host.react, 'react-native': native })
  const render = (frame, targetColor, opacity) => host.render(frame, () => [color.useAnimateColor(targetColor), number.useAnimateNumber(opacity, 800, false)])
  for (const frame of frames) {
    const result = render(frame, '#ffffff', 1)
    assert.ok(result.every(([, finished]) => finished))
  }
  assert.equal(started.length, 0)
  render(frames[0], '#000000', 0.5)
  assert.equal(started.length, 2)
  render(frames[0], '#000000', 0.5)
  assert.equal(started.length, 2)
  render(frames[0], '#ff0000', 0.75)
  assert.equal(stopped.length, 2)
  const callbacks = started.map(animation => animation.callback)
  frames.forEach(frame => host.unmount(frame))
  assert.equal(stopped.length, 4)
  callbacks.forEach(callback => callback({ finished: true }))
  assert.equal(frames[0].slots.length, 0)
})
