const { test } = require('node:test')
const assert = require('node:assert/strict')
const { load, deferred, flush } = require('./helpers/load.cjs')

const harness = () => {
  let version = 1; let complete = true; let parses = 0; let net = 0; const hints = []
  const remote = (durationMs, extra) => ({ readable: true, durationMs, mime: 'audio/mpeg', ...extra })
  const read = async(_id, url, hint) => {
    hints.push(hint)
    const proof = `${url}/${version}`
    if (hint === proof) return { unchangedProof: proof }
    parses++
    return complete ? remote(version * 1000, { diskProof: proof, resolvedUrl: `${url}/cdn-${version}` }) : { readable: false, reason: 'cache_miss', diskProof: proof }
  }
  const native = {
    startCachedAudioProbe: (id, url) => read(id, url, ''),
    startCachedAudioProbeWithHint: read,
    startRemoteAudioProbe: async() => { net++; return remote(100000) },
    cancelRemoteAudioProbe() {},
  }
  const api = load('src/utils/nativeModules/remoteAudio.ts', {
    'react-native': { NativeModules: { UtilsModule: native } }, 'react-native-background-timer': { default: { setTimeout, clearTimeout } },
  })
  return {
    api,
    native,
    hints,
    parses: () => parses,
    net: () => net,
    mutate(full) { version++; complete = full },
    probe: (url = 'https://fixture/file', options = {}) => api.probeRemoteAudio(url, true, { preferCompleteCache: true, ...options }),
  }
}

test('stable complete and partial disk entries reuse only a native-confirmed receipt', async() => {
  const h = harness()
  for (let i = 0; i < 100; i++) assert.equal((await h.probe()).durationMs, 1000)
  assert.equal(h.parses(), 1); assert.equal(h.net(), 0)
  h.mutate(false)
  for (let i = 0; i < 100; i++) assert.equal((await h.probe()).durationMs, 100000)
  assert.equal(h.parses(), 2); assert.equal(h.net(), 1)
  h.mutate(true); assert.equal((await h.probe()).durationMs, 3000); assert.equal(h.parses(), 3)
  // A download/forced refresh may never use the disk certificate or send it to the network.
  assert.equal((await h.probe(undefined, { isRefresh: true })).durationMs, 100000); assert.equal(h.net(), 2)
})

test('discarded redirects, older APKs and an unrecognized token cannot manufacture a disk hit', async() => {
  const h = harness(); const url = 'https://fixture/file'
  const info = await h.probe(url); h.api.discardRedirectedAudioProbe(url, info); await h.probe(url)
  assert.equal(h.parses(), 2)
  h.native.startCachedAudioProbeWithHint = async() => ({ unchangedProof: 'not-issued' })
  assert.equal((await h.probe(url)).durationMs, 100000)
  delete h.native.startCachedAudioProbeWithHint
  h.mutate(true); assert.equal((await h.probe(url)).durationMs, 2000)
})

test('disk receipts are bounded and a cancelled validation cannot publish late bytes', async() => {
  const h = harness(); for (let i = 0; i < 40; i++) await h.probe(`https://fixture/${i}`)
  await h.probe('https://fixture/0'); assert.equal(h.hints.at(-1), '')
  const read = h.native.startCachedAudioProbeWithHint; const gate = deferred(); const c = new AbortController()
  h.native.startCachedAudioProbeWithHint = async() => gate.promise
  const p = h.probe('https://fixture/cancel', { signal: c.signal }); await flush(); c.abort(); await assert.rejects(p)
  gate.resolve({ readable: true, durationMs: 1000, mime: 'audio/mpeg', diskProof: 'late' }); await flush()
  h.native.startCachedAudioProbeWithHint = read; await h.probe('https://fixture/cancel'); assert.equal(h.hints.at(-1), '')
})
