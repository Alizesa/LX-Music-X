const assert = require('node:assert/strict')
const { test } = require('node:test')
const vm = require('node:vm')
const { scriptHarness } = require('./helpers/user-api-script.cjs')
const { scopeHarness } = require('./helpers/user-api-scope.cjs')
const { flush } = require('./helpers/load.cjs')

const standard = 'https://isure6.stream.qqmusic.qq.com/C4000027W1wz3eeYtZ.m4a?vkey=fixture'
const high = 'https://isure6.stream.qqmusic.qq.com/M8000027W1wz3eeYtZ.mp3?vkey=fixture'
const encrypted = 'https://wx.music.tc.qq.com/O8M00027W1wz3eeYtZ.mgg?vkey=fixture'
const flac = 'https://isure6.stream.qqmusic.qq.com/F0000027W1wz3eeYtZ.flac?vkey=fixture'
const hires = 'https://isure6.stream.qqmusic.qq.com/RS010027W1wz3eeYtZ.flac?vkey=fixture'

const script = `
  const get = id => new Promise((resolve, reject) => lx.request('https://fixture/' + id, {}, (error, response, body) => {
    if (error) reject(error)
    else resolve(typeof body === 'string' ? body : body.data.url)
  }))
  lx.on('request', () => Promise.any([get('fast'), get('slow')]))
  lx.send(lx.EVENT_NAMES.inited, { sources: { tx: { type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac', 'flac24bit'] } } })
`
const direct = ({ quality = '320k', filter = true, source = 'tx' } = {}) => {
  const h = scriptHarness()
  vm.runInContext(`
    lx.on('request', () => new Promise((resolve, reject) => lx.request('https://fixture/lookup', {}, (error, response, body) => {
      globalThis.observed = { error: error?.message ?? null, body }
      if (error) reject(error)
      else resolve('https://fixture/final')
    })))
  `, h.context)
  h.context.__lx_native__('key', 'request', JSON.stringify({ requestKey: 'song', filterAudioCandidates: filter, data: { source, action: 'musicUrl', info: { type: quality } } }))
  return { ...h, reply: body => h.respond(h.calls.find(call => call.action === 'request').data.requestKey, null, body) }
}

for (const apiId of ['user_api_A', 'user_api_B']) {
  test(`the ${apiId === 'user_api_A' ? 'primary' : 'isolated'} aggregate can skip fast lower, higher and encrypted URLs and finish with real 320k`, async() => {
    for (const invalid of [standard, encrypted, flac]) {
      const h = await scopeHarness(script)
      const music = { id: 'tx_0027W1wz3eeYtZ', source: 'tx', interval: '01:37', meta: { songId: '0027W1wz3eeYtZ', _qualitys: { '320k': {} } } }
      const result = h.runtime.requestUserApiMusicUrl(apiId, music, '320k', undefined, false)
      await h.pump()
      assert.equal(h.http.length, 2)
      const dispatch = h.sends.find(send => send.action === 'request')
      assert.equal(dispatch.data.filterAudioCandidates, true)
      await h.respond(0, { data: { url: invalid } })
      assert.equal(h.events.some(event => event.action === 'response' && event.data.requestKey === dispatch.data.requestKey), false)
      await h.respond(1, { data: { url: high } })
      assert.equal((await result).url, high)
      assert.equal(h.http.length, 2, 'filtering must not add media probes or duplicate source requests')
    }
  })
}

test('QQ quality filtering applies only to exact music requests and leaves playback and other platforms unchanged', async() => {
  for (const options of [{ filter: false }, { source: 'kw' }, { quality: '128k' }]) {
    const h = direct(options)
    h.reply({ data: { url: standard } })
    await flush()
    assert.equal(h.context.observed.error, null)
    assert.equal(h.context.observed.body.data.url, standard)
  }
})

test('nested JSON bodies, plain URLs and encoded filenames report a known incompatible candidate to the script', async() => {
  for (const body of [
    { data: { url: standard } },
    JSON.stringify({ result: { music_url: standard } }),
    encrypted,
    { data: { url: encrypted.replace('.mgg?', '%2Emgg?') } },
  ]) {
    const h = direct()
    h.reply(body)
    await flush()
    assert.match(h.context.observed.error, /Audio candidate rejected \((?:quality_mismatch|encrypted_audio)\)/)
    const answer = h.calls.find(call => call.action === 'response')
    assert.equal(answer.data.status, false)
  }
})

test('exact requests reject all known wrong tiers and retain the requested tier', async() => {
  for (const [quality, url, rejected] of [['flac', high, true], ['flac24bit', flac, true], ['flac', flac, false], ['flac24bit', hires, false], ['320k', flac, true], ['128k', high, true], ['flac', hires, true]]) {
    const h = direct({ quality })
    h.reply(url)
    await flush()
    assert.equal(!!h.context.observed.error, rejected)
  }
})

test('unknown proxies, lookalike hosts, misleading suffixes and mixed candidates remain eligible for real media validation', async() => {
  for (const body of [
    'https://audio.example/proxy?id=fixture',
    standard.replace('qqmusic.qq.com', 'qqmusic.qq.com.example.com'),
    high.replace('.mp3', '.m4a'),
    { data: { urls: [standard, high] } },
    { data: { urls: [encrypted, 'https://audio.example/unknown'] } },
    { data: { url: high, description: standard } },
    { data: { url: standard, anotherAudioLink: 'https://audio.example/unknown' } },
  ]) {
    const h = direct()
    h.reply(body)
    await flush()
    assert.equal(h.context.observed.error, null)
  }
})

test('cover and lyric URLs outside a song HTTP scope are not filtered', () => {
  const h = scriptHarness()
  let error
  h.context.lx.request('https://fixture/init', {}, failure => { error = failure })
  h.respond(h.calls.at(-1).data.requestKey, null, { data: { url: encrypted } })
  assert.equal(error, null)
})

test('a cached or decoded low-quality or encrypted URL fails without starting another HTTP or audio probe', async() => {
  for (const url of [standard, encrypted]) {
    const h = scriptHarness()
    vm.runInContext(`lx.on('request', () => ${JSON.stringify(url)})`, h.context)
    h.context.__lx_native__('key', 'request', JSON.stringify({ requestKey: 'cached', filterAudioCandidates: true, data: { source: 'tx', action: 'musicUrl', info: { type: '320k' } } }))
    await flush()
    const response = h.calls.find(call => call.action === 'response')
    assert.equal(response.data.status, false)
    assert.match(response.data.errorMessage, /Audio candidate rejected/)
    assert.equal(h.calls.some(call => call.action === 'request'), false)
  }
})

test('mixed responses preserve relative QQ candidates for the script to resolve', async() => {
  for (const path of ['/M800sample.mp3', 'M800sample.mp3?token=x', '../audio/M800sample.mp3', '?vkey=other']) {
    for (const field of ['wifiurl', 'purl', 'play_url']) {
      const h = direct()
      h.reply({ data: { url: standard, [field]: path } }); await flush()
      assert.equal(h.context.observed.error, null)
      assert.equal(h.context.observed.body.data[field], path)
    }
  }
  const h = direct()
  h.reply({ data: { url: standard, wifiurl: '' } }); await flush()
  assert.match(h.context.observed.error, /quality_mismatch/)
})
