const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const { EventEmitter } = require('node:events')
const ts = require('typescript')

const compiled = new Map()
const jsx = (type, props) => ({ type, props })
const load = (file, mocks = {}, globals = {}) => {
  if (!compiled.has(file)) {
    compiled.set(file, ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
    }).outputText)
  }
  const context = {
    exports: {},
    console,
    setTimeout,
    clearTimeout,
    require: name => {
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' }
      assert.ok(Object.hasOwn(mocks, name), `Unexpected import: ${file}: ${name}`)
      return mocks[name]
    },
    ...globals,
  }
  vm.runInNewContext(compiled.get(file), context, { filename: file })
  return context.exports
}
const deferred = () => {
  let resolve
  const promise = new Promise(_resolve => { resolve = _resolve })
  return { promise, resolve }
}
const flush = async() => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)) }
const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
const hooks = () => {
  const slots = []
  let cursor = 0
  let effects = []
  const react = {
    memo: fn => fn,
    forwardRef: fn => fn,
    useRef(value) { return slots[cursor++] ??= { current: value } },
    useState(initial) {
      const index = cursor++
      const slot = slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [slot.value, value => { slot.value = typeof value === 'function' ? value(slot.value) : value }]
    },
    useMemo(fn, deps) {
      const index = cursor++
      if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { value: fn(), deps }
      return slots[index].value
    },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps) },
    useEffect(fn, deps) {
      const index = cursor++
      const previous = slots[index]
      if (previous && same(previous.deps, deps)) return
      const slot = slots[index] = { deps }
      effects.push(() => { previous?.cleanup?.(); slot.cleanup = fn() })
    },
    useImperativeHandle(ref, factory) { if (ref) ref.current = factory() },
  }
  return {
    react,
    render(fn) {
      cursor = 0
      effects = []
      const tree = fn()
      effects.forEach(effect => effect())
      return tree
    },
    unmount() { slots.forEach(slot => slot.cleanup?.()) },
  }
}
const constants = load('src/config/constant.ts')
const t = value => value
const theme = { useTheme: () => ({}) }
const native = (width = 1200, height = 800, density = 1) => ({
  Platform: { OS: 'android', constants: { Release: '13' } },
  StyleSheet: { create: value => value, absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } },
  StatusBar: { currentHeight: 24 },
  View: 'View',
  TouchableOpacity: 'TouchableOpacity',
  TouchableHighlight: 'TouchableHighlight',
  Dimensions: { get: () => ({ width, height, scale: density }), addEventListener: () => ({ remove() {} }) },
  PixelRatio: { get: () => density, getFontScale: () => 1, getPixelSizeForLayoutSize: value => Math.round(value * density) },
})
const toolsFor = (rn, globals) => {
  const windows = { windowSizeTools: { getSize: () => rn.Dimensions.get('window') } }
  const pixels = load('src/utils/pixelRatio.ts', { 'react-native': rn, './windowSizeTools': windows }, globals)
  const api = load('src/utils/tools.ts', {
    'react-native': rn,
    '@react-native-clipboard/clipboard': {},
    '@/config/constant': constants,
    '@/utils/fs': {},
    '@/utils/nativeModules/utils': {},
    '@/utils/musicSdk': {},
    '@/plugins/storage': {},
    'react-native-background-timer': {},
    './pixelRatio': pixels,
    './index': {},
    'react-native-quick-md5': {},
    '@/utils/windowSizeTools': windows,
  }, globals)
  return { api, pixels }
}

test('bottom navigation keeps the same height across tablet, split-screen and phone launch sizes', () => {
  const viewports = [[1200, 800, 1.5], [1600, 900, 2], [600, 800, 2], [1200, 400, 2], [360, 640, 3]]
  for (const fontSize of [0.8, 1, 1.3]) {
    const heights = []
    for (const [width, height, density] of viewports) {
      const rn = native(width, height, density)
      const h = hooks()
      const globals = { global: { lx: { fontSize } } }
      const utils = toolsFor(rn, globals)
      let activeId = 'nav_home'
      const Bar = load('src/components/BottomTabBar/index.tsx', {
        react: h.react,
        'react-native': rn,
        '@/components/common/Icon': { IconIonicons: 'Icon' },
        '@/components/common/Text': { default: 'Text' },
        '@/config/constant': constants,
        '@/core/common': { setNavActiveId: id => { activeId = id } },
        '@/lang': { useI18n: () => t },
        '@/store/common/hook': { useNavActiveId: () => activeId },
        '@/store/theme/hook': theme,
        '@/utils/tools': utils.api,
        '@/utils/pixelRatio': utils.pixels,
      }, globals).default
      const tree = h.render(Bar)
      heights.push(tree.props.style.height)
      assert.equal(tree.props.style.flexShrink, 0)
      const mine = tree.props.children[1]
      const item = h.render(() => mine.type(mine.props))
      assert.equal(item.props.children[0].props.size, 23 * fontSize)
      item.props.onPress()
      assert.equal(activeId, 'nav_mine')
    }
    assert.ok(heights.every(height => height === 52 * fontSize), JSON.stringify({ fontSize, heights }))
  }
})

