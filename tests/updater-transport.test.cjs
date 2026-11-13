const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load } = require('./helpers/load.cjs')
const { manifest, repository, packageName } = require('./helpers/release.cjs')
const shared = require('../shared/release')

// Keep the real fetch adapter, callback request, JSON parsing and updater.
// Only the native fetch boundary is replaced with HTTP responses.
const transport = (respond) => {
  const calls = []
  const timers = new Set()
  const http = load('src/utils/httpRequest.js', {
    'react-native-background-timer': {
      default: {
        setTimeout: (callback, delay) => { const id = setTimeout(callback, delay); timers.add(id); return id },
        clearTimeout: id => { clearTimeout(id); timers.delete(id) },
      },
    },
  }, {
    global: {
      AbortController,
      fetch: async(url, options) => {
        const parsed = new URL(url)
        calls.push({ url: parsed, options })
        const { status = 200, body, contentType = 'text/plain; charset=utf-8' } = await respond(parsed, options)
        return {
          status,
          ok: status === 200,
          url,
          statusText: '',
          headers: { map: { 'content-type': contentType } },
          text: async() => typeof body === 'string' ? body : JSON.stringify(body),
        }
      },
    },
  })
  const request = load('src/utils/request.js', {
    './httpRequest': http,
    './message': { requestMsg: {} },
    './musicSdk/options': { bHh: '624868746c' },
    pako: { deflateRaw: () => assert.fail('Update requests do not use music source signing') },
  })
  const updater = load('src/utils/version.js', {
    '@/utils/request': request,
    '../../package.json': { name: packageName },
    '../../shared/release': shared,
    '@/utils/fs': {},
    '@/utils/nativeModules/utils': {},
    '@/config/constant': {},
  })
  return { updater, calls, timers }
}

const preview = manifest('1.9.3-next.1', 100001)
const missing = { status: 404, body: '404: Not Found' }

test('a first preview release checks successfully before any stable channel has been published', async() => {
  const app = transport(url => {
    assert.equal(url.hostname, 'raw.githubusercontent.com')
    return url.pathname.endsWith('/stable.json') ? missing : { body: preview }
  })
  const result = await app.updater.getVersionInfo('next', true)
  assert.equal(result.incomplete, false)
  assert.equal(result.errors.length, 0)
  assert.equal(result.manifests.length, 1)
  assert.equal(result.manifests[0].tag, preview.tag)
  assert.equal(shared.selectUpdate(result.manifests, 'next', preview.version, preview.versionCode), null)
  assert.equal(shared.selectUpdate(result.manifests, 'next', '1.9.2', 79003).tag, preview.tag)
  assert.equal(app.calls.length, 2)
  assert.equal(app.timers.size, 0)
})

test('with raw unreachable, a CDN preview and an official API 404 complete the first-release check', async() => {
  const app = transport((url, options) => {
    if (url.hostname === 'raw.githubusercontent.com') throw new Error('Network request failed')
    if (url.hostname === 'cdn.jsdelivr.net') return url.pathname.endsWith('/stable.json') ? missing : { body: preview, contentType: 'application/json' }
    assert.equal(url.hostname, 'api.github.com')
    assert.equal(url.pathname, `/repos/${repository}/contents/channels/stable.json`)
    assert.equal(url.searchParams.get('ref'), 'release-meta')
    assert.equal(options.headers.Accept, 'application/vnd.github.raw+json')
    return missing
  })
  const result = await app.updater.getVersionInfo('next', true)
  assert.equal(result.incomplete, false)
  assert.equal(result.errors.length, 0)
  assert.equal(result.manifests[0].tag, preview.tag)
  assert.equal(shared.selectUpdate(result.manifests, 'next', preview.version, preview.versionCode), null)
  assert.equal(app.calls.length, 5)
  assert.equal(app.calls.filter(call => call.url.hostname === 'api.github.com').length, 1)
  assert.equal(app.timers.size, 0)
})

test('the default stable check completes without an update before the first stable release, even if raw is unreachable', async() => {
  const app = transport(url => {
    assert.ok(url.pathname.endsWith('/stable.json'))
    if (url.hostname === 'raw.githubusercontent.com') throw new Error('Network request failed')
    return missing
  })
  const result = await app.updater.getVersionInfo()
  assert.equal(result.incomplete, false)
  assert.equal(result.errors.length, 0)
  assert.equal(result.manifests.length, 0)
  assert.equal(app.calls.length, 3)
  assert.equal(app.calls[2].url.hostname, 'api.github.com')
  assert.equal(app.timers.size, 0)
})

test('the official API can also supply the validated preview when raw and the CDN both fail', async() => {
  const app = transport((url, options) => {
    if (url.hostname === 'raw.githubusercontent.com') throw new Error('Network request failed')
    if (url.hostname === 'cdn.jsdelivr.net') return { status: 503, body: 'Service unavailable' }
    assert.equal(url.hostname, 'api.github.com')
    assert.ok(url.pathname.startsWith(`/repos/${repository}/contents/channels/`))
    assert.equal(url.searchParams.get('ref'), 'release-meta')
    assert.equal(options.headers.Accept, 'application/vnd.github.raw+json')
    return url.pathname.endsWith('/stable.json') ? missing : { body: preview, contentType: 'application/vnd.github.raw+json' }
  })
  const result = await app.updater.getVersionInfo('next', true)
  assert.equal(result.incomplete, false)
  assert.equal(result.errors.length, 0)
  assert.equal(result.manifests[0].tag, preview.tag)
  assert.equal(app.calls.length, 6)
  assert.equal(app.timers.size, 0)
})

test('API rate limits preserve the timeout, mirror failure and HTTP status instead of declaring latest', async() => {
  const app = transport(url => {
    if (url.hostname === 'raw.githubusercontent.com') {
      const error = new Error('Aborted')
      error.name = 'AbortError'
      throw error
    }
    if (url.hostname === 'cdn.jsdelivr.net') return missing
    return { status: 403, body: { message: 'API rate limit exceeded' } }
  })
  const result = await app.updater.getVersionInfo('next', true)
  assert.equal(result.incomplete, true)
  assert.equal(result.manifests.length, 0)
  assert.equal(result.errors.length, 2)
  for (const [index, channel] of ['stable', 'next'].entries()) {
    assert.ok(result.errors[index].includes(`${channel} / raw.githubusercontent.com: Update request timed out`))
    assert.ok(result.errors[index].includes(`${channel} / cdn.jsdelivr.net: Update mirror is missing channel metadata`))
    assert.ok(result.errors[index].includes(`${channel} / api.github.com: Update request failed: 403`))
  }
  assert.equal(app.calls.length, 6)
  assert.equal(app.timers.size, 0)
})

test('an API response with invalid channel metadata cannot turn a failed check into an empty channel', async() => {
  const app = transport(url => {
    if (url.hostname !== 'api.github.com') throw new Error('Network request failed')
    return { body: '<html>Unexpected response</html>', contentType: 'text/html' }
  })
  const result = await app.updater.getVersionInfo('stable', true)
  assert.equal(result.incomplete, true)
  assert.equal(result.manifests.length, 0)
  assert.match(result.errors[0], /stable \/ api\.github\.com: Invalid update channel/)
  assert.equal(app.calls.length, 3)
  assert.equal(app.timers.size, 0)
})
