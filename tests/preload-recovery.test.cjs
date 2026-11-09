const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load, deferred, flush } = require('./helpers/load.cjs')

const EventHub = load('src/event/Event.ts', {}, { setImmediate }).default
const message = load('src/utils/message.ts')
const order = load('src/utils/apiSourceOrder.ts')
const song = id => ({ id, source: 'tx', name: id, singer: 'Artist', interval: '03:00', meta: {} })

// The scheduler and preload task are real, including the native adapter and asynchronous app events.
const harness = ({ resolveFailures = 0, headFailures = 0, positionFailures = 0, cleanupError = false } = {}) => {
  let now = 1000, timerId = 0, position = 5, buffered = 60, duration = 180
  let next = { musicInfo: song('next'), listId: 'queue' }
  let resolveGate, headGate
  const timers = new Map(), requests = [], reads = [], bodies = [], cancelled = [], failed = new Map(), cached = new Map(), clears = []
  const app = new EventHub(), events = new EventHub()
  const player = { isPlay: true, playMusicInfo: { musicInfo: song('current') }, progress: { maxPlayTime: 180 } }
  const setting = { 'player.preloadNext': true, 'player.cacheSize': '1024', 'player.playQuality': '128k',
    'player.urlSource': 'source', 'common.apiSource': 'user_api_a', 'common.apiSourceOrder': '["user_api_a","user_api_b"]' }
  const clock = {
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id },
    clearTimeout: id => { timers.delete(id) },
  }
  const globals = { Date: { now: () => now }, global: { lx: { isPlayedStop: false }, app_event: app, state_event: events } }
  const native = load('src/plugins/player/preload.ts', {
    'react-native': { NativeModules: { TrackPlayerModule: {
      preloadMusic: async(id, url, userAgent, maxBytes) => {
        const entry = { id, url, userAgent, maxBytes, pending: true }
        reads.push(entry)
        try {
          if (maxBytes > 0) {
            if (headFailures-- > 0) throw new Error('Temporary audio read failure')
            entry.gate = headGate
            if (entry.gate) await entry.gate.promise
            cached.set(url, maxBytes)
            return { cachedBytes: maxBytes, complete: false }
          }
          const body = { id, ...deferred() }
          bodies.push(body)
          entry.gate = body
          const result = await body.promise
          cached.set(url, result.cachedBytes)
          return result
        } finally {
          entry.pending = false
        }
      },
      cancelPreloadMusic: id => { cancelled.push(id); reads.find(entry => entry.id === id && entry.pending)?.gate?.reject(new Error('cancelled')) },
    } } },
    '@/utils/message': message, './playList': { defaultUserAgent: 'fixture' }, 'react-native-background-timer': { default: clock },
  }, globals)
  const preload = load('src/core/player/preload.ts', {
    '@/store/setting/state': { default: { setting } }, '@/utils/apiSourceOrder': order, '@/utils/message': message,
    '@/plugins/player/preload': native,
    '@/core/music/sourcePriority': {
      isMusicUrlFailed: url => (failed.get(url) ?? 0) > now,
      markMusicUrlFailed: url => { failed.set(url, now + 30000) },
    },
    '@/core/music': { getMusicUrl: async options => {
      requests.push(options)
      const url = `https://audio.test/${options.musicInfo.id}/${requests.length}`
      let aborted = false
      options.onCancel(() => { aborted = true; if (cleanupError) throw new Error('Cleanup failed') })
      if (resolveGate) await resolveGate.promise
      if (aborted) throw new Error(message.requestMsg.cancelRequest)
      if (resolveFailures-- > 0) throw new Error('Temporary source failure')
      await options.validateUrl(url)
      return url
    } },
  }, globals)
  app.on('play', () => { player.isPlay = true })
  for (const event of ['pause', 'stop', 'error']) app.on(event, () => { player.isPlay = false })
  load('src/core/init/player/preloadNextMusic.ts', {
    'react-native-track-player': { default: {
      getPosition: async() => { if (positionFailures-- > 0) throw new Error('Position unavailable'); return position },
      getBufferedPosition: async() => buffered,
      getDuration: async() => duration,
    } },
    'react-native-background-timer': { default: clock },
    '@/core/player/player': { getNextPlayMusicInfo: async() => next, resetRandomNextMusicInfo() {} },
    '@/core/player/preload': preload, '@/plugins/player/preload': native,
    '@/store/player/state': { default: player }, '@/store/setting/state': { default: { setting } }, '@/utils/message': message,
  }, globals).default()
  const clearNative = async gate => {
    clears.push(now)
    // Model AudioPreloader.clear(): cancel the current native read, then delete its spans.
    const pending = reads.findLast(entry => entry.pending)
    pending?.gate?.reject(Object.assign(new Error('Cache cleared'), { code: 'preload_cancelled' }))
    if (gate) await gate.promise
    cached.clear()
  }
  return {
    preload, player, setting, requests, reads, bodies, cancelled, timers, cached, clears,
    failures: count => { resolveFailures = count },
    resolveGate: gate => { resolveGate = gate },
    headGate: gate => { headGate = gate },
    clearNative,
    clearCache: gate => preload.clearPlaybackCache(() => clearNative(gate)),
    buffer: (nextPosition, nextBuffered, nextDuration = 180) => { position = nextPosition; buffered = nextBuffered; duration = nextDuration },
    emit: async event => { app.emit(event); await flush() },
    play: async() => { app.emit('playerPlaying'); app.emit('play'); await flush() },
    config: async(key, value) => { setting[key] = value; events.emit('configUpdated', [key]); await flush() },
    next: value => { next = { musicInfo: song(value), listId: 'queue' } },
    advance: async ms => {
      const target = now + ms
      for (;;) {
        const entry = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!entry) break
        now = Math.max(now, entry[1].at)
        timers.delete(entry[0])
        entry[1].fn()
        await flush()
      }
      now = target
      await flush()
    },
  }
}

