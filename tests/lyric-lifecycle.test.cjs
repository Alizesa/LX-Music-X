const { test } = require('node:test')
const { spawnSync } = require('node:child_process')
const { harness, lyrics, load, deferred, flush, assert } = require('./helpers/lyric-runtime.cjs')

test('lyrics do not parse or schedule while unused, release hidden rows, and resume at native time', async() => {
  const h = await harness(); const frame = h.frame()
  h.api.setLyric(lyrics())
  h.api.play(0)
  assert.equal(h.tasks.size, 0)
  assert.equal(h.parser().lines.length, 0)
  h.setPosition(12000)
  h.render(frame)
  await flush()
  assert.equal(h.render(frame).current.line, 12)
  assert.equal(h.parser().lines.length, 1000)
  assert.ok(h.tasks.size > 0)
  frame.visible = false
  assert.equal(h.render(frame).lines.length, 0)
  assert.equal(h.parser().lines.length, 0)
  assert.equal(h.tasks.size, 0)
  h.api.setLyric(lyrics(40, 'New'))
  h.api.play(20000)
  h.setPosition(23000)
  assert.equal(h.tasks.size, 0)
  frame.visible = true
  h.render(frame)
  await flush()
  assert.equal(h.render(frame).current.text, 'New 23')
  h.host.unmount(frame)
  assert.equal(h.tasks.size, 0)
})

test('multiple lyric consumers share scheduling until the last one hides', async() => {
  const h = await harness(); const first = h.frame(); const second = h.frame()
  h.api.setLyric(lyrics(30)); h.api.play(0)
  h.render(first); h.render(second)
  await flush()
  assert.equal(h.reads(), 1)
  first.visible = false
  h.render(first)
  assert.ok(h.tasks.size > 0)
  second.visible = false
  h.render(second)
  assert.equal(h.tasks.size, 0)
  h.host.unmount(first); h.host.unmount(second)
})

test('a paused lyric page aligns on return without starting a persistent timer', async() => {
  const h = await harness(); const frame = h.frame()
  h.api.setLyric(lyrics(30)); h.api.play(0); h.api.pause()
  h.setPosition(6500)
  h.render(frame)
  await flush()
  assert.equal(h.render(frame).current.line, 6)
  assert.equal(h.tasks.size, 0)
  h.host.unmount(frame)
})

test('a late native position after hiding cannot restart scheduling or refill the hidden page', async() => {
  const gate = deferred(); const h = await harness({ read: () => gate.promise }); const frame = h.frame()
  h.api.setLyric(lyrics(30)); h.api.play(0)
  h.render(frame)
  frame.visible = false
  h.render(frame)
  gate.resolve(14000)
  await flush()
  assert.equal(frame.dirty, false)
  assert.equal(h.tasks.size, 0)
  assert.equal(h.parser().lines.length, 0)
  assert.equal(h.render(frame).lines.length, 0)
  h.host.unmount(frame)
})

test('a late native position from the previous song cannot override a new lyric or playback', async() => {
  const gate = deferred(); const h = await harness({ read: () => gate.promise }); const frame = h.frame()
  h.api.setLyric(lyrics(30)); h.api.play(0)
  h.render(frame)
  h.api.setLyric(lyrics(12, 'Current')); h.api.play(4000)
  gate.resolve(19000)
  await flush()
  assert.equal(h.render(frame).current.text, 'Current 4')
  h.host.unmount(frame)
})

