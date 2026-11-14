const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load, deferred, flush } = require('./helpers/load.cjs')
const { hookHost, jsx } = require('./helpers/react.cjs')

const harness = () => {
  const host = hookHost(); const frame = host.frame(); const ref = { current: null }
  const timers = new Map(); const requests = []
  let nextTimer = 0; let displayed = []
  const stateModule = load('src/store/search/state.ts')
  const state = stateModule.default
  const actions = load('src/store/search/action.ts', { './state': stateModule })
  const core = load('src/core/search/search.ts', {
    '@/store/search/state': stateModule,
    '@/store/search/action': actions,
    '@/utils/data': {},
    '@/store/setting/state': { default: { setting: {} } },
  })
  const component = load('src/screens/Home/Views/Search/TipList.tsx', {
    react: host.react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '@/components/SearchTipList': { default: 'Tips' },
    '@/components/common/Button': { default: 'Button' },
    '@/components/common/Text': { default: 'Text' },
    '@/utils/tools': { createStyle: value => value },
    '@/utils/pixelRatio': { scaleSizeH: value => value },
    '@/store/search/state': stateModule,
    '@/core/search/search': core,
    '@/utils/musicSdk': {
      default: {
        kw: {
          tipSearch: {
            search: (text, signal) => {
              const gate = deferred(); requests.push({ text, signal, gate }); return gate.promise
            },
          },
        },
      },
    },
  }, {
    setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer },
    clearTimeout: id => timers.delete(id),
  }).default
  frame.connect = tree => { if (tree) tree.props.ref.current = { setHeight() {}, setList: list => { displayed = [...list] } } }
  const render = () => host.render(frame, () => component({ onSearch() {} }, ref))
  render()
  return {
    state,
    requests,
    timers,
    render,
    search(text) { ref.current.search(text, 400); render() },
    hide() { ref.current.hide(); render() },
    show() { ref.current.show(400); render() },
    fire() { for (const [id, callback] of [...timers]) { timers.delete(id); callback() } },
    displayed: () => displayed,
    async resolve(list) { requests.at(-1).gate.resolve(list); await flush(); render() },
    unmount: () => host.unmount(frame),
  }
}

for (const stage of ['timer', 'request']) {
  test(`refocus retries B cancelled during ${stage} and never labels A suggestions as B`, async() => {
    const h = harness()
    h.search('A'); h.fire(); await h.resolve(['A result'])
    h.search('B')
    if (stage === 'request') h.fire()
    const oldRequest = stage === 'request' ? h.requests.at(-1) : null
    h.hide()
    h.show()
    assert.deepEqual(h.displayed(), [])
    assert.equal(h.state.tipListInfo.text, 'A')
    assert.equal(h.timers.size, 1)
    h.fire()
    assert.equal(h.requests.at(-1).text, 'B')
    if (oldRequest) {
      assert.equal(oldRequest.signal.aborted, true)
      oldRequest.gate.resolve(['obsolete B'])
      await flush(); h.render()
      assert.deepEqual(h.displayed(), [])
    }
    await h.resolve(['current B'])
    assert.deepEqual(h.displayed(), ['current B'])
    assert.equal(h.state.tipListInfo.text, 'B')
    h.unmount()
  })
}

test('completed suggestions, including an empty result, are reused on focus without another request', async() => {
  for (const list of [['A result'], []]) {
    const h = harness()
    h.search('A'); h.fire(); await h.resolve(list)
    h.hide(); h.show()
    assert.deepEqual(h.displayed(), list)
    assert.equal(h.timers.size, 0)
    assert.equal(h.requests.length, 1)
    h.unmount()
  }
})

test('returning to the completed query cancels the newer request and reuses the matching result', async() => {
  const h = harness()
  h.search('A'); h.fire(); await h.resolve(['A result'])
  h.search('B'); h.fire()
  const old = h.requests.at(-1)
  h.search('A')
  assert.equal(h.timers.size, 0)
  assert.deepEqual(h.displayed(), ['A result'])
  old.gate.resolve(['B result'])
  await flush(); h.render()
  assert.deepEqual(h.displayed(), ['A result'])
  assert.equal(h.requests.length, 2)
  h.unmount()
})
