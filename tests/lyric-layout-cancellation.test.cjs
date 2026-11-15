const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load, deferred, flush } = require('./helpers/load.cjs')
const { hookHost } = require('./helpers/react.cjs')

test('replacing a lyric layout waits for the preceding native scroll animation to stop', async() => {
  const host = hookHost(); host.react.useLayoutEffect = host.react.useEffect
  const frame = host.frame(); const stopped = deferred(); const tasks = new Map(); const scrolls = []
  let next = 0
  const timers = {
    requestAnimationFrame: fn => { const id = ++next; tasks.set(id, fn); return id },
    cancelAnimationFrame: id => tasks.delete(id),
    setTimeout: fn => { const id = ++next; tasks.set(id, fn); return id },
    clearTimeout: id => tasks.delete(id),
  }
  const api = load('src/screens/PlayDetail/components/useLyricScroll.ts', {
    react: host.react,
    'react-native': { findNodeHandle: () => 1 },
    '@/store/player/state': { default: { isPlay: true } },
    '@/utils/hooks/useScreenVisible': { useScreenVisible: host.visible },
    '@/utils/nativeModules/utils': { supportsScrollAnimationCancellation: true, stopScrollAnimation: () => stopped.promise },
    './lyricScroll': load('src/screens/PlayDetail/components/lyricScroll.ts', {}, timers),
  }, timers)
  const list = { scrollToIndex: value => scrolls.push(value), scrollToOffset() {}, getNativeScrollRef: () => ({}) }
  frame.connect = tree => { tree.flatListRef.current = list }
  const render = (lines, line) => host.render(frame, () => api.useLyricScroll(lines, line, false))
  const advance = () => { for (const [id, fn] of [...tasks]) { tasks.delete(id); fn() } }
  const first = [{ text: 'first' }, { text: 'second' }]
  let tree = render(first, 0)
  tree.handleLayout({ nativeEvent: { layout: { width: 300, height: 500 } } })
  advance(); advance()
  render(first, 1)
  advance(); advance()
  assert.equal(scrolls.at(-1).animated, true)
  const before = scrolls.length
  tree = render([{ text: 'new layout' }], 0)
  tree.handleLayout({ nativeEvent: { layout: { width: 300, height: 500 } } })
  advance(); advance()
  assert.equal(scrolls.length, before, 'new controller must share the outstanding native cancellation')
  stopped.resolve()
  await flush()
  advance(); advance()
  assert.equal(scrolls.length, before + 1)
  assert.equal(scrolls.at(-1).animated, false)
  host.unmount(frame)
})