for (const stage of ['resolveFailures', 'headFailures']) {
  test(`a failed ${stage} task is released and retries in the background after cooldown`, async() => {
    const h = harness({ [stage]: 1 })
    await h.advance(3000)
    assert.equal(h.requests.length, 1)
    assert.equal(h.preload.hasPreloadMusic(song('next')), false)
    await h.advance(29999)
    assert.equal(h.requests.length, 1)
    await h.advance(1)
    assert.equal(h.requests.length, 2)
    assert.equal(h.reads.at(-1).maxBytes, 0)
    assert.equal(h.preload.hasPreloadMusic(song('next')), true)
    h.preload.cancelPreload()
  })
}

test('a later background-transfer recovery failure also wakes the scheduler', async() => {
  const h = harness()
  await h.advance(3000)
  assert.equal(h.bodies.length, 1)
  h.failures(1)
  h.bodies[0].reject(new Error('Connection closed'))
  await flush()
  assert.equal(h.requests.length, 2)
  assert.equal(h.requests[1].isRefresh, true)
  assert.equal(h.preload.hasPreloadMusic(song('next')), false)
  await h.advance(30000)
  assert.equal(h.requests.length, 3)
  assert.equal(h.bodies.length, 2)
  h.preload.cancelPreload()
})

test('a transient native progress-query failure does not disable preloading for the rest of the song', async() => {
  const h = harness({ positionFailures: 1 })
  await h.advance(3000)
  assert.equal(h.requests.length, 0)
  await h.advance(30000)
  assert.equal(h.requests.length, 1)
  h.preload.cancelPreload()
})

test('a cancellation cleanup error cannot suppress the failure notification or retry', async() => {
  const h = harness({ resolveFailures: 1, cleanupError: true })
  await h.advance(3000)
  assert.equal(h.preload.hasPreloadMusic(song('next')), false)
  await h.advance(30000)
  assert.equal(h.requests.length, 2)
  assert.equal(h.preload.hasPreloadMusic(song('next')), true)
  h.preload.cancelPreload()
})

test('duplicate playing notifications cannot keep postponing the stable-playback deadline', async() => {
  const h = harness()
  for (let i = 0; i < 3; i++) { await h.play(); await h.advance(1000) }
  assert.equal(h.requests.length, 1)
  h.preload.cancelPreload()
})

