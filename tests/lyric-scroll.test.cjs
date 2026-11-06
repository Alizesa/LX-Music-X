const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const ts = require('typescript')

const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/screens/PlayDetail/components/lyricScroll.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText

const clock = () => {
  let now = 0
  let next = 0
  const tasks = new Map()
  const schedule = (fn, delay) => { const id = ++next; tasks.set(id, { fn, at: now + delay }); return id }
  return {
    setTimeout: schedule,
    clearTimeout: id => tasks.delete(id),
    requestAnimationFrame: fn => schedule(() => fn(now), 16),
    cancelAnimationFrame: id => tasks.delete(id),
    tasks,
    advance(ms) {
      const until = now + ms
      let count = 0
      while (true) {
        const nextTask = [...tasks].filter(([, task]) => task.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!nextTask) break
        assert.ok(++count < 1000, 'scroll scheduling must terminate')
        const [id, task] = nextTask
        tasks.delete(id)
        now = task.at
        task.fn()
      }
      now = until
    },
  }
}

const flush = async() => { for (let i = 0; i < 8; i++) await Promise.resolve() }

const harness = ({ highest = 29, average = 50, playing = true, layout = true, windowed = false, canAnimate = true, nativeDelay = 0 } = {}) => {
  const timer = clock()
  const context = { exports: {}, ...timer }
  vm.runInNewContext(source, context)
  const commands = []
  const positioned = []
  const manual = []
  const nativeWrites = []
  const stops = []
  let nativeOffset = 0
  let animationTimer = null
  let renderTimer = null
  let api
  const lines = Array.from({ length: 500 }, (_, index) => ({ time: index * 1000, text: `line ${index}`, extendedLyrics: [] }))
  const contentHeight = () => 720 + (highest + 1) * average
  const offsetFor = index => Math.max(0, 360 + index * average - (600 - average) * 0.42)
  const cancelAnimator = () => {
    if (animationTimer != null) timer.clearTimeout(animationTimer)
    animationTimer = null
  }
  const writeOffset = (offset, fromAnimation) => {
    // FlatList 的尾部空间只到已测量区域，Android 将远距离滚动截断在当前末尾。
    nativeOffset = Math.max(0, Math.min(offset, contentHeight() - 600))
    nativeWrites.push({ offset: nativeOffset, fromAnimation })
    api.scrolled(nativeOffset)
    if (windowed && highest < lines.length - 1 && nativeOffset >= contentHeight() - 600 && renderTimer == null) {
      renderTimer = timer.setTimeout(() => {
        renderTimer = null
        highest = Math.min(highest + 10, lines.length - 1)
        api.contentSizeChanged(360, contentHeight())
      }, 50)
    }
  }
  const nativeScroll = (offset, animated) => {
    const apply = () => {
      if (!animated) {
        // RN 0.73 的即时滚动不会停止旧 ObjectAnimator；后续 tick 仍会覆盖位置。
        writeOffset(offset, false)
        return
      }
      cancelAnimator()
      const start = nativeOffset
      let elapsed = 0
      const tick = () => {
        animationTimer = null
        elapsed += 16
        writeOffset(start + (offset - start) * Math.min(elapsed / 240, 1), true)
        if (elapsed < 240) animationTimer = timer.setTimeout(tick, 16)
      }
      animationTimer = timer.setTimeout(tick, 16)
    }
    if (nativeDelay) timer.setTimeout(apply, nativeDelay)
    else apply()
  }
  const list = {
    scrollToIndex(options) {
      commands.push({ kind: 'index', ...options })
      if (options.index > highest) {
        api.scrollToIndexFailed({ index: options.index, averageItemLength: average, highestMeasuredFrameIndex: highest })
      } else nativeScroll(offsetFor(options.index), options.animated)
    },
    scrollToOffset(options) {
      commands.push({ kind: 'offset', ...options })
      nativeScroll(options.offset, options.animated)
    },
  }
  api = context.exports.createLyricScroll({
    getList: () => list,
    isPlaying: () => playing,
    onPositioned: lines => positioned.push(lines),
    onManualChange: value => manual.push(value),
    canAnimate,
    stopScrollAnimation: () => new Promise(resolve => {
      // 模拟 UIBlock：之前提交的原生命令先执行，取消动画后才确认完成。
      stops.push('requested')
      timer.setTimeout(() => {
        cancelAnimator()
        stops.push('completed')
        resolve()
      }, 40)
    }),
  })
  if (layout) {
    api.setViewport(600, 360)
    api.setHeaderHeight(360)
  }
  api.contentSizeChanged(360, contentHeight())
  return {
    api,
    timer,
    lines,
    commands,
    positioned,
    manual,
    nativeWrites,
    stops,
    nativeOffset: () => nativeOffset,
    offsetFor,
    update: (line, visible = true, data = lines) => api.update({ line, visible, lines: data }),
    measure(index) { highest = Math.max(highest, index); api.lineMeasured(index) },
    indices: () => commands.filter(command => command.kind === 'index'),
  }
}

