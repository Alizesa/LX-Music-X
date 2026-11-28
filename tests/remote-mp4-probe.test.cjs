const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

// Project policy: Android Java is compiled only in CI, never by local checks.
test('native MP4 and FLAC parsers handle bounded binary fixtures', { skip: !process.env.CI && 'Java compilation runs only in CI' }, () => {
  const root = path.join(__dirname, '..')
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-mp4-fixtures-'))
  try {
    const compile = spawnSync('javac', ['-encoding', 'UTF-8', '-d', output,
      path.join(root, 'android/app/src/main/java/cn/toside/music/mobile/utils/Mp4AudioMetadata.java'),
      path.join(root, 'android/app/src/main/java/cn/toside/music/mobile/utils/FlacFrameBounds.java'),
      path.join(__dirname, 'native/FlacFrameBoundsTest.java'),
      path.join(__dirname, 'native/Mp4AudioMetadataTest.java')], { encoding: 'utf8', timeout: 30000 })
    assert.equal(compile.status, 0, compile.stderr || String(compile.error))
    const run = spawnSync('java', ['-cp', output, 'cn.toside.music.mobile.utils.Mp4AudioMetadataTest'], { encoding: 'utf8', timeout: 30000 })
    assert.equal(run.status, 0, run.stderr || String(run.error))
    assert.match(run.stdout, /fixtures passed/)
  } finally {
    fs.rmSync(output, { recursive: true, force: true })
  }
})