test('confirmed play resumes the scheduler even if a separate playerPlaying notification was missed', async() => {
  const h = harness()
  await h.emit('pause')
  await h.emit('play')
  await h.advance(3000)
  assert.equal(h.requests.length, 1)
  h.preload.cancelPreload()
})

test('fully buffered short audio uses the native duration when UI duration is not available', async() => {
  const h = harness()
  h.player.progress.maxPlayTime = 0
  h.buffer(4, 8, 8)
  await h.advance(3000)
  assert.equal(h.requests.length, 1)
  h.preload.cancelPreload()
})

test('persistent failures back off for 30 and 60 seconds, then wait for another track', async() => {
  const h = harness({ resolveFailures: 100 })
  await h.advance(3000)
  assert.equal(h.requests.length, 1)
  await h.advance(30000)
  assert.equal(h.requests.length, 2)
  await h.advance(59999)
  assert.equal(h.requests.length, 2)
  await h.advance(1)
  assert.equal(h.requests.length, 3)
  await h.advance(180000)
  assert.equal(h.requests.length, 3)
  assert.equal(h.timers.size, 0)
  h.failures(0)
  h.player.playMusicInfo = { musicInfo: song('new current') }
  h.next('new next')
  await h.emit('musicToggled')
  await h.play()
  await h.advance(3000)
  assert.equal(h.requests.length, 4)
  assert.equal(h.requests[3].musicInfo.id, 'new next')
  h.preload.cancelPreload()
})

test('pausing during cooldown keeps retries dormant until playback is stable again', async() => {
  const h = harness({ resolveFailures: 1 })
  await h.advance(3000)
  await h.emit('pause')
  await h.advance(60000)
  assert.equal(h.requests.length, 1)
  assert.equal(h.timers.size, 0)
  await h.play()
  await h.advance(2999)
  assert.equal(h.requests.length, 1)
  await h.advance(1)
  assert.equal(h.requests.length, 2)
  h.preload.cancelPreload()
})

test('a late notification for the already-playing track does not disable scheduling', async() => {
  const h = harness()
  await h.play()
  await h.emit('musicToggled')
  await h.advance(3000)
  assert.equal(h.requests.length, 1)
  h.preload.cancelPreload()
})

test('foreground takeover owns a pending failure and does not restart an old background task', async() => {
  const h = harness(), gate = deferred()
  h.resolveGate(gate)
  await h.advance(3000)
  const foreground = h.preload.takePreloadedMusicUrl(song('next'), () => {})
  assert.ok(foreground)
  const rejected = assert.rejects(foreground, /offline/)
  gate.reject(new Error('offline'))
  await rejected
  await h.advance(180000)
  assert.equal(h.requests.length, 1)
})

test('a cancelled old lookup cannot retry over the replacement next track', async() => {
  const h = harness(), gate = deferred()
  h.resolveGate(gate)
  await h.advance(3000)
  h.resolveGate(null)
  h.next('replacement')
  await h.emit('playQueueUpdate')
  await h.advance(0)
  assert.equal(h.requests.length, 2)
  gate.reject(new Error('late failure'))
  await flush()
  await h.advance(180000)
  assert.equal(h.requests.length, 2)
  assert.equal(h.preload.hasPreloadMusic(song('replacement')), true)
  h.preload.cancelPreload()
})

test('disabling preloading cancels a scheduled retry and enabling it starts a fresh attempt', async() => {
  const h = harness({ resolveFailures: 1 })
  await h.advance(3000)
  await h.config('player.preloadNext', false)
  await h.advance(180000)
  assert.equal(h.requests.length, 1)
  assert.equal(h.timers.size, 0)
  await h.config('player.preloadNext', true)
  await h.advance(0)
  assert.equal(h.requests.length, 2)
  h.preload.cancelPreload()
})