test('opening late in a song positions the current line before showing the virtualized list', () => {
  const h = harness()
  h.update(220)
  h.timer.advance(16)
  assert.deepEqual(h.indices().map(command => command.index), [220])
  assert.equal(h.positioned.length, 0, 'the estimated position must not be exposed')
  const estimate = h.commands.find(command => command.kind === 'offset')
  assert.ok(Math.abs(estimate.offset - (360 + 220 * 50)) < 600, 'bring the current line into view, not thirty rows before it')
  h.measure(220)
  h.timer.advance(32)
  assert.equal(h.positioned.length, 1)
  assert.equal(h.positioned[0], h.lines)
  assert.ok(h.indices().every(command => command.index === 220 && !command.animated))
  assert.equal(h.timer.tasks.size, 0)
})

test('a new playback position cancels a pending retry for the old distant line', () => {
  const h = harness()
  h.update(220)
  h.timer.advance(16)
  h.update(12)
  h.timer.advance(1000)
  assert.deepEqual(h.indices().map(command => command.index), [220, 12])
  assert.equal(h.positioned.length, 1)
  assert.equal(h.timer.tasks.size, 0)
})

test('changing songs cannot reveal or retry a previous lyric request', () => {
  const h = harness()
  const nextLines = h.lines.slice(0, 30)
  h.update(220)
  h.timer.advance(16)
  h.update(5, true, nextLines)
  h.timer.advance(1000)
  assert.deepEqual(h.indices().map(command => command.index), [220, 5])
  assert.deepEqual(h.positioned, [nextLines])
})

test('normal playback coalesces updates into one native animation without delayed replays', async() => {
  const h = harness({ highest: 499 })
  h.update(100)
  h.timer.advance(32)
  h.commands.length = 0
  h.update(101)
  h.update(102)
  h.timer.advance(100)
  h.update(103)
  h.timer.advance(40)
  await flush()
  h.timer.advance(1000)
  assert.deepEqual(h.indices().map(command => command.index), [102, 103])
  assert.ok(h.indices().every(command => command.animated))
  assert.equal(h.commands.filter(command => command.kind === 'offset').length, 0)
  assert.equal(h.timer.tasks.size, 0)
})

test('hidden lyrics stop pending work and catch up once when shown again', () => {
  const h = harness()
  h.update(200)
  h.timer.advance(16)
  h.update(200, false)
  h.timer.advance(1000)
  assert.equal(h.indices().length, 1)
  assert.equal(h.positioned.length, 0)
  h.measure(230)
  h.update(230)
  h.timer.advance(32)
  assert.deepEqual(h.indices().map(command => command.index), [200, 230])
  assert.equal(h.positioned.length, 1)
  assert.equal(h.indices()[1].animated, false)
})

test('unmount cancels both frame callbacks and measurement retries', () => {
  for (const elapsed of [0, 16]) {
    const h = harness()
    h.update(200)
    h.timer.advance(elapsed)
    h.api.dispose()
    const count = h.commands.length
    h.timer.advance(1000)
    assert.equal(h.commands.length, count)
    assert.equal(h.positioned.length, 0)
    assert.equal(h.timer.tasks.size, 0)
  }
})

test('dragging cancels positioning and momentum must finish before automatic following resumes', () => {
  const h = harness()
  h.update(200)
  h.timer.advance(16)
  h.api.beginDrag()
  h.api.endDrag()
  h.timer.advance(1000)
  h.api.beginMomentum()
  h.timer.advance(4000)
  assert.equal(h.indices().length, 1)
  h.measure(220)
  h.update(220)
  h.api.endMomentum()
  h.timer.advance(2999)
  assert.equal(h.indices().length, 1)
  h.timer.advance(33)
  assert.deepEqual(h.indices().map(command => command.index), [200, 220])
  assert.equal(h.indices()[1].animated, true)
  assert.deepEqual(h.manual, [true, false])
})

test('stalled measurement stops polling without declaring success and resumes even while paused', () => {
  const h = harness({ playing: false })
  h.update(400)
  h.timer.advance(10000)
  assert.equal(h.indices().length, 8)
  assert.equal(h.commands.filter(command => command.kind === 'offset').length, 8)
  assert.equal(h.positioned.length, 0)
  assert.equal(h.timer.tasks.size, 0)
  h.measure(400)
  h.timer.advance(32)
  assert.equal(h.positioned.length, 1)
  assert.equal(h.nativeOffset(), h.offsetFor(400))
})

