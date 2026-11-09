const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { load, deferred, flush } = require('./helpers/load.cjs')
const { jsx, hookHost, elements } = require('./helpers/react.cjs')

const writerModule = load('src/utils/debugLogWriter.ts')
const ioHarness = () => {
  const values = new Map(), calls = [], timers = new Map()
  let now = 1000, nextTimer = 0
  const files = {
    privateStorageDirectoryPath: '/private',
    existsFile: async path => { calls.push('exists'); return values.has(path) },
    stat: async path => ({ size: Buffer.byteLength(values.get(path) ?? '') }),
    readFile: async path => { calls.push('read'); return values.get(path) ?? '' },
    writeFile: async(path, data) => { calls.push('write'); values.set(path, data) },
    appendFile: async(path, data) => { calls.push('append'); values.set(path, (values.get(path) ?? '') + data) },
    moveFile: async(from, to) => { calls.push('move'); values.set(to, values.get(from)); values.delete(from) },
    unlink: async path => { calls.push('unlink'); values.delete(path) },
  }
  const clock = {
    setTimeout: (fn, delay) => { timers.set(++nextTimer, { fn, at: now + delay }); return nextTimer },
    clearTimeout: id => { timers.delete(id) },
  }
  class ClockDate extends Date {
    constructor(value = now) { super(value) }
    static now() { return now }
  }
  return { files, values, calls, timers, clock, Date: ClockDate,
    advance: async ms => {
      const target = now + ms
      for (let count = 0; count < 1000; count++) {
        const next = [...timers].filter(([, value]) => value.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        timers.delete(next[0]); now = next[1].at; next[1].fn(); await flush()
      }
      now = target
      await flush()
    },
  }
}
const logHarness = () => {
  const h = ioHarness()
  const log = load('src/utils/playbackLog.ts', {
    'react-native-background-timer': { default: h.clock }, '@/utils/fs': h.files, './debugLogWriter': writerModule,
  }, { Date: h.Date })
  return { ...h, log, entries: async() => (await log.readPlaybackLogs()).split('\n').filter(Boolean).map(line => JSON.parse(line)) }
}

const diagnosticSong = { id: 'tx_diagnostic', source: 'tx', interval: '03:00', meta: { songId: 'diagnostic', strMediaMid: 'media' } }
const diagnosticUrl = 'https://audio.test/M500media.mp3?vkey=private-value'
const audioDiagnosticsHarness = ({ inspect = async() => ({ readable: true, mime: 'audio/mpeg', durationMs: 180000 }),
  response = param => ({ code: 0, req_1: { data: { midurlinfo: [{ result: 0, purl: `${diagnosticUrl}&channel=${param.platform}` }] } } }),
  cookie = 'uin=123; qm_keyst=private-value' } = {}) => {
  const h = logHarness(), channels = [], cancelled = [], probes = []
  const message = load('src/utils/message.ts')
  const abort = load('src/utils/abort.ts', { './message': message })
  const remote = load('src/utils/nativeModules/remoteAudio.ts', {
    'react-native': { NativeModules: { UtilsModule: {
      startRemoteAudioProbe: (_id, url) => { probes.push(url); return inspect(url) }, cancelRemoteAudioProbe: id => { cancelled.push(id) },
    } } },
    'react-native-background-timer': { default: h.clock }, '@/utils/abort': abort,
  }, { Date: h.Date })
  const qq = load('src/core/qqMusicUrl.ts', {
    './qqMusic': {
      getQQMusicSession: async() => ({ cookie }), getQQMusicUin: () => '123', QQMusicSessionExpiredError: class extends Error {},
      postAuthedMusicu: async(_cookie, body) => { channels.push(body.req_1.param.platform); return response(body.req_1.param) },
    },
    '@/utils/nativeModules/remoteAudio': remote, '@/utils/message': message, '@/utils/abort': abort,
    'react-native-background-timer': { default: h.clock }, '@/utils/playbackLog': h.log,
  }, { Date: h.Date })
  h.log.setPlaybackLogEnabled(true)
  return { ...h, qq, channels, cancelled, probes }
}

test('audio diagnostics distinguish a probe deadline from an observed short preview', async() => {
  const timeout = audioDiagnosticsHarness({ inspect: () => new Promise(() => {}) })
  const failed = assert.rejects(timeout.qq.validateQQMusicUrl(diagnosticSong, diagnosticUrl, undefined, false,
    { playId: 'play-one', urlId: 'url-one', apiId: 'user_api_a' }), { code: 'timeout', message: 'QQ Music audio probe timed out' })
  await timeout.advance(5000)
  await failed
  const timedOut = (await timeout.entries()).find(entry => entry.event === 'url.audio_check').data
  assert.equal(timedOut.reason, 'timeout')
  assert.equal(timedOut.expectedMs, 180000)
  assert.equal(timedOut.probe.elapsedMs, 5000)
  assert.equal(timedOut.probe.durationMs, undefined)
  assert.equal(timedOut.accepted, false)
  assert.equal(timedOut.apiId, 'user_api_a')
  assert.equal(timedOut.urlId, 'url-one')
  assert.equal(timeout.cancelled.length, 1)

  const preview = audioDiagnosticsHarness({ inspect: async() => ({ readable: true, mime: 'audio/mpeg', durationMs: 30000,
    requests: 1, bytesRead: 65536, httpStatus: 206 }) })
  await assert.rejects(preview.qq.validateQQMusicUrl(diagnosticSong, diagnosticUrl), { code: 'duration_mismatch', message: 'QQ Music audio is incomplete' })
  const checked = (await preview.entries()).find(entry => entry.event === 'url.audio_check').data
  assert.equal(checked.reason, 'duration_mismatch')
  assert.equal(checked.expectedMs, 180000)
  assert.deepEqual(checked.probe, { readable: true, mime: 'audio/mpeg', durationMs: 30000, requests: 1, bytesRead: 65536, httpStatus: 206 })
  assert.equal(checked.accepted, false)
  assert.equal((await preview.log.exportPlaybackLogs()).includes('private-value'), false)
})

test('account diagnostics show App preview rejection followed by a complete web candidate without credentials', async() => {
  const h = audioDiagnosticsHarness({ inspect: async url => ({ readable: true, mime: 'audio/mpeg', durationMs: url.endsWith('23') ? 30000 : 180000 }) })
  const result = await h.qq.getQQMusicUrlByAccount(diagnosticSong, '128k', '128k', { trace: { playId: 'play-one', urlId: 'url-one' } })
  assert.equal(result.url, `${diagnosticUrl}&channel=20`)
  assert.deepEqual(h.channels, ['23', '20'])
  const entries = await h.entries()
  const probes = entries.filter(entry => entry.event === 'url.account_probe').map(entry => entry.data)
  assert.deepEqual(probes.map(probe => [probe.platform, probe.reason, probe.accepted]), [['23', 'duration_mismatch', false], ['20', 'complete', true]])
  assert.ok(probes.every(probe => probe.playId === 'play-one' && probe.urlId === 'url-one' && probe.expectedMs === 180000))
  assert.equal(JSON.stringify(entries).includes('private-value'), false)
  assert.equal(JSON.stringify(entries).includes('M500media'), false)
})

test('account diagnostics explain missing login and empty channel responses without probing audio', async() => {
  const loggedOut = audioDiagnosticsHarness({ cookie: '' })
  assert.equal(await loggedOut.qq.getQQMusicUrlByAccount(diagnosticSong, '128k', '128k'), null)
  assert.equal(loggedOut.channels.length, 0)
  assert.equal((await loggedOut.entries()).find(entry => entry.event === 'url.account_skip').data.reason, 'no_session')

  const empty = audioDiagnosticsHarness({ response: () => ({ code: 0, req_1: { data: { midurlinfo: [{ result: 0, purl: '' }] } } }) })
  assert.equal(await empty.qq.getQQMusicUrlByAccount(diagnosticSong, '128k', '128k'), null)
  assert.deepEqual(empty.channels, ['23', '20'])
  assert.equal(empty.probes.length, 0)
  const candidates = (await empty.entries()).filter(entry => entry.event === 'url.account_candidates').map(entry => entry.data)
  assert.deepEqual(candidates.map(item => [item.platform, item.reason, item.selected]), [['23', 'empty_urls', 0], ['20', 'empty_urls', 0]])
})

test('an account candidate batch deadline is recorded before the web channel takes over', async() => {
  const h = audioDiagnosticsHarness({ inspect: url => url.endsWith('23') ? new Promise(() => {})
    : Promise.resolve({ readable: true, mime: 'audio/mpeg', durationMs: 180000 }) })
  const pending = h.qq.getQQMusicUrlByAccount(diagnosticSong, '128k', '128k')
  await flush()
  await h.advance(5000)
  assert.equal((await pending).url, `${diagnosticUrl}&channel=20`)
  const batches = (await h.entries()).filter(entry => entry.event === 'url.account_candidates_done').map(entry => entry.data)
  assert.deepEqual(batches.map(item => [item.platform, item.reason]), [['23', 'timeout'], ['20', 'complete']])
  assert.equal(h.cancelled.length, 1)
})

test('per-song QQ response errors are distinct from an empty successful response or a media probe failure', async() => {
  const h = audioDiagnosticsHarness({ response: () => ({ code: 0, req_1: { data: { midurlinfo: [{ result: 104003, purl: '' }] } } }) })
  assert.equal(await h.qq.getQQMusicUrlByAccount(diagnosticSong, '128k', '128k'), null)
  assert.deepEqual(h.channels, ['23', '20'])
  assert.equal(h.probes.length, 0)
  const candidates = (await h.entries()).filter(entry => entry.event === 'url.account_candidates').map(entry => entry.data)
  assert.deepEqual(candidates.map(item => [item.platform, item.reason, item.resultCodes]), [
    ['23', 'item_rejected', [104003]], ['20', 'item_rejected', [104003]],
  ])
})

test('disabled logging does not evaluate payloads, create timers or touch disk', () => {
  const h = logHarness()
  let evaluated = 0
  h.log.registerPlaybackLogSnapshot('scheduler', () => { evaluated++; return { initialized: true } })
  h.log.playbackLog('test', () => { evaluated++; return { value: 'unused' } })
  h.log.playbackLogState('wait', 'not_ready', () => { evaluated++; return {} })
  assert.equal(h.log.playbackLogId({}, 'task'), undefined)
  assert.equal(evaluated, 0)
  assert.equal(h.timers.size, 0)
  assert.equal(h.calls.length, 0)
})

test('enabling records an immediate snapshot and disabling drains its batch without leaving timers', async() => {
  const h = logHarness()
  h.log.registerPlaybackLogSnapshot('scheduler', () => ({ initialized: true, reason: 'buffer_low', bufferSeconds: 4 }))
  h.log.setPlaybackLogEnabled(true)
  h.log.playbackLog('test.started')
  assert.equal(h.timers.size, 1)
  h.log.setPlaybackLogEnabled(false)
  h.log.playbackLog('test.disabled')
  await h.log.flushPlaybackLogs()
  assert.equal(h.timers.size, 0)
  const entries = await h.entries()
  assert.equal(entries[0].data.scheduler.reason, 'buffer_low')
  assert.deepEqual(entries.map(entry => entry.event), ['log.enabled', 'test.started', 'log.disabled'])
})

test('all exported fields, URLs and error messages are redacted, including bearer credentials', async() => {
  const h = logHarness()
  h.log.setPlaybackLogEnabled(true)
  h.log.playbackLog('credentials', {
    url: 'https://user:secret@audio.test/private/path?vkey=secret', Cookie: 'secret', headers: { Authorization: 'Bearer secret' },
    error: new Error('request https://audio.test/private?token=secret failed; Authorization: Bearer secret'),
    nested: { access_token: 'secret', text: 'vkey=secret' },
    jsonError: new Error('{"api_token":"secret","sign":"secret","p_skey":"secret"}'),
    clientSecret: 'secret',
  })
  const exported = await h.log.exportPlaybackLogs()
  assert.equal(exported.includes('secret'), false)
  assert.equal(exported.includes('/private/path'), false)
  assert.ok(exported.includes('audio.test'))
  assert.ok(exported.includes('redacted'))
})

test('repeated gate reasons are sampled while changed reasons are recorded immediately', async() => {
  const h = logHarness()
  h.log.setPlaybackLogEnabled(true)
  let computed = 0
  const payload = () => { computed++; return { reason: 'buffer_low' } }
  for (let i = 0; i < 100; i++) h.log.playbackLogState('wait', 'buffer_low', payload)
  assert.equal(computed, 1)
  await h.advance(10001)
  h.log.playbackLogState('wait', 'buffer_low', payload)
  h.log.playbackLogState('wait', 'paused', () => ({ reason: 'paused' }))
  assert.equal((await h.entries()).filter(entry => entry.event === 'wait').length, 3)
})

test('log callbacks and malformed payloads cannot throw into playback', async() => {
  const h = logHarness()
  h.log.setPlaybackLogEnabled(true)
  const remove = h.log.onPlaybackLogUpdate(() => { throw new Error('UI unavailable') })
  assert.doesNotThrow(() => h.log.playbackLog('factory', () => { throw new Error('bad field') }))
  assert.doesNotThrow(() => h.log.playbackLog('good', { okay: true }))
  remove()
  assert.ok((await h.entries()).some(entry => entry.event === 'good'))
})

test('rotation caps both files by UTF-8 bytes, including Chinese and emoji', async() => {
  const h = ioHarness()
  const writer = writerModule.createDebugLogWriter(h.files, h.clock, '/log', { fileLimit: 256, bufferLimit: 128 })
  for (let i = 0; i < 100; i++) {
    writer.append(`${i} 歌曲🎵 ${'音'.repeat(10)}`)
    await writer.flush()
  }
  assert.equal(h.values.size, 2)
  for (const value of h.values.values()) assert.ok(Buffer.byteLength(value) <= 256)
  assert.match(await writer.read(), /99 歌曲/)
})

test('slow storage keeps a bounded recent batch and serializes writes', async() => {
  const h = ioHarness(), blocked = deferred()
  const append = h.files.appendFile
  let writes = 0, maximum = 0
  h.files.appendFile = async(...args) => { maximum = Math.max(maximum, ++writes); await blocked.promise; await append(...args); writes-- }
  const writer = writerModule.createDebugLogWriter(h.files, h.clock, '/log', { fileLimit: 512, bufferLimit: 128 })
  writer.append('first')
  const first = writer.flush()
  await flush()
  for (let i = 0; i < 100; i++) writer.append(`pending-${i}`)
  assert.equal(h.timers.size, 0)
  blocked.resolve()
  await first
  const result = await writer.read()
  assert.equal(maximum, 1)
  assert.match(result, /log.dropped/)
  assert.match(result, /pending-99/)
  assert.equal(result.includes('pending-0\n'), false)
})

test('clear cannot resurrect a batch from before clearing, even when a write is in flight', async() => {
  const h = ioHarness(), blocked = deferred()
  const append = h.files.appendFile
  h.files.appendFile = async(...args) => { await blocked.promise; await append(...args) }
  const writer = writerModule.createDebugLogWriter(h.files, h.clock, '/log')
  writer.append('old-writing')
  const writing = writer.flush()
  await flush()
  writer.append('old-pending')
  const clearing = writer.clear()
  writer.append('after-clear')
  blocked.resolve()
  await Promise.all([writing, clearing])
  assert.equal(await writer.read(), 'after-clear\n')
})

test('a failed log write is visible in diagnostics and subsequent writes can recover', async() => {
  const h = logHarness()
  const append = h.files.appendFile
  h.files.appendFile = async() => { throw new Error('disk full') }
  h.log.setPlaybackLogEnabled(true)
  await assert.rejects(h.log.flushPlaybackLogs(), /disk full/)
  assert.equal(h.log.getPlaybackLogSnapshot().log.writeError, 'disk full')
  h.files.appendFile = append
  h.log.playbackLog('recovered')
  assert.ok((await h.entries()).some(entry => entry.event === 'recovered'))
})

test('oversized pre-existing diagnostic files are bounded before they are read', async() => {
  const h = ioHarness()
  h.values.set('/log', 'x'.repeat(10000)); h.values.set('/log.1', 'x'.repeat(10000))
  const writer = writerModule.createDebugLogWriter(h.files, h.clock, '/log', { fileLimit: 256 })
  assert.equal(await writer.read(), '')
})

for (const available of [true, false]) {
  test(`persistent startup flag enables JS diagnostics with native detail support ${available}`, async() => {
    const h = logHarness(), events = new EventEmitter(), nativeEvents = new EventEmitter(), changes = []
    let appState
    const setting = { 'player.debugLog': true, 'player.preloadNext': true, 'player.cacheSize': '1024' }
    const native = { preloadMusic() {} }
    if (available) native.setPreloadDebugLogging = enabled => { changes.push(enabled) }
    load('src/core/init/playbackLog.ts', {
      'react-native': { NativeModules: { TrackPlayerModule: native }, Platform: { OS: 'android', Version: 34 },
        AppState: { currentState: 'active', addEventListener: (event, callback) => { appState = callback } },
        DeviceEventEmitter: { addListener: (event, callback) => { nativeEvents.on(event, callback); return { remove: () => nativeEvents.off(event, callback) } } } },
      '../../../package.json': { version: 'fixture', versionCode: 1 }, '@/store/setting/state': { default: { setting } }, '@/utils/playbackLog': h.log,
    }, { global: { state_event: events } }).default(setting)
    nativeEvents.emit('playback-preload-debug', { audioId: 'audio-1', stage: 'read_started' })
    appState('background')
    await h.log.flushPlaybackLogs()
    assert.equal(h.log.isPlaybackLogEnabled(), true)
    assert.equal(h.log.getPlaybackLogSnapshot().environment.nativeDetails, available)
    assert.ok((await h.entries()).some(entry => entry.event === 'native.preload'))
    setting['player.debugLog'] = false
    events.emit('configUpdated', ['player.debugLog'])
    await h.log.flushPlaybackLogs()
    assert.equal(h.timers.size, 0)
    assert.equal(nativeEvents.listenerCount('playback-preload-debug'), 0)
    if (available) assert.deepEqual(changes, [true, false])
  })
}

const schedulerScenario = async enabled => {
  const h = logHarness(), app = new EventEmitter(), events = new EventEmitter()
  const current = { id: 'A' }, next = { id: 'B' }
  const state = { isPlay: true, playMusicInfo: { musicInfo: current } }
  const setting = { 'player.preloadNext': true, 'player.cacheSize': '1024' }
  const calls = { position: 0, buffered: 0, duration: 0, selection: 0, preload: 0 }
  let buffer = 6, exists = false
  h.log.setPlaybackLogEnabled(enabled)
  load('src/core/init/player/preloadNextMusic.ts', {
    'react-native-track-player': { default: {
      getPosition: async() => { calls.position++; return 2 }, getBufferedPosition: async() => { calls.buffered++; return buffer }, getDuration: async() => { calls.duration++; return 180 },
    } }, 'react-native-background-timer': { default: h.clock },
    '@/core/player/player': { getNextPlayMusicInfo: async() => { calls.selection++; return { musicInfo: next } }, resetRandomNextMusicInfo() {} },
    '@/core/player/preload': { cancelPreload() {}, keepPreloadFor() {}, pausePreload() {}, hasPreloadMusic: () => exists, isPreloadPaused: () => false,
      isPreloadCacheClearing: () => false, onPreloadCacheClearingChanged() {},
      preloadMusic: () => { calls.preload++; exists = true; return Promise.resolve('ready') } },
    '@/plugins/player/preload': { canPreloadAudio: () => true }, '@/store/player/state': { default: state }, '@/store/setting/state': { default: { setting } },
    '@/utils/message': { isRequestCancelled: () => false }, '@/utils/playbackLog': h.log,
  }, { Date: h.Date, global: { app_event: app, state_event: events, lx: { isPlayedStop: false } } }).default()
  await h.advance(3000)
  assert.equal(calls.preload, 0)
  assert.equal(h.log.getPlaybackLogSnapshot().scheduler.reason, 'buffer_low')
  const before = { ...calls }
  h.log.getPlaybackLogSnapshot()
  assert.deepEqual(calls, before)
  buffer = 60
  await h.advance(3000)
  assert.equal(calls.preload, 1)
  const entries = await h.entries()
  return { calls, entries }
}

test('diagnostics reveal the blocking gate and do not add native queries or source requests', async() => {
  const off = await schedulerScenario(false)
  const on = await schedulerScenario(true)
  assert.deepEqual(on.calls, off.calls)
  assert.ok(on.entries.some(entry => entry.event === 'preload.wait.buffer_low'))
  assert.ok(on.entries.some(entry => entry.event === 'preload.start'))
  assert.equal(off.entries.length, 0)
})

const viewerHarness = (read = async() => 'recent log') => {
  const host = hookHost(), frame = host.frame(), listeners = new Set(), frames = [], writes = [], copies = [], changes = []
  const setting = { 'player.debugLog': false }
  const fullText = 'LX Music diagnostic\n{"event":"full-log"}\n'
  const t = (key, values) => key === 'playback_log_status' ? values.status : key
  const log = {
    readPlaybackLogs: read, exportPlaybackLogs: async() => fullText, clearPlaybackLogs: async() => {},
    getPlaybackLogSnapshot: () => ({ log: { enabled: setting['player.debugLog'] }, scheduler: { reason: 'buffer_low', bufferSeconds: 4 }, environment: { nativeDetails: true } }),
    onPlaybackLogUpdate: fn => { listeners.add(fn); return () => listeners.delete(fn) },
  }
  const component = load('src/screens/Home/Views/Setting/settings/Other/PlaybackLog.tsx', {
    react: host.react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' }, 'react-native': { View: 'View' },
    '../../components/SubTitle': { default: 'SubTitle' }, '../../components/Button': { default: 'Button' }, '../../components/CheckBoxItem': { default: 'CheckBox' },
    '@/components/common/ConfirmAlert': { default: 'Alert' }, '@/components/common/ChoosePath': { default: 'ChoosePath' }, '@/components/common/Text': { default: 'Text' },
    '@/lang': { useI18n: () => t }, '@/store/setting/hook': { useSettingValue: key => setting[key] },
    '@/core/common': { updateSetting: values => { changes.push(values); Object.assign(setting, values) } },
    '@/utils/tools': { clipboardWriteText: value => copies.push(value), toast() {} }, '@/utils/fs': { writeFile: async(...args) => writes.push(args) },
    '@/utils/common': { debounce: fn => Object.assign(fn, { cancel() {} }) }, '@/utils/hooks/useScreenVisible': { useScreenVisible: host.visible }, '@/utils/playbackLog': log,
  }, { requestAnimationFrame: fn => { frames.push(fn); return frames.length }, cancelAnimationFrame() {} }).default
  frame.connect = tree => {
    for (const item of elements(tree, 'Alert')) item.props.ref.current = { setVisible() {} }
    for (const item of elements(tree, 'ChoosePath')) item.props.ref.current = { show() {} }
  }
  const render = () => host.render(frame, () => component())
  const press = (tree, label) => elements(tree, 'Button').find(item => item.props.children === label).props.onPress()
  return { render, press, frame, frames, listeners, writes, copies, changes, fullText, unmount: () => host.unmount(frame) }
}

test('the hidden viewer releases its subscription and cannot display a late disk read', async() => {
  const gate = deferred(), h = viewerHarness(() => gate.promise)
  h.press(h.render(), 'setting_other_log_btn_show')
  h.render()
  assert.equal(h.listeners.size, 1)
  h.frame.visible = false
  h.render()
  assert.equal(h.listeners.size, 0)
  gate.resolve('late-private-log')
  await flush()
  assert.equal(elements(h.render(), 'Text').some(item => String(item.props.children).includes('late-private-log')), false)
  h.unmount()
})

test('the switch uses saved settings and copy/export include full plain text instead of the preview', async() => {
  const h = viewerHarness()
  elements(h.render(), 'CheckBox')[0].props.onChange(true)
  assert.equal(h.changes[0]['player.debugLog'], true)
  h.press(h.render(), 'playback_log_copy')
  await flush()
  assert.deepEqual(h.copies, [h.fullText])
  h.press(h.render(), 'playback_log_export')
  const tree = h.render()
  h.frames.forEach(fn => fn())
  elements(tree, 'ChoosePath')[0].props.onConfirm('/exports')
  await flush()
  assert.match(h.writes[0][0], /^\/exports\/lx-playback-.*\.txt$/)
  assert.equal(h.writes[0][1], h.fullText)
  h.unmount()
})

for (const writable of [true, false]) {
  test(`source resolution, native prefetch and foreground takeover share one trace when cache is writable=${writable}`, async() => {
    const h = logHarness(), reads = []
    h.log.setPlaybackLogEnabled(true)
    const setting = { 'player.preloadNext': true, 'player.cacheSize': '1024', 'player.playQuality': '128k',
      'player.urlSource': 'source', 'common.apiSource': 'user_api_A', 'common.apiSourceOrder': '["user_api_A"]' }
    const music = { id: 'next', source: 'kw', meta: { _qualitys: { '128k': {} } } }
    const message = load('src/utils/message.ts')
    const order = load('src/utils/apiSourceOrder.ts')
    const cache = load('src/utils/musicUrlCache.ts', { './apiSourceOrder': order })
    const globalState = { lx: { qualityList: { kw: ['128k'] } }, i18n: { t: key => key } }
    const data = { getMusicUrl: async() => '', saveMusicUrl: async() => {} }
    const qq = { validateQQMusicUrl: async() => {} }
    const priority = load('src/core/music/sourcePriority.ts', {
      '@/store/setting/state': { default: { setting } }, '@/store/userApi': { state: { list: [{ id: 'user_api_A' }] } }, '@/utils/apiSourceOrder': order,
      '@/utils/message': message, '@/core/qqMusicUrl': qq, '@/utils/playbackLog': h.log,
      '@/core/userApiRuntime': { requestUserApiMusicUrl: async() => ({ url: 'https://audio.test/track?token=secret', type: '128k' }) },
    }, { global: globalState })
    const pipeline = load('src/core/music/utils.ts', {
      '@/utils/musicSdk': {}, '@/utils/data': data, '@/utils': {}, '@/store/setting/state': { default: { setting } }, '@/utils/message': message,
      'react-native-background-timer': { default: h.clock }, '@/utils/musicSdk/api-source': {}, '@/core/qqMusicUrl': qq,
      '@/config/constant': {}, './sourcePriority': priority, '@/utils/musicUrlCache': cache, '@/utils/playbackLog': h.log,
    }, { global: globalState })
    const online = load('src/core/music/online.ts', {
      '@/utils/data': data, '@/core/list': {}, '@/store/setting/state': { default: { setting } }, './sourcePriority': priority,
      '@/utils/message': message, '@/core/qqMusicUrl': qq, '@/utils/musicUrlCache': cache, './utils': pipeline, '@/utils/playbackLog': h.log,
    })
    const native = load('src/plugins/player/preload.ts', {
      'react-native': { NativeModules: { TrackPlayerModule: { preloadMusic: async(id, url, agent, maxBytes) => {
        reads.push({ id, maxBytes })
        return writable ? { cachedBytes: maxBytes || 999999, complete: maxBytes === 0 } : null
      }, cancelPreloadMusic() {} } } },
      '@/utils/message': message, './playList': { defaultUserAgent: 'fixture' }, 'react-native-background-timer': { default: h.clock }, '@/utils/playbackLog': h.log,
    })
    const preload = load('src/core/player/preload.ts', {
      '@/core/music': { getMusicUrl: online.getMusicUrl }, '@/core/music/sourcePriority': priority,
      '@/store/setting/state': { default: { setting } }, '@/plugins/player/preload': native,
      '@/utils/message': message, '@/utils/apiSourceOrder': order, '@/utils/playbackLog': h.log,
    })
    await preload.preloadMusic(music, undefined, 'play-current')
    await flush()
    assert.equal(h.log.getPlaybackLogSnapshot().preloadTask.phase, writable ? 'ready' : 'cache_unavailable')
    assert.equal(reads.length, writable ? 2 : 1)
    assert.equal(await preload.takePreloadedMusicUrl(music, () => {}, 'play-next'), 'https://audio.test/track?token=secret')
    const entries = await h.entries()
    const created = entries.find(entry => entry.event === 'preload.created').data
    for (const event of ['url.source_start', 'audio.request', 'preload.handoff_hit']) {
      const item = entries.find(entry => entry.event === event)
      assert.equal(item.data.preloadId, created.preloadId)
      assert.equal(item.data.playId, 'play-current')
    }
    assert.equal(entries.find(entry => entry.event === 'audio.request').data.audioId, reads[0].id)
    assert.equal(JSON.stringify(entries).includes('secret'), false)
  })
}