for (const completed of [false, true]) {
  test(`clearing ${completed ? 'completed' : 'in-flight'} cached audio releases the task and restarts only after clearing ends`, async() => {
    const h = harness(), clearing = deferred()
    await h.advance(3000)
    if (completed) {
      h.bodies[0].resolve({ cachedBytes: 4000000, complete: true })
      await flush()
    }
    assert.equal(h.preload.hasPreloadMusic(song('next')), true)
    const clear = h.clearCache(clearing)
    await flush()
    assert.equal(h.preload.hasPreloadMusic(song('next')), false)
    await h.advance(60000)
    assert.equal(h.requests.length, 1)
    assert.equal(h.timers.size, 0)
    assert.equal(h.preload.preloadMusic(song('next')), null)
    clearing.resolve()
    await clear
    assert.equal(h.cached.size, 0)
    await h.advance(0)
    assert.equal(h.requests.length, 2)
    assert.equal(h.bodies.length, 2)
    assert.equal(h.preload.hasPreloadMusic(song('next')), true)
    h.preload.cancelPreload()
  })
}

test('cache clearing restarts only with stable playback and enough current native buffer', async() => {
  const h = harness(), clearing = deferred()
  await h.advance(3000)
  const clear = h.clearCache(clearing)
  await h.emit('pause')
  await h.advance(60000)
  clearing.resolve()
  await clear
  await h.advance(60000)
  assert.equal(h.requests.length, 1)
  assert.equal(h.timers.size, 0)
  h.buffer(5, 7)
  await h.play()
  await h.advance(2999)
  assert.equal(h.requests.length, 1)
  await h.advance(1)
  assert.equal(h.requests.length, 1)
  h.buffer(5, 60)
  await h.advance(3000)
  assert.equal(h.requests.length, 2)
  h.preload.cancelPreload()
})

test('a cache-clear failure releases the clearing guard without waking playback that was stopped', async() => {
  const h = harness(), clearing = deferred()
  await h.advance(3000)
  const clear = h.clearCache(clearing)
  const rejection = assert.rejects(clear, /Disk unavailable/)
  await h.emit('stop')
  clearing.reject(new Error('Disk unavailable'))
  await rejection
  await h.advance(60000)
  assert.equal(h.requests.length, 1)
  assert.equal(h.timers.size, 0)
  await h.play()
  await h.advance(3000)
  assert.equal(h.requests.length, 2)
  h.preload.cancelPreload()
})

test('an old source lookup cannot restore a task or write audio after cache clearing', async() => {
  const h = harness(), lookup = deferred(), clearing = deferred()
  h.resolveGate(lookup)
  await h.advance(3000)
  const clear = h.clearCache(clearing)
  h.resolveGate(null)
  lookup.resolve()
  await flush()
  assert.equal(h.reads.length, 0)
  await h.advance(60000)
  assert.equal(h.requests.length, 1)
  clearing.resolve()
  await clear
  await h.advance(0)
  assert.equal(h.requests.length, 2)
  assert.equal(h.reads.length, 2)
  h.preload.cancelPreload()
})

for (const pendingHead of [false, true]) {
  test(`cache clearing preserves a foreground takeover ${pendingHead ? 'already reading' : 'about to read'} the first audio bytes`, async() => {
    const h = harness(), lookup = deferred(), head = deferred(), clearing = deferred()
    if (pendingHead) h.headGate(head)
    else h.resolveGate(lookup)
    await h.advance(3000)
    h.player.playMusicInfo = { musicInfo: song('next') }
    h.next('third')
    h.preload.keepPreloadFor(song('next'))
    const foreground = h.preload.takePreloadedMusicUrl(song('next'), () => {})
    assert.ok(foreground)
    const clear = h.clearCache(clearing)
    lookup.resolve()
    await flush()
    assert.equal(await foreground, 'https://audio.test/next/1')
    assert.equal(h.cancelled.length, 0)
    await h.emit('musicToggled')
    await h.play()
    await h.advance(60000)
    assert.equal(h.requests.length, 1)
    clearing.resolve()
    await clear
    h.headGate(null)
    await h.advance(0)
    assert.equal(h.requests.length, 2)
    assert.equal(h.requests[1].musicInfo.id, 'third')
    h.preload.cancelPreload()
  })
}

