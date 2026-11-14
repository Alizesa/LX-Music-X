const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const { load, flush, deferred } = require('./load.cjs')
const { hookHost } = require('./react.cjs')

const harness = async({ read, scroll = false } = {}) => {
  let now = 0; let next = 0; let position = 0; let reads = 0; let parser
  const tasks = new Map()
  const scrolls = []
  const schedule = (fn, delay) => { const id = ++next; tasks.set(id, { fn, at: now + delay }); return id }
  class ClockDate extends Date { static now() { return now } }
  const timers = {
    setTimeout: schedule,
    clearTimeout: id => tasks.delete(id),
    requestAnimationFrame: fn => schedule(() => fn(now), 16),
    cancelAnimationFrame: id => tasks.delete(id),
  }
  const performance = { now: () => now }
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../node_modules/lrc-file-parser/dist/lrc-file-parser.js'), 'utf8'), {
    module, exports: module.exports, ...timers, performance, Date: ClockDate, window: { ...timers, performance },
  })
  class ObservedLyric extends module.exports { constructor(options) { super(options); parser = this } }
  const host = hookHost()
  host.react.useLayoutEffect = host.react.useEffect
  const api = load('src/plugins/lyric.ts', {
    react: host.react, 'lrc-file-parser': { default: ObservedLyric }, '@/utils/hooks/useScreenVisible': { useScreenVisible: host.visible },
  }, { Date: ClockDate })
  await api.init(async() => { reads++; return read ? read(reads) : position })
  const scrollApi = scroll ? load('src/screens/PlayDetail/components/useLyricScroll.ts', {
    react: host.react,
    'react-native': { findNodeHandle: () => null },
    '@/store/player/state': { default: { isPlay: true } },
    '@/utils/hooks/useScreenVisible': { useScreenVisible: host.visible },
    '@/utils/nativeModules/utils': { supportsScrollAnimationCancellation: false },
    './lyricScroll': load('src/screens/PlayDetail/components/lyricScroll.ts', {}, timers),
  }, timers) : null
  const frame = () => {
    const value = host.frame()
    value.connect = tree => { if (tree.scroll) tree.scroll.flatListRef.current = { scrollToIndex(options) { scrolls.push(options) }, scrollToOffset() {} } }
    return value
  }
  const render = frame => host.render(frame, () => {
    const lines = api.useLrcSet()
    const current = api.useLrcPlay()
    return { lines, current, scroll: scrollApi?.useLyricScroll(lines, current.line, false) }
  })
  return {
    api,
    host,
    frame,
    render,
    tasks,
    scrolls,
    parser: () => parser,
    reads: () => reads,
    setPosition: value => { position = value },
    advance(ms) {
      const end = now + ms
      for (let guard = 0; guard < 10000; guard++) {
        const due = [...tasks].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) { now = end; return }
        const [id, value] = due
        now = value.at; tasks.delete(id); value.fn()
      }
      assert.fail('lyric timer did not converge')
    },
  }
}
const lyrics = (count = 1000, prefix = 'Line') => Array.from({ length: count }, (_, index) => `[${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000]${prefix} ${index}`).join('\n')

module.exports = { harness, lyrics, load, deferred, flush, assert }
