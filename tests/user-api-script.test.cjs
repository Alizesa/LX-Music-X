const assert = require('node:assert/strict')
const { test } = require('node:test')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const { scriptHarness } = require('./helpers/user-api-script.cjs')

for (const error of [null, 'Network failed']) {
  test(`the real script releases a ${error ? 'failed' : 'successful'} HTTP callback after one response`, () => {
    const h = scriptHarness()
    const callbacks = []
    const cancel = h.context.lx.request('https://audio.test/lookup', {}, (...args) => { callbacks.push(args) })
    const requestKey = h.calls.at(-1).data.requestKey
    assert.equal(h.queue.size, 1)
    h.respond(requestKey, error)
    assert.equal(h.queue.size, 0)
    assert.equal(callbacks.length, 1)
    if (error) {
      assert.equal(callbacks[0][0].message, error)
      assert.equal(callbacks[0][1], null)
      assert.equal(callbacks[0][2], null)
    } else {
      assert.equal(callbacks[0][0], null)
      assert.equal(callbacks[0][1].statusCode, 200)
      assert.equal(callbacks[0][2], 'audio')
    }
    h.respond(requestKey, error)
    assert.equal(callbacks.length, 1)
    assert.doesNotThrow(() => { cancel(); cancel() })
    assert.equal(h.calls.some(call => call.action === 'cancelRequest'), false)
  })
}

test('script HTTP cancellation immediately releases callbacks, is idempotent and ignores late responses', () => {
  const h = scriptHarness()
  let callbacks = 0
  for (let index = 0; index < 100; index++) {
    const cancel = h.context.lx.request('https://audio.test/lookup', {}, () => { callbacks++ })
    const requestKey = h.calls.at(-1).data.requestKey
    assert.equal(h.queue.size, 1)
    cancel()
    assert.equal(h.queue.size, 0)
    assert.doesNotThrow(cancel)
    h.respond(requestKey)
    h.respond(requestKey, 'Aborted')
  }
  assert.equal(callbacks, 0)
  assert.equal(h.calls.filter(call => call.action === 'cancelRequest').length, 100)
})

test('retaining cancellation handles does not retain completed or cancelled callback payloads', () => {
  const result = spawnSync(process.execPath, ['--expose-gc', '-e', `
    const assert = require('node:assert/strict')
    const { scriptHarness } = require('./tests/helpers/user-api-script.cjs')
    const h = scriptHarness(), handles = [], references = []
    for (const complete of [false, true]) {
      const payload = { songs: new Array(10000).fill('song') }
      references.push(new WeakRef(payload))
      const cancel = h.context.lx.request('https://audio.test/lookup', {}, () => payload.songs.length)
      handles.push(cancel)
      if (complete) h.respond(h.calls.at(-1).data.requestKey)
      else cancel()
    }
    setImmediate(() => {
      global.gc()
      assert.equal(handles.length, 2)
      assert.equal(h.queue.size, 0)
      assert.ok(references.every(reference => reference.deref() === undefined), 'callback payload is still retained')
    })
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 15000 })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