test('hidden lyric rows are collectible through the real scroll controller and hook state', () => {
  const result = spawnSync(process.execPath, ['--expose-gc', '-e', `
    const { harness, lyrics, flush, assert } = require('./tests/helpers/lyric-runtime.cjs')
    ;(async () => {
      const h = await harness({ scroll: true }); const frame = h.frame()
      h.api.setLyric(lyrics()); h.api.play(0)
      h.render(frame)
      await flush()
      let view = h.render(frame)
      const reference = new WeakRef(view.lines)
      view.scroll.handleLayout({ nativeEvent: { layout: { height: 600, width: 360 } } })
      h.advance(64)
      view = h.render(frame)
      assert.equal(view.scroll.ready, true)
      view = null
      frame.visible = false
      h.render(frame)
      h.api.setLyric(lyrics(10, 'New')); h.api.play(0)
      for (let index = 0; index < 10; index++) { await flush(); global.gc() }
      assert.equal(reference.deref() === undefined, true, 'hidden lyric rows are still retained')
      assert.equal(h.tasks.size, 0)
      h.host.unmount(frame)
    })().catch(error => { console.error(error); process.exitCode = 1 })
  `], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('late core playback positions do not restart either lyric engine after pause or stop', async() => {
  for (const cancel of ['pause', 'stop']) {
    const gate = deferred(); const calls = []
    const state = { isPlay: true, playMusicInfo: {} }
    const api = load('src/core/lyric.ts', {
      '@/plugins/lyric': { play: value => calls.push(['js', value]), pause() {}, setLyric() {} },
      '@/core/desktopLyric': { playDesktopLyric: async value => calls.push(['native', value]), pauseDesktopLyric: async() => {}, setDesktopLyric: async() => {} },
      '@/plugins/player': { getPosition: () => gate.promise },
      '@/store/player/state': { default: state },
      '@/store/setting/state': { default: { setting: {} } },
      '@/plugins/player/utils': {},
    })
    api.play()
    api[cancel]()
    gate.resolve(23)
    await flush()
    assert.deepEqual(calls, [])
  }
})

test('translation, romanization and playback rate survive hidden periods without background parsing', async() => {
  const h = await harness(); const frame = h.frame()
  h.api.setLyric(lyrics(30), lyrics(30, 'Translation'), lyrics(30, 'Roma'))
  h.api.toggleTranslation(true); h.api.toggleRoma(true); h.api.setPlaybackRate(2)
  h.api.play(0)
  assert.equal(h.parser().lines.length, 0)
  assert.equal(h.tasks.size, 0)
  h.setPosition(4000)
  h.render(frame)
  await flush()
  assert.deepEqual(Array.from(h.render(frame).lines[4].extendedLyrics), ['Translation 4', 'Roma 4'])
  h.advance(1000)
  assert.equal(h.render(frame).current.line, 6)
  frame.visible = false
  h.render(frame)
  h.api.pause(); h.api.toggleTranslation(false); h.api.setPlaybackRate(1)
  h.setPosition(6000)
  frame.visible = true
  h.render(frame)
  await flush()
  assert.deepEqual(Array.from(h.render(frame).lines[6].extendedLyrics), ['Roma 6'])
  assert.equal(h.tasks.size, 0)
  h.host.unmount(frame)
})

test('lyric scrolling waits for position synchronization instead of first revealing the top', async() => {
  const gate = deferred(); const h = await harness({ read: () => gate.promise, scroll: true }); const frame = h.frame()
  h.api.setLyric(lyrics(50)); h.api.play(0)
  const initial = h.render(frame)
  initial.scroll.handleLayout({ nativeEvent: { layout: { height: 600, width: 360 } } })
  h.advance(64)
  assert.equal(h.scrolls.length, 0)
  assert.equal(h.render(frame).scroll.ready, false)
  gate.resolve(23000)
  await flush()
  h.render(frame)
  h.advance(64)
  assert.equal(h.scrolls[0].index, 23)
  assert.equal(h.render(frame).scroll.ready, true)
  h.host.unmount(frame)
})

test('native desktop lyric playback continues independently of absent JS page consumers', async() => {
  const h = await harness(); const calls = []
  const state = { isPlay: true, playMusicInfo: {} }
  const api = load('src/core/lyric.ts', {
    '@/plugins/lyric': h.api,
    '@/core/desktopLyric': { playDesktopLyric: async time => calls.push(['play', time]), pauseDesktopLyric: async() => calls.push(['pause']), setDesktopLyric: async() => {} },
    '@/plugins/player': { getPosition: async() => 9 },
    '@/store/player/state': { default: state },
    '@/store/setting/state': { default: { setting: {} } },
    '@/plugins/player/utils': {},
  })
  await api.init()
  h.api.setLyric(lyrics(30))
  api.play()
  await flush()
  assert.deepEqual(calls, [['play', 9000]])
  assert.equal(h.tasks.size, 0)
  api.pause()
  assert.deepEqual(calls, [['play', 9000], ['pause']])
})

test('lyrics arriving after playback is paused align and become visible without another play event', async() => {
  const h = await harness({ scroll: true }); const frame = h.frame()
  h.setPosition(15000)
  h.render(frame)
  await flush()
  h.api.pause()
  h.api.setLyric(lyrics(30))
  await flush()
  const view = h.render(frame)
  view.scroll.handleLayout({ nativeEvent: { layout: { height: 600, width: 360 } } })
  h.advance(64)
  assert.equal(h.render(frame).current.line, 15)
  assert.equal(h.render(frame).scroll.ready, true)
  assert.equal(h.parser().isPlay, false)
  assert.equal(h.tasks.size, 0)
  h.host.unmount(frame)
})