const sizeHarness = () => {
  const rn = native()
  const requests = []
  const windows = load('src/utils/windowSizeTools.ts', {
    'react-native': rn,
    './nativeModules/utils': { getWindowSize: () => { const request = deferred(); requests.push(request); return request.promise } },
  })
  const h = hooks()
  const events = new EventEmitter()
  const common = { statusbarHeight: 0 }
  const setting = { setting: { 'common.alwaysKeepStatusbarHeight': false } }
  let visible = true
  const updates = []
  const Component = load('src/components/SizeView.tsx', {
    react: h.react,
    'react-native': rn,
    '@/store/common/state': { default: common },
    '@/store/setting/state': { default: setting },
    '@/core/common': { setStatusbarHeight: height => { common.statusbarHeight = height; updates.push(height) } },
    '@/utils/windowSizeTools': windows,
    '@/utils/hooks/useScreenVisible': { useScreenVisible: () => visible },
  }, { global: { state_event: events } }).default
  const render = () => h.render(Component)
  const layout = (tree, width, height) => tree.props.onLayout({ nativeEvent: { layout: { width, height, x: 0, y: 0 } } })
  return { ...h, render, layout, common, updates, requests, windows: windows.windowSizeTools, events, visible: value => { visible = value } }
}

test('split-screen layouts publish immediately and late native measurements cannot restore the old window', async() => {
  const h = sizeHarness()
  const tree = h.render()
  h.layout(tree, 1200, 800)
  h.layout(tree, 600, 800)
  assert.equal(h.windows.getSize().width, 600)
  h.requests[1].resolve({ width: 600, height: 776 })
  await flush()
  assert.equal(h.common.statusbarHeight, 24)
  h.requests[0].resolve({ width: 1200, height: 800 })
  await flush()
  assert.equal(h.windows.getSize().width, 600)
  assert.equal(h.common.statusbarHeight, 24)
  // The layout can arrive before the Dimensions event while dragging the divider.
  h.layout(tree, 1200, 400)
  assert.equal(h.windows.getSize().height, 400)
  h.requests[2].resolve({ width: 1200, height: 400 })
  await flush()
  assert.equal(h.common.statusbarHeight, 0)
  h.unmount()
})

test('hidden and unmounted screens cannot publish stale window or status-bar measurements', async() => {
  const h = sizeHarness()
  h.layout(h.render(), 1200, 800)
  h.visible(false)
  const hidden = h.render()
  h.requests[0].resolve({ width: 1200, height: 776 })
  await flush()
  h.layout(hidden, 600, 800)
  assert.equal(h.windows.getSize().width, 1200)
  assert.equal(h.requests.length, 1)
  assert.equal(h.common.statusbarHeight, 0)
  h.visible(true)
  h.render()
  assert.equal(h.windows.getSize().width, 600)
  h.unmount()
  h.requests[1].resolve({ width: 600, height: 776 })
  await flush()
  assert.equal(h.common.statusbarHeight, 0)
  assert.equal(h.events.listenerCount('configUpdated'), 0)
})

test('window snapshots reject transient invalid sizes and keep stable references until a real resize', () => {
  const h = sizeHarness()
  const seen = []
  const first = h.windows.onSizeChanged(size => seen.push(['first', size.width]))
  h.windows.onSizeChanged(size => seen.push(['second', size.width]))
  h.windows.setWindowSize(600, 800)
  const snapshot = h.windows.getSize()
  h.windows.setWindowSize(600.1, 800.1)
  h.windows.setWindowSize(0, 0)
  h.windows.setWindowSize(NaN, 800)
  assert.strictEqual(h.windows.getSize(), snapshot)
  assert.equal(seen.length, 2)
  first()
  first()
  h.windows.setWindowSize(900, 600)
  assert.deepEqual(seen.at(-1), ['second', 900])
})

for (const file of ['src/components/common/Dialog.tsx', 'src/components/common/Popup.tsx', 'src/components/QQPlaylistEditModal.tsx']) {
  test(`${file}: Android split-screen modals do not reserve the keyboard height twice`, () => {
    const rn = native(600, 400)
    const h = hooks()
    const globals = { global: { lx: { fontSize: 1 } } }
    const utils = toolsFor(rn, globals)
    const Component = load(file, {
      react: h.react,
      'react-native': rn,
      './Modal': { default: 'Modal' },
      '@/components/common/Modal': { default: 'Modal' },
      '@/components/common/Icon': {},
      '@/components/common/Input': {},
      '@/components/common/Button': {},
      '@/components/common/Text': {},
      './Text': {},
      '@/utils/hooks': {
        useKeyboard: () => ({ keyboardShown: true, keyboardHeight: 250 }),
        useTabletLayout: () => ({ isWide: false }),
      },
      '@/utils/tools': utils.api,
      '@/store/theme/hook': theme,
      '@/utils/pixelRatio': utils.pixels,
      '@/store/common/hook': { useStatusbarHeight: () => 24 },
      '@/utils/layout': load('src/utils/layout.ts'),
      '@/lang': { useI18n: () => t },
      '@/core/qqMusicFavorite': {},
    }, globals).default
    const getInset = () => {
      const tree = h.render(() => Component({}, { current: null }))
      const children = Array.isArray(tree.props.children) ? tree.props.children : [tree.props.children]
      return children.find(child => child?.type === 'View').props.style.paddingBottom
    }
    assert.equal(getInset(), 0)
    rn.Platform.OS = 'ios'
    assert.equal(getInset(), 250)
  })
}
