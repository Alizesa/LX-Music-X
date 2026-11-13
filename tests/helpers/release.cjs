const { ABIS } = require('../../shared/release')

const repository = 'Alizesa/LX-Music-X'
const packageName = 'lx-music-mobile'
const manifest = (version = '1.9.3', versionCode = 100003) => {
  const tag = `v${version}`
  return {
    schemaVersion: 1,
    channel: version.includes('-next.') ? 'next' : 'stable',
    version, versionCode, tag, sourceSha: 'a'.repeat(40),
    publishedAt: '2026-11-12T12:00:00.000Z',
    releaseUrl: `https://github.com/${repository}/releases/tag/${tag}`,
    desc: 'Update notes', history: [],
    assets: ABIS.map(abi => {
      const fileName = `${packageName}-${tag}-${abi}.apk`
      return { abi, fileName, url: `https://github.com/${repository}/releases/download/${tag}/${fileName}`, size: 12345, sha256: 'b'.repeat(64) }
    }),
  }
}

module.exports = { manifest, repository, packageName }
