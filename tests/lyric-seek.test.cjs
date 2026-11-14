const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load } = require('./helpers/load.cjs')
const { hookHost, jsx, elements } = require('./helpers/react.cjs')

const harness = () => {
  const host = hookHost(); const frame = host.frame(); const ref = { current: null }; const seeks = []
  const component = load('src/screens/PlayDetail/components/PlayLine.tsx', {
    react: host.react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': {
      View: 'View',
      TouchableOpacity: 'Press',
      Animated: { View: 'AnimatedView', Value: class {}, timing: () => ({ start: callback => callback?.({ finished: true }), stop() {} }) },
    },
    '@/components/common/Text': { default: 'Text' },
    '@/utils/tools': { createStyle: value => value },
    '@/store/theme/hook': { useTheme: () => ({}) },
    '@/theme': { BorderWidths: {} },
    '@/utils': { formatPlayTime2: value => String(value) },
    '@/components/common/Icon': { Icon: 'Icon' },
  }, { requestAnimationFrame: fn => { fn(); return 1 }, cancelAnimationFrame() {} }).default
  const render = () => host.render(frame, () => component({ onPlayLine: value => seeks.push(value) }, ref))
  render()
  const lines = Array.from({ length: 200 }, (_, index) => ({ time: index * 2000, text: String(index), extendedLyrics: [] }))
  const layout = { spaceHeight: 200, lineHeights: [], lineFrames: new Map() }
  const measure = (index, y = 200 + index * 40, height = 40) => {
    layout.lineHeights[index] = height
    layout.lineFrames.set(index, { y, height })
    ref.current.updateLayoutInfo(layout)
  }
  const scroll = offset => ref.current.updateScrollInfo({ contentOffset: { y: offset - 200 }, layoutMeasurement: { height: 500 } })
  ref.current.updateLyricLines(lines)
  ref.current.updateLayoutInfo(layout)
  ref.current.setVisible(true)
  return { render, ref, frame, lines, layout, measure, scroll, seeks, close: () => host.unmount(frame) }
}

test('sparse virtualized lyric rows seek to 152 seconds instead of the first unmeasured row at 30 seconds', () => {
  const h = harness()
  for (let i = 0; i < 15; i++) h.measure(i)
  for (let i = 70; i <= 80; i++) h.measure(i)
  h.scroll(200 + 76 * 40 + 20)
  const tree = h.render()
  elements(tree, 'Press')[0].props.onPress()
  assert.deepEqual(h.seeks, [152])
  assert.equal(elements(tree, 'Text')[0].props.children, '152')
  h.close()
})

test('an unmeasured or ambiguous target cannot seek to an unrelated lyric', () => {
  const h = harness()
  h.measure(0)
  h.measure(80)
  h.scroll(200 + 76 * 40 + 20)
  let button = elements(h.render(), 'Press')[0]
  assert.equal(button.props.disabled, true)
  button.props.onPress()
  assert.deepEqual(h.seeks, [])
  h.measure(75, 3200, 200)
  h.measure(76, 3240, 80)
  button = elements(h.render(), 'Press')[0]
  assert.equal(button.props.disabled, true)
  button.props.onPress()
  assert.deepEqual(h.seeks, [])
  h.close()
})

test('a late measured frame updates a stationary seek marker without another scroll event', () => {
  const h = harness()
  h.scroll(200 + 76 * 40 + 20)
  h.render()
  h.measure(76)
  assert.equal(h.frame.dirty, true)
  const button = elements(h.render(), 'Press')[0]
  assert.equal(button.props.disabled, false)
  button.props.onPress()
  assert.deepEqual(h.seeks, [152])
  h.close()
})

test('seek uses measured nonuniform positions and supports zero and the final padding area', () => {
  const h = harness()
  h.measure(0, 200, 50)
  h.measure(76, 3200, 120)
  h.measure(199, 9900, 100)
  for (const [offset, seconds] of [[100, 0], [3280, 152], [10050, 398]]) {
    h.scroll(offset)
    elements(h.render(), 'Press')[0].props.onPress()
    assert.equal(h.seeks.at(-1), seconds)
  }
  h.close()
})

test('a seek callback from old lyrics or a hidden marker cannot affect the new song', () => {
  const h = harness()
  h.measure(76)
  h.scroll(200 + 76 * 40 + 20)
  const oldPress = elements(h.render(), 'Press')[0].props.onPress
  h.ref.current.updateLyricLines([{ time: 90000, text: 'new', extendedLyrics: [] }])
  oldPress()
  assert.deepEqual(h.seeks, [])
  h.ref.current.updateLyricLines(h.lines)
  const currentPress = elements(h.render(), 'Press')[0].props.onPress
  h.ref.current.setVisible(false)
  currentPress()
  assert.deepEqual(h.seeks, [])
  h.close()
})