test('initial positioning waits for the viewport instead of scrolling with zero dimensions', () => {
  const h = harness({ highest: 499, layout: false })
  h.update(300)
  h.timer.advance(32)
  assert.equal(h.commands.length, 0)
  assert.equal(h.positioned.length, 0)
  h.api.setViewport(600, 360)
  h.api.setHeaderHeight(360)
  h.timer.advance(32)
  assert.deepEqual(h.indices().map(command => command.index), [300])
  assert.equal(h.positioned.length, 1)
})

test('paused playback does not pull the lyrics back after a manual scroll', () => {
  const h = harness({ highest: 499, playing: false })
  h.update(20)
  h.timer.advance(32)
  h.api.beginDrag()
  h.api.endDrag()
  h.timer.advance(4000)
  assert.deepEqual(h.indices().map(command => command.index), [20])
  assert.equal(h.api.isManual(), false)
})

test('constant-height long lyrics keep advancing after Android clamps each estimated scroll', () => {
  const h = harness({ windowed: true, playing: false })
  h.update(400)
  h.timer.advance(10000)
  const estimates = h.commands.filter(command => command.kind === 'offset')
  assert.ok(estimates.length > 8, 'measurable progress must not exhaust a fixed retry budget')
  assert.equal(new Set(estimates.map(command => command.offset)).size, 1, 'unchanged estimates still need to be sent after content grows')
  assert.equal(h.positioned.length, 1)
  assert.equal(h.nativeOffset(), h.offsetFor(400))
  assert.equal(h.timer.tasks.size, 0)
})

test('new content wakes a stalled request without requiring a new lyric line', () => {
  const h = harness({ playing: false })
  h.update(400)
  h.timer.advance(2000)
  assert.equal(h.timer.tasks.size, 0)
  assert.equal(h.positioned.length, 0)
  const attempts = h.indices().length
  h.api.contentSizeChanged(360, 4000)
  h.timer.advance(16)
  assert.equal(h.indices().length, attempts + 1)
  h.measure(400)
  h.timer.advance(32)
  assert.equal(h.positioned.length, 1)
})

test('a distant seek waits for native animation cancellation before applying the new position', async() => {
  const h = harness({ highest: 499, nativeDelay: 8 })
  h.update(100)
  h.timer.advance(32)
  h.update(101)
  h.timer.advance(64)
  const beforeSeek = h.nativeOffset()
  h.update(300)
  h.timer.advance(39)
  assert.ok(h.nativeOffset() > beforeSeek, 'the native animator is still running until its UIBlock executes')
  assert.equal(h.indices().some(command => command.index === 300), false)
  assert.deepEqual(h.stops, ['requested'])
  h.timer.advance(1)
  await flush()
  h.timer.advance(64)
  assert.deepEqual(h.stops, ['requested', 'completed'])
  assert.equal(h.nativeOffset(), h.offsetFor(300))
  const completedWrites = h.nativeWrites.length
  h.timer.advance(1000)
  assert.equal(h.nativeOffset(), h.offsetFor(300))
  assert.equal(h.nativeWrites.length, completedWrites, 'the old animator cannot write again after the seek')
})

test('only the newest target can proceed after a pending native cancellation', async() => {
  const h = harness({ highest: 499 })
  h.update(100)
  h.timer.advance(32)
  h.update(101)
  h.timer.advance(32)
  h.update(300)
  h.update(250)
  h.timer.advance(40)
  await flush()
  h.timer.advance(1000)
  assert.deepEqual(h.indices().map(command => command.index), [100, 101, 250])
  assert.equal(h.nativeOffset(), h.offsetFor(250))
  assert.deepEqual(h.stops, ['requested', 'completed'])
})

test('unmount during native cancellation never resumes a queued target', async() => {
  const h = harness({ highest: 499 })
  h.update(100)
  h.timer.advance(32)
  h.update(101)
  h.timer.advance(32)
  h.update(300)
  h.api.dispose()
  h.timer.advance(40)
  await flush()
  h.timer.advance(1000)
  assert.deepEqual(h.indices().map(command => command.index), [100, 101])
  assert.deepEqual(h.stops, ['requested', 'completed'])
  assert.equal(h.timer.tasks.size, 0)
})

test('older APKs without native cancellation use immediate scrolling throughout', () => {
  const h = harness({ highest: 499, canAnimate: false })
  h.update(100)
  h.timer.advance(32)
  h.update(101)
  h.timer.advance(32)
  h.update(300)
  h.timer.advance(1000)
  assert.ok(h.indices().every(command => !command.animated))
  assert.equal(h.nativeOffset(), h.offsetFor(300))
  assert.deepEqual(h.stops, [])
})
