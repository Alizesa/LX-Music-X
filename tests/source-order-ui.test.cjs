const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load } = require('./helpers/load.cjs')
const { hookHost, jsx, elements } = require('./helpers/react.cjs')

const prefix = id => `user_api_${id}`
const harness = (selected = ['A', 'B', 'C']) => {
  const host = hookHost()
  const frame = host.frame()
  const rows = new Map()
  const writes = []
  const setting = { 'common.apiSource': prefix(selected[0]), 'common.apiSourceOrder': JSON.stringify(selected.map(prefix)) }
  class Value {
    constructor(value) { this.value = value }
    setValue(value) { this.value = value }
  }
  const Source = load('src/screens/Home/Views/Setting/settings/Basic/Source.tsx', {
    react: host.react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': {
      View: 'View',
      Animated: { View: 'AnimatedView', Value, event: bindings => (event, gesture) => bindings[1].dy.setValue(gesture.dy) },
      PanResponder: { create: handlers => ({ panHandlers: handlers }) },
    },
    '../../components/SubTitle': { default: 'SubTitle' },
    '@/components/common/CheckBox': { default: 'CheckBox' },
    '@/utils/tools': { createStyle: value => value },
    '@/core/apiSource': {
      setApiSource() {},
      getApiSourceOrder: () => JSON.parse(setting['common.apiSourceOrder']),
      setApiSourceOrder: order => {
        writes.push(Array.from(order))
        setting['common.apiSourceOrder'] = JSON.stringify(order)
        setting['common.apiSource'] = order[0]
      },
    },
    '@/utils/apiSourceOrder': load('src/utils/apiSourceOrder.ts'),
    '@/lang': { useI18n: () => key => key },
    '@/utils/musicSdk/api-source-info': { default: [] },
    '@/store/setting/hook': { useSettingValue: key => setting[key] },
    '@/store/userApi': {
      useStatus: () => ({ status: true }),
      useUserApiList: () => ['A', 'B', 'C', 'D'].map(id => ({ id: prefix(id), name: id, version: '1.0.0' })),
    },
    '../../components/Button': { default: 'Button' },
    '@/components/common/Icon': { Icon: 'Icon' },
    './UserApiEditModal': { default: 'UserApiEditModal' },
    '@/components/common/Text': { default: 'Text' },
    '@/store/theme/hook': { useTheme: () => ({}) },
    '@/utils/hooks/useScreenVisible': { useScreenVisible: host.visible },
  }).default
  const collect = tree => {
    if (Array.isArray(tree)) return tree.flatMap(collect)
    if (!tree || typeof tree !== 'object') return []
    return tree.props?.id ? [tree] : collect(tree.props?.children)
  }
  let order = []
  const render = () => {
    const items = collect(host.render(frame, Source))
    order = Array.from(items, item => item.props.id)
    let y = 0
    for (const item of items) {
      const id = item.props.id
      const row = rows.get(id) ?? { frame: host.frame() }
      row.tree = host.render(row.frame, () => item.type(item.props))
      // Source names/statuses wrap to different heights on narrow screens.
      const height = id === prefix('B') ? 80 : id === prefix('C') ? 50 : 40
      row.tree.props.onLayout({ nativeEvent: { layout: { x: 0, y, width: 220, height } } })
      y += height + 8
      rows.set(id, row)
    }
  }
  render()
  return {
    writes,
    setting,
    render,
    hide: () => { frame.visible = false; render() },
    order: () => order,
    row: id => rows.get(prefix(id)).tree,
    handle: id => elements(rows.get(prefix(id)).tree, 'View').find(view => view.props.accessibilityRole === 'adjustable')?.props,
    close: () => { for (const row of rows.values()) host.unmount(row.frame); host.unmount(frame) },
  }
}

test('dragging across unequal source rows moves the source once on release and keeps unchecked sources disabled', t => {
  const h = harness()
  t.after(h.close)
  const drag = h.handle('A')
  assert.equal(drag.onStartShouldSetPanResponder(), true)
  drag.onPanResponderGrant()
  drag.onPanResponderMove(null, { dy: 141 })
  assert.equal(h.writes.length, 0, 'moving the handle must not repeatedly initialize sources')
  drag.onPanResponderRelease(null, { dy: 141 })
  assert.deepEqual(h.writes, [['B', 'C', 'A'].map(prefix)])
  h.render()
  assert.deepEqual(h.order(), ['B', 'C', 'A', 'D'].map(prefix))
  assert.equal(h.handle('D'), undefined)
  assert.equal(elements(h.row('D'), 'CheckBox')[0].props.check, false)
})

test('cancelled drags and taps leave source priorities untouched', t => {
  const h = harness()
  t.after(h.close)
  const drag = h.handle('A')
  drag.onPanResponderGrant()
  drag.onPanResponderMove(null, { dy: 150 })
  drag.onPanResponderTerminate()
  assert.equal(h.row('A').props.style.transform[0].translateY.value, 0)
  drag.onPanResponderGrant()
  drag.onPanResponderRelease(null, { dy: 0 })
  assert.equal(h.writes.length, 0)
})

test('a checkbox action before rerender preserves the just-saved drag order', t => {
  const h = harness()
  t.after(h.close)
  const drag = h.handle('A')
  drag.onPanResponderGrant()
  drag.onPanResponderRelease(null, { dy: 141 })
  elements(h.row('D'), 'CheckBox')[0].props.onChange(true)
  assert.deepEqual(h.writes.at(-1), ['B', 'C', 'A', 'D'].map(prefix))
})

test('rapid checkbox changes use the latest selection and a stale drag cannot undo them', t => {
  const h = harness()
  t.after(h.close)
  const drag = h.handle('A')
  drag.onPanResponderGrant()
  elements(h.row('D'), 'CheckBox')[0].props.onChange(true)
  elements(h.row('B'), 'CheckBox')[0].props.onChange(false)
  assert.deepEqual(h.writes.at(-1), ['A', 'C', 'D'].map(prefix))
  drag.onPanResponderRelease(null, { dy: 141 })
  assert.equal(h.writes.length, 2, 'the old layout must not override a newer source selection')
})

for (const interrupt of ['selection', 'hide']) {
  test(`a ${interrupt} change cancels dragging and ignores later move/release events`, t => {
    const h = harness()
    t.after(h.close)
    const drag = h.handle('A')
    drag.onPanResponderGrant()
    drag.onPanResponderMove(null, { dy: 141 })
    if (interrupt === 'selection') {
      elements(h.row('D'), 'CheckBox')[0].props.onChange(true)
      h.render()
    } else h.hide()
    const writes = h.writes.length
    drag.onPanResponderMove(null, { dy: 300 })
    drag.onPanResponderRelease(null, { dy: 300 })
    assert.equal(h.writes.length, writes)
    assert.equal(h.row('A').props.style.transform[0].translateY.value, 0)
  })
}

test('dragging beyond either edge stays within selected sources and a single source cannot be dragged', t => {
  for (const [source, dy, expected] of [['A', 1000, ['B', 'C', 'A']], ['C', -1000, ['C', 'A', 'B']]]) {
    const h = harness()
    t.after(h.close)
    const drag = h.handle(source)
    drag.onPanResponderGrant()
    drag.onPanResponderRelease(null, { dy })
    assert.deepEqual(h.writes, [expected.map(prefix)])
  }
  const only = harness(['A'])
  t.after(only.close)
  assert.equal(only.handle('A').onStartShouldSetPanResponder(), false)
  assert.equal(only.handle('A').accessibilityState.disabled, true)
})
