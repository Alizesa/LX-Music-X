const test = require('node:test')
const assert = require('node:assert/strict')
const { readSigningCertificate, historicalSigningCertificate, pinSigningCertificate } = require('../publish/signing.cjs')
const { verifyReleaseSigning: verifySigning } = require('../publish/release.cjs')
const { createState } = require('../publish/release-state.cjs')
const { githubFixture, fingerprint, fixtureConfig } = require('./helpers/github.cjs')
const verifyReleaseSigning = (github, certificate) => verifySigning(github, certificate, { config: fixtureConfig })

test('APK signature output must identify exactly one valid signer', () => {
  const output = `Verifies\nSigner #1 certificate DN: CN=LX\nSigner #1 certificate SHA-256 digest: ${fingerprint.toUpperCase()}\nSigner #1 public key SHA-256 digest: ${'b'.repeat(64)}\n`
  assert.equal(readSigningCertificate(output), fingerprint)
  assert.throws(() => readSigningCertificate('DOES NOT VERIFY'), /exactly one/)
  assert.throws(() => readSigningCertificate(output.replace(fingerprint.toUpperCase(), 'short')), /exactly one/)
  assert.throws(() => readSigningCertificate(output + `Signer #2 certificate SHA-256 digest: ${fingerprint}\n`), /exactly one/)
})

test('historical signing identity is inferred only when unambiguous, or explicitly selected from actual history', () => {
  assert.equal(historicalSigningCertificate([fingerprint, fingerprint], null), fingerprint)
  assert.equal(historicalSigningCertificate([], null), null)
  assert.throws(() => historicalSigningCertificate([fingerprint, 'b'.repeat(64)], null), /different signing certificates/)
  assert.equal(historicalSigningCertificate([fingerprint, 'b'.repeat(64)], fingerprint), fingerprint)
  assert.throws(() => historicalSigningCertificate([fingerprint], 'b'.repeat(64)), /does not match/)
})

test('an established certificate cannot be silently rotated by changing release configuration', () => {
  const state = createState('1.9.2', 100000)
  pinSigningCertificate(state, fingerprint, null)
  pinSigningCertificate(state, fingerprint, fingerprint)
  assert.throws(() => pinSigningCertificate(state, 'b'.repeat(64), 'b'.repeat(64)), /cannot rotate/)
  assert.equal(state.signingCertificateSha256, fingerprint)
})

test('concurrent first preparations can establish only one signing identity', async() => {
  const state = { ...createState('1.9.2', 100000), signingHistoryChecked: true }
  const app = githubFixture(state)
  const results = await Promise.allSettled([
    verifyReleaseSigning(app.github, fingerprint),
    verifyReleaseSigning(app.client(), 'b'.repeat(64)),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const rejected = results.find(result => result.status === 'rejected')
  assert.match(rejected.reason.message, /cannot rotate/)
  assert.ok([fingerprint, 'b'.repeat(64)].includes(app.state.signingCertificateSha256))
})

test('an existing pin rejects a wrong preparation without changing metadata', async() => {
  const state = { ...createState('1.9.2', 100000), signingCertificateSha256: fingerprint }
  const app = githubFixture(state)
  await assert.rejects(verifyReleaseSigning(app.github, 'b'.repeat(64)), /cannot rotate/)
  assert.equal(app.calls.filter(call => call.method !== 'GET').length, 0)
  assert.equal(app.state.signingCertificateSha256, fingerprint)
})
