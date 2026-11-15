const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const patches = require('../patches/media-metadata')

// Type-erased control flow from the committed Java patch, with the metadata
// retriever and file output replaced. Android behavior still requires CI/APK.
const body = (source, signature) => {
  const start = source.indexOf(signature)
  assert.notEqual(start, -1)
  const open = source.indexOf('{', start)
  let depth = 1
  let end = open + 1
  for (; depth && end < source.length; end++) {
    if (source[end] === '{') depth++
    if (source[end] === '}') depth--
  }
  return source.slice(open + 1, end - 1)
}
const eraseTypes = source => source
  .replace(/\bint (i|i2|formatIndex)\b/g, 'let $1')
  .replace(/\b(?:Format|Metadata(?:\.Entry)?|ApicFrame|PictureFrame) (\w+)\b/g, 'const $1')
  .replace(/\((?:ApicFrame|PictureFrame)\) /g, '')
  .replace(/"APIC"\.equals\(pic\.id\)/g, '(pic.id === "APIC")')
  .replace(/\bString result;/g, 'let result;')
  .replace(/catch \(Exception error\)/g, 'catch (error)')
  .replace(/error\.getMessage\(\)/g, 'error.message')

class ApicFrame {
  constructor({ front = true } = {}) { this.id = 'APIC'; this.pictureType = front ? 3 : 0; this.mimeType = 'image/jpeg'; this.pictureData = [1] }
}
class PictureFrame {
  constructor() { this.pictureType = 3; this.mimeType = 'image/png'; this.pictureData = [2] }
}
const metadata = entries => ({ length: () => entries.length, get: index => entries[index] })
const tracks = groups => ({ length: groups.length, get: index => ({ length: groups[index].length, getFormat: format => ({ metadata: groups[index][format] }) }) })
const harness = ({ write = () => '/cover.jpg' } = {}) => {
  const java = patches[0][2]
  const find = vm.runInThisContext('(function(trackGroups, ApicFrame, PictureFrame, writePic, context, uri, picDir) {' + eraseTypes(body(java, 'private String findPicture(')) + '})')
  const settle = vm.runInThisContext('(function(trackGroups, findPicture, promise) {' + eraseTypes(body(java, 'public void onSuccess(')) + '})')
  const results = []
  const run = trackGroups => settle(trackGroups, groups => find(groups, ApicFrame, PictureFrame, write, {}, 'content://audio.mp3', '/covers'), {
    resolve: result => results.push({ resolved: result }),
    reject: (code, message) => results.push({ code, message }),
  })
  return { run, results }
}

for (const [label, groups] of [
  ['empty track groups', tracks([])],
  ['null retriever result', null],
  ['an untagged MP3', tracks([[null]])],
  ['multiple untagged tracks', tracks([[null], [null, null]])],
  ['metadata without artwork', tracks([[metadata([])], [metadata(['title'])]])],
  ['non-front artwork', tracks([[metadata([new ApicFrame({ front: false })])]])],
]) {
  test(`Media3 resolves ${label} exactly once`, () => {
    const h = harness()
    h.run(groups)
    assert.deepEqual(h.results, [{ resolved: '' }])
  })
}

for (const frame of [new ApicFrame(), new PictureFrame()]) {
  test(`Media3 finds ${frame.constructor.name} after a track and format with no cover`, () => {
    const h = harness()
    h.run(tracks([[metadata([])], [null, metadata([frame])], [metadata([new PictureFrame()])]]))
    assert.deepEqual(h.results, [{ resolved: '/cover.jpg' }])
  })
}

test('Media3 rejects failed artwork output exactly once', () => {
  const h = harness({ write: () => { throw new Error('permission denied') } })
  h.run(tracks([[metadata([new ApicFrame()])]]))
  assert.deepEqual(h.results, [{ code: '-1', message: 'read failed: permission denied' }])
})

test('the install patch matches fresh dependencies and its installed replacement is idempotent', () => {
  const target = path.join(__dirname, '../node_modules/react-native-local-media-metadata/android/src/main/java/com/localmediametadata', patches[0][0])
  const installed = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n')
  const from = patches[0][1]
  const to = patches[0][2]
  assert.ok(installed.includes(to))
  assert.ok(installed.replace(to, from).replace(from, to) === installed)
  assert.doesNotMatch(to, /@Override\s+private String/)
  assert.equal((body(to, 'public void onSuccess(').match(/promise\.resolve\(/g) || []).length, 1)
  assert.doesNotMatch(body(to, 'private String findPicture('), /promise\./)
})