const screenHarness = () => {
  const host = hookHost(); host.react.useLayoutEffect = host.react.useEffect
  const screen = host.frame(); let marker = host.frame(); const cells = []
  const tasks = new Map(); let timerId = 0; const seeks = []
  const timers = {
    setTimeout: (fn, delay) => { tasks.set(++timerId, { fn, delay }); return timerId },
    clearTimeout: id => tasks.delete(id),
    requestAnimationFrame: fn => { tasks.set(++timerId, { fn, delay: 16 }); return timerId },
    cancelAnimationFrame: id => tasks.delete(id),
  }
  const native = {
    FlatList: 'FlatList',
    View: 'View',
    TouchableOpacity: 'Press',
    findNodeHandle: () => null,
    Animated: { View: 'AnimatedView', Value: class {}, timing: () => ({ start: callback => callback?.({ finished: true }), stop() {} }) },
  }
  const common = {
    react: host.react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': native,
    '@/components/common/Text': { default: 'Text', AnimatedColorText: 'Text' },
    '@/utils/tools': { createStyle: value => value },
    '@/store/theme/hook': { useTheme: () => ({}) },
    '@/theme': { BorderWidths: {} },
    '@/utils': { formatPlayTime2: value => String(value) },
    '@/components/common/Icon': { Icon: 'Icon' },
  }
  const PlayLine = load('src/screens/PlayDetail/components/PlayLine.tsx', common, timers).default
  const scroll = load('src/screens/PlayDetail/components/useLyricScroll.ts', {
    react: host.react,
    'react-native': native,
    '@/store/player/state': { default: { isPlay: false } },
    '@/utils/hooks/useScreenVisible': { useScreenVisible: host.visible },
    '@/utils/nativeModules/utils': { supportsScrollAnimationCancellation: false },
    './lyricScroll': load('src/screens/PlayDetail/components/lyricScroll.ts', {}, timers),
  }, { ...timers, global: { app_event: { setProgress: value => seeks.push(value) } } })
  let lines = Array.from({ length: 200 }, (_, index) => ({ time: index * 2000, text: String(index), extendedLyrics: [] }))
  let showProgress = true
  const Lyric = load('src/screens/PlayDetail/components/Lyric.tsx', {
    ...common,
    '@/plugins/lyric': { useLrcSet: () => lines, useLrcPlay: () => ({ line: 76 }) },
    '@/store/setting/hook': { useSettingValue: () => showProgress },
    '@/utils/pixelRatio': {},
    './PlayLine': { default: PlayLine },
    './useLyricScroll': scroll,
    './lrcColors': {},
  }, timers).default
  let flat; let markerElement
  screen.connect = tree => {
    flat = elements(tree, 'FlatList')[0]
    flat.props.ref.current = { scrollToIndex() {}, scrollToOffset() {}, getNativeScrollRef: () => null }
    const nextMarker = elements(tree, PlayLine)[0]
    if (markerElement && !nextMarker) { host.unmount(marker); marker = host.frame() }
    markerElement = nextMarker
    if (markerElement) host.render(marker, () => PlayLine(markerElement.props, markerElement.props.ref))
  }
  const render = () => host.render(screen, () => Lyric({ fontSizeSetting: 'playDetail.vertical.style.lrcFontSize' }))
  const renderMarker = () => host.render(marker, () => PlayLine(markerElement.props, markerElement.props.ref))
  render()
  let delegated = 0
  return {
    seeks,
    measure(index, y, height) {
      const cell = host.frame(); cells.push(cell)
      const Cell = flat.props.CellRendererComponent
      const props = { index, item: lines[index], cellKey: String(index), children: null, onLayout() { delegated++ } }
      const tree = host.render(cell, () => Cell(props))
      const callback = () => tree.props.onLayout({ nativeEvent: { layout: { x: 0, width: 320, y, height } } })
      callback()
      return { callback, unmount: () => host.unmount(cell) }
    },
    drag(offset = 3260) {
      flat.props.onLayout({ nativeEvent: { layout: { width: 360, height: 500 } } })
      flat.props.onScrollBeginDrag()
      flat.props.onScroll({ nativeEvent: { contentOffset: { y: offset - 200 }, layoutMeasurement: { height: 500, width: 360 } } })
      for (const [id, task] of [...tasks]) if (task.delay === 16) { tasks.delete(id); task.fn() }
      return renderMarker()
    },
    marker: renderMarker,
    changeLyrics() { lines = lines.map(line => ({ ...line, time: line.time + 1000 })); render() },
    visible(value) { screen.visible = value; render() },
    progress(value) {
      showProgress = value
      render()
      for (const [id, task] of [...tasks]) if (task.delay === 16) { tasks.delete(id); task.fn() }
    },
    delegated: () => delegated,
    close() { cells.forEach(cell => host.unmount(cell)); host.unmount(screen); host.unmount(marker) },
  }
}

test('the shared lyric component forwards absolute cell layouts to the real seek controller', () => {
  const h = screenHarness()
  h.measure(0, 200, 40)
  h.measure(76, 3240, 40)
  const tree = h.drag()
  elements(tree, 'Press')[0].props.onPress()
  assert.deepEqual(h.seeks, [152])
  assert.equal(h.delegated(), 2)
  h.close()
})

test('unmounted cells and late layouts from hidden or replaced lyrics cannot provide seek positions', () => {
  const h = screenHarness()
  const old = h.measure(76, 3240, 40)
  h.drag()
  old.unmount()
  assert.equal(elements(h.marker(), 'Press')[0].props.disabled, true)
  h.visible(false); h.visible(true)
  old.callback()
  assert.equal(elements(h.drag(), 'Press')[0].props.disabled, true)
  const current = h.measure(76, 3240, 40)
  assert.equal(elements(h.marker(), 'Press')[0].props.disabled, false)
  h.changeLyrics()
  current.callback()
  assert.equal(elements(h.drag(), 'Press')[0].props.disabled, true)
  h.close()
})

test('enabling the seek marker while paused restores measured positions without another layout event', () => {
  const h = screenHarness()
  h.measure(76, 3240, 40)
  h.drag()
  h.progress(false)
  h.progress(true)
  const button = elements(h.marker(), 'Press')[0]
  assert.equal(button.props.disabled, false)
  button.props.onPress()
  assert.deepEqual(h.seeks, [152])
  h.close()
})