test('clearing does not mask an explicit foreground cancellation', async() => {
  const h = harness(), head = deferred(), clearing = deferred()
  h.headGate(head)
  await h.advance(3000)
  let cancelForeground
  const foreground = h.preload.takePreloadedMusicUrl(song('next'), cancel => { cancelForeground = cancel })
  const rejection = assert.rejects(foreground, message.isRequestCancelled)
  const clear = h.clearCache(clearing)
  cancelForeground()
  await rejection
  await h.advance(60000)
  assert.equal(h.requests.length, 1)
  clearing.resolve()
  await clear
  h.headGate(null)
  h.preload.cancelPreload()
})

test('a late native cancellation after clearing finishes still preserves the foreground URL', async() => {
  const h = harness(), head = deferred()
  h.headGate(head)
  await h.advance(3000)
  h.player.playMusicInfo = { musicInfo: song('next') }
  h.next('third')
  const foreground = h.preload.takePreloadedMusicUrl(song('next'), () => {})
  await h.emit('musicToggled')
  // Model bridge delivery arriving after the native clear Promise has already resolved.
  await h.preload.clearPlaybackCache(async() => { h.cached.clear() })
  assert.equal(h.preload.isPreloadCacheClearing(), false)
  head.reject(Object.assign(new Error('Cache cleared'), { code: 'preload_cancelled' }))
  assert.equal(await foreground, 'https://audio.test/next/1')
  assert.equal(h.requests.length, 1)
  h.preload.cancelPreload()
})

test('the resource-cache button waits for every deletion after an early failure before restarting preload', async() => {
  const h = harness(), appClear = deferred(), nativeClear = deferred(), toasts = []
  await h.advance(3000)
  let clean
  const jsx = (type, props) => {
    if (type === 'Button') clean = props.onPress
    return { type, props }
  }
  const screen = load('src/screens/Home/Views/Setting/settings/Other/ResourceCache.tsx', {
    react: { memo: component => component, useState: initial => [initial === null ? '1 KiB' : initial, () => {}], useEffect() {} },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { View: 'View', StyleSheet: { create: value => value } },
    '../../components/SubTitle': { default: 'SubTitle' }, '../../components/Button': { default: 'Button' },
    '@/components/common/Text': { default: 'Text' }, '@/utils': { sizeFormate: String },
    '@/lang': { useI18n: () => key => key },
    '@/utils/tools': { toast: text => { toasts.push(text) }, confirmDialog: async() => true,
      resetNotificationPermissionCheck: async() => {}, resetIgnoringBatteryOptimizationCheck: async() => {} },
    '@/utils/nativeModules/cache': { getAppCacheSize: async() => 0, clearAppCache: () => appClear.promise },
    '@/plugins/player/utils': { getCacheSize: async() => 0, clearCache: () => h.clearNative(nativeClear) },
    '@/utils/data': { clearMusicUrl: async() => {} }, '@/core/cacheLifecycle': { releaseIdleCaches() {} },
    '@/core/player/preload': h.preload,
  })
  screen.default()
  clean()
  await flush()
  assert.equal(h.clears.length, 1)
  appClear.reject(new Error('App cache unavailable'))
  await flush()
  await h.advance(60000)
  assert.equal(h.preload.isPreloadCacheClearing(), true)
  assert.equal(h.requests.length, 1)
  assert.equal(h.timers.size, 0)
  assert.deepEqual(toasts, [])
  nativeClear.resolve()
  await flush()
  assert.equal(h.preload.isPreloadCacheClearing(), false)
  assert.deepEqual(toasts, ['list_remove_cache_fail_tip'])
  await h.advance(0)
  assert.equal(h.requests.length, 2)
  h.preload.cancelPreload()
})

test('overlapping cache clears hold preloading until both operations settle', async() => {
  const h = harness(), first = deferred(), second = deferred()
  await h.advance(3000)
  const firstClear = h.clearCache(first), secondClear = h.clearCache(second)
  first.resolve()
  await firstClear
  await h.advance(60000)
  assert.equal(h.preload.isPreloadCacheClearing(), true)
  assert.equal(h.requests.length, 1)
  second.resolve()
  await secondClear
  await h.advance(0)
  assert.equal(h.preload.isPreloadCacheClearing(), false)
  assert.equal(h.requests.length, 2)
  h.preload.cancelPreload()
})
