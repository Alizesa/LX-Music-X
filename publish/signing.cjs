function fingerprint(value) {
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value)) throw new Error('Invalid signing certificate SHA-256 fingerprint')
  return value.toLowerCase()
}

function readSigningCertificate(output) {
  const certificates = [...output.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([a-fA-F0-9]+)\s*$/gm)]
  if (certificates.length !== 1) throw new Error('APK must have exactly one verified signing certificate')
  return fingerprint(certificates[0][1])
}

function historicalSigningCertificate(certificates, configured) {
  const known = new Set(certificates.map(fingerprint))
  if (configured != null) {
    const expected = fingerprint(configured)
    if (known.size && !known.has(expected)) throw new Error('Configured signing certificate does not match any historical APK of this application')
    return expected
  }
  if (known.size > 1) throw new Error('Historical APKs use different signing certificates; configure signingCertificateSha256 explicitly')
  return [...known][0] ?? null
}

function pinSigningCertificate(state, certificate, configured) {
  const actual = fingerprint(certificate)
  if (configured != null && actual !== fingerprint(configured)) throw new Error('APK signing certificate differs from release configuration')
  if (state.signingCertificateSha256 && actual !== fingerprint(state.signingCertificateSha256)) {
    throw new Error('APK signing certificate changed; automatic release cannot rotate the installed application signing key')
  }
  state.signingCertificateSha256 = actual
  state.signingHistoryChecked = true
  return actual
}

module.exports = { fingerprint, readSigningCertificate, historicalSigningCertificate, pinSigningCertificate }
