const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load } = require('./helpers/load.cjs')
const { jsx, hookHost, elements } = require('./helpers/react.cjs')

const harness = () => {
  const host = hookHost()
  const frame = host.frame()
  const measurements = []
  const opened = []
  const pressed = []
  let hidden = 0
  let disabled = false
  const Dropdown = load('src/components/common/DorpDownMenu.tsx', {
    react: host.react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    './Menu': { default: 'Menu' },
    './Button': { default: 'Button' },
    '@/utils/hooks/useScreenVisible': { useScreenVisible: host.visible },
  }).default
  frame.connect = tree => {
    tree.props.ref.current = { measure: callback => measurements.push(callback) }
    elements(tree, 'Menu')[0].props.ref.current = {
      show: position => opened.push(position),
      hide: () => { hidden++ },
    }
  }
  const render = () => host.render(frame, () => Dropdown({
    menus: [{ action: 'stable', label: 'Stable' }, { action: 'next', label: 'Next' }],
    onPress: item => pressed.push(item.action),
    children: 'Stable',
    disabled,
  }))
  return {
    frame,
    opened,
    pressed,
    render,
    setDisabled: value => { disabled = value },
    hidden: () => hidden,
    measure: (index, x = 10) => measurements[index](0, 0, 140, 40, x, 20),
    close: () => host.unmount(frame),
  }
}

for (const reason of ['hidden', 'disabled']) {
  test(`a dropdown becoming ${reason} closes and ignores its delayed measurement/selection`, t => {
    const h = harness()
    t.after(h.close)
    const button = h.render()
    button.props.onPress()
    if (reason === 'hidden') h.frame.visible = false
    else h.setDisabled(true)
    const unavailable = h.render()
    h.measure(0)
    elements(unavailable, 'Menu')[0].props.onPress({ action: 'next' })
    assert.equal(h.opened.length, 0)
    assert.ok(h.hidden() > 0)
    assert.equal(h.pressed.length, 0)
  })
}

test('an older dropdown measurement cannot reopen or reposition a newer menu', t => {
  const h = harness()
  t.after(h.close)
  const button = h.render()
  button.props.onPress()
  button.props.onPress()
  h.measure(1, 100)
  h.measure(0, 10)
  assert.equal(h.opened.length, 1)
  assert.equal(h.opened[0].x, 100)
})
