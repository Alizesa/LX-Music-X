const assert = require('node:assert/strict')
const { test } = require('node:test')
const { EventEmitter } = require('node:events')
const { load, deferred, flush } = require('./helpers/load.cjs')

test('changing 20 covers keeps only the newest prefetch and cancels it on background or disable', async() => {
  const events = new EventEmitter(); const changes = new EventEmitter()
  const app = { currentState: 'active', addEventListener: (event, fn) => changes.on(event, fn) }
  const state = { musicInfo: { pic: 'https://cover/0' }, loadErrorPicUrl: '' }
  const requests = []; const cancelled = []; const applied = []
  await load('src/core/init/common.ts', {
    'react-native': { AppState: app },
    '@/store/player/state': { default: state },
    '@/components/common/ImageBackground': {
      prefetch: async(url, onRequestId) => {
        const request = { url, gate: deferred(), id: requests.length }
        requests.push(request)
        onRequestId(request.id)
        return request.gate.promise
      },
      abortPrefetch: id => cancelled.push(id),
    },
    '@/core/common': { setBgPic: url => applied.push(url) },
  }, { global: { state_event: events } }).default({ 'theme.dynamicBg': true })
  for (let i = 1; i < 20; i++) {
    state.musicInfo.pic = `https://cover/${i}`
    events.emit('playerMusicInfoChanged')
  }
  assert.equal(requests.length, 20)
  assert.deepEqual(cancelled, Array.from({ length: 19 }, (_, i) => i))
  requests[0].gate.resolve(true)
  await flush()
  assert.equal(applied.length, 0)
  app.currentState = 'background'
  changes.emit('change', 'background')
  assert.equal(cancelled.at(-1), 19)
  app.currentState = 'active'
  changes.emit('change', 'active')
  events.emit('configUpdated', ['theme.dynamicBg'], { 'theme.dynamicBg': false })
  assert.equal(cancelled.at(-1), 20)
  requests.forEach(request => request.gate.resolve(true))
  await flush()
  assert.deepEqual(applied, [null])
})

test('a request ID reported after cancellation is immediately aborted', async() => {
  const events = new EventEmitter(); const cancelled = []; const requestIds = []
  const state = { musicInfo: { pic: 'a' }, loadErrorPicUrl: '' }
  await load('src/core/init/common.ts', {
    'react-native': { AppState: { currentState: 'active', addEventListener() {} } },
    '@/store/player/state': { default: state },
    '@/components/common/ImageBackground': {
      prefetch: async(url, callback) => { requestIds.push(callback); return new Promise(() => {}) },
      abortPrefetch: id => cancelled.push(id),
    },
    '@/core/common': {},
  }, { global: { state_event: events } }).default({ 'theme.dynamicBg': true })
  state.musicInfo.pic = 'b'
  events.emit('playerMusicInfoChanged')
  requestIds[0](12)
  requestIds[1](13)
  assert.deepEqual(cancelled, [12])
})
