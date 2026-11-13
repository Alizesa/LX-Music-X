function fingerprint(value) {
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value)) throw new Error('Invalid signing certificate SHA-256 fingerprint')
  return value.toLowerCase()
}

function readSigningCertificate(output) {
  // Build Tools 35 prints "Signer #1"; 37 prints "V2 Signer:" (and
  // scheme-qualified V3 signers). V3.1 can print the same identity for several
  // Android SDK ranges. Source-stamp certificates are not application signers.
  const signerLabel = /^(?:(V(?:1|2|3(?:\.[012])?|4)) )?(?:Hybrid (?:Classical|PQC) )?Signer(?: #([1-9]\d*))?(?: \(minSdkVersion=\d+(?: \(dev release=true\))?, maxSdkVersion=\d+\))?:?$/
  const certificates = new Set()
  const signerNumbers = new Map()
  for (const line of output.split(/\r?\n/)) {
    const entry = /^(.+?) certificate SHA-256 digest:\s*(\S+)\s*$/.exec(line.trim())
    if (!entry || /^Source Stamp Signer:?$/.test(entry[1])) continue
    const signer = signerLabel.exec(entry[1])
    if (!signer) throw new Error(`Unsupported APK signer output: ${entry[1]}`)
    certificates.add(fingerprint(entry[2]))
    if (signer[2]) {
      const scheme = signer[1] ?? 'legacy'
      if (!signerNumbers.has(scheme)) signerNumbers.set(scheme, new Set())
      signerNumbers.get(scheme).add(signer[2])
    }
  }
  if (certificates.size !== 1 || [...signerNumbers.values()].some(numbers => numbers.size !== 1 || !numbers.has('1'))) {
    throw new Error(`APK must have exactly one verified signing certificate; found ${certificates.size} distinct certificate(s)`)
  }
  return [...certificates][0]
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
