const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load, flush } = require('./helpers/load.cjs')

const harness = () => {
  let nextTimer = 0
  const timers = new Map(), calls = []
  class FormData {
    constructor() { this.parts = [] }
    append(key, value) { this.parts.push([key, value]) }
  }
  class FileReader {
    readAsDataURL(blob) { this.result = 'data:application/octet-stream;base64,' + Buffer.from(blob).toString('base64'); this.onload() }
  }
  const response = { headers: { map: { 'content-type': 'application/json' } }, text: async() => '{"ok":true}', blob: async() => 'audio', status: 200, statusText: 'OK', url: 'https://api.test/result', ok: true }
  const app = { AbortController, FormData, FileReader, fetch: async(url, options) => { calls.push({ url, options }); return response } }
  const shared = load('src/utils/httpRequest.js', {
    'react-native-background-timer': { default: {
      setTimeout: (fn, delay) => { timers.set(++nextTimer, { fn, delay }); return nextTimer },
      clearTimeout: id => timers.delete(id),
    } },
  }, { global: app })
  const user = load('src/core/init/userApi/request.js', { '@/utils/httpRequest': shared })
  const sdk = load('src/utils/request.js', {
    './httpRequest': shared, './musicSdk/options': { bHh: '624868746c' },
    './message': { requestMsg: { notConnectNetwork: 'network unavailable', timeout: 'request timeout', unachievable: 'unreachable' } },
    pako: require('pako'),
  }, { process: { versions: { app: '1.9.2-beta' } } })
  return { shared, user, sdk, app, calls, timers, response, FormData }
}

test('shared transport preserves the SDK and custom-script defaults', async() => {
  const h = harness()
  const script = h.user.fetchData('https://api.test/script', {})
  const sdk = h.sdk.httpFetch('https://api.test/sdk')
  assert.deepEqual([...h.timers.values()].map(timer => timer.delay), [13000, 15000])
  assert.equal((await script.request).body.ok, true)
  await sdk.promise
  assert.equal(h.calls[0].options.credentials, 'omit')
  assert.equal(h.calls[0].options.cache, 'default')
  assert.equal(h.calls[1].options.credentials, undefined)
  assert.equal(h.calls[1].options.cache, 'no-store')
  assert.equal(h.timers.size, 0)
})

test('explicit request settings override transport defaults', async() => {
  const h = harness()
  const request = h.user.fetchData('https://api.test/custom', { timeout: 750, cache: 'no-cache', credentials: 'include' })
  assert.equal([...h.timers.values()][0].delay, 750)
  await request.request
  assert.equal(h.calls[0].options.credentials, 'include')
  assert.equal(h.calls[0].options.cache, 'no-cache')
})

test('JSON and URL-encoded requests keep their payload and caller headers', async() => {
  const h = harness()
  const headers = { 'content-type': 'application/json', Cookie: 'fixture' }
  await h.sdk.httpFetch('https://api.test/json', { method: 'post', headers, body: { value: 7 } }).promise
  assert.equal(h.calls[0].options.body, '{"value":7}')
  assert.equal(h.calls[0].options.headers.Cookie, 'fixture')
  assert.equal(h.calls[0].options.headers['Content-Type'], undefined)
  assert.deepEqual(headers, { 'content-type': 'application/json', Cookie: 'fixture' })
  await h.user.fetchData('https://api.test/form', { method: 'POST', form: { query: 'a b&c' } }).request
  assert.equal(h.calls[1].options.body, 'query=a%20b%26c')
  assert.equal(h.calls[1].options.headers['Content-Type'], 'application/x-www-form-urlencoded')
})

test('multipart records and native FormData reach fetch without a fabricated boundary', async() => {
  const h = harness()
  await h.user.fetchData('https://api.test/upload', { method: 'post', formData: { title: 'Music', file: { uri: 'content://fixture/audio', name: 'audio.mp3' } } }).request
  const options = h.calls[0].options
  assert.ok(options.body instanceof h.FormData)
  assert.equal(options.body.parts[0][1], 'Music')
  assert.equal(options.body.parts[1][1].uri, 'content://fixture/audio')
  assert.equal(options.headers['Content-Type'], undefined)
  const body = new h.FormData()
  body.append('field', 'value')
  await h.sdk.httpFetch('https://api.test/upload', { method: 'post', formData: body }).promise
  assert.equal(h.calls[1].options.body, body)
})

test('binary bodies and non-JSON text preserve the existing response contract', async() => {
  const h = harness()
  const binary = await h.user.fetchData('https://api.test/audio', { binary: true }).request
  assert.ok(Buffer.isBuffer(binary.body))
  assert.equal(binary.body.toString(), 'audio')
  assert.equal(binary.statusCode, 200)
  assert.equal(binary.headers['content-type'], 'application/json')
  h.response.text = async() => 'plain response'
  assert.equal((await h.sdk.httpFetch('https://api.test/text').promise).body, 'plain response')
})

test('cancelling before preparation completes does not start an HTTP request', async() => {
  const h = harness()
  const pending = h.user.fetchData('https://api.test/cancel')
  pending.abort()
  await assert.rejects(pending.request, /Aborted/)
  assert.equal(h.calls.length, 0)
  assert.equal(h.timers.size, 0)
})

test('timeouts abort an in-flight request and release the timer', async() => {
  const h = harness()
  h.app.fetch = async(url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('Aborted')))
  })
  const pending = h.user.fetchData('https://api.test/timeout')
  const rejected = assert.rejects(pending.request, /Aborted/)
  await flush()
  for (const timer of h.timers.values()) timer.fn()
  await rejected
  assert.equal(h.timers.size, 0)
})

test('option preparation errors release the timer without starting HTTP', async() => {
  const h = harness()
  const request = h.shared.createFetchData({ prepare: async() => { throw new Error('invalid options') } })
  await assert.rejects(request('https://api.test/invalid').request, /invalid options/)
  assert.equal(h.timers.size, 0)
  assert.equal(h.calls.length, 0)
})

test('SDK network errors still use the established messages', async() => {
  const h = harness()
  h.app.fetch = async() => { throw new Error('Network request failed') }
  await assert.rejects(h.sdk.httpFetch('https://api.test/offline').promise, /network unavailable/)
})

test('SDK source signing matches the pre-refactor golden request', async() => {
  const h = harness()
  const headers = { '624868746c': true }
  await h.sdk.httpFetch('https://api.test/songs?id=12', { headers }).promise
  assert.equal(h.calls[0].options.headers.lxm, '0b2fcf4ff7cc72adf47571ac00625320ce74ce3128f7757105e26c20f6b40500&1009002beta')
  assert.equal(h.calls[0].options.headers['624868746c'], undefined)
  assert.equal(headers['624868746c'], true)
})

test('callback GET and URL validation keep their public behavior', async() => {
  const h = harness()
  await new Promise((resolve, reject) => h.sdk.httpGet('https://api.test/callback', (error, response, body) => {
    if (error) { reject(error); return }
    assert.equal(response.statusCode, 200)
    assert.equal(body.ok, true)
    resolve()
  }))
  await h.sdk.checkUrl('https://api.test/head')
  assert.equal(h.calls.at(-1).options.method, 'head')
  h.response.status = 403
  await assert.rejects(h.sdk.checkUrl('https://api.test/denied'), /403/)
})
