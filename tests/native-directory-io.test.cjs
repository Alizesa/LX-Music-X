const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const patches = require('../patches/native-io')

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
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

class JavaSet extends Set {
  add(value) { const added = !this.has(value); super.add(value); return added }
}
class LruMap extends Map {
  get(key) { const value = super.get(key); if (this.has(key)) { super.delete(key); super.set(key, value) } return value ?? null }
  put(key, value) { super.set(key, value) }
  remove(key) { const value = super.get(key); super.delete(key); return value ?? null }
  entrySet() { return { iterator: () => ({ next: () => ({ getKey: () => this.keys().next().value }) }) } }
}
const index = () => {
  const source = read('android/app/src/main/java/cn/toside/music/mobile/download/DownloadDirectoryIndex.java')
  const h = { snapshots: new LruMap(), characters: 0, Snapshot: class { constructor(names, expiresAt, characters) { Object.assign(this, { names, expiresAt, characters }) } } }
  for (const name of ['TTL_MS', 'MAX_DIRECTORIES', 'MAX_NAMES', 'MAX_CHARACTERS']) h[name] = Number(source.match(new RegExp(name + ' = ([\\d_]+)'))[1].replace(/_/g, ''))
  const compile = (signature, parameters) => vm.runInThisContext('(function(' + parameters + ') { with(this) {' + body(source, signature)
    .replace(/\b(?:Snapshot|long) (entry|removed|size)\b/g, 'let $1')
    .replace(/for \(String name : names\)/g, 'for (const name of names)')
    .replace(/Map\.Entry<String, Snapshot> eldest/g, 'const eldest')
    .replace(/name\.length\(\)/g, 'name.length')
    .replace(/names\.size\(\)/g, 'names.size')
    .replace(/snapshots\.size\(\)/g, 'snapshots.size') + '}})')
  h.get = compile('static synchronized Set<String> get(', 'treeUri, now')
  h.put = compile('static synchronized void put(', 'treeUri, names, now')
  h.created = compile('static synchronized void created(', 'treeUri, name')
  h.invalidate = compile('static synchronized void invalidate(', 'treeUri')
  h.trim = compile('private static void trim()', '')
  return h
}

test('1000 consecutive destinations reuse one 10000-name directory snapshot and record created names', () => {
  const h = index()
  let scans = 0
  let enumerated = 0
  const directory = new JavaSet(Array.from({ length: 10000 }, (_, id) => 'existing-' + id + '.mp3'))
  for (let id = 0; id < 1000; id++) {
    let names = h.get('tree', id)
    if (names === null) {
      scans++; enumerated += directory.size
      names = new JavaSet(directory)
      h.put('tree', names, id)
    }
    h.created('tree', 'download-' + id + '.mp3')
    directory.add('download-' + id + '.mp3')
  }
  assert.equal(scans, 1)
  assert.equal(enumerated, 10000)
  assert.equal(h.get('tree', 1000).size, 11000)
  const characters = h.characters
  h.created('tree', 'download-0.mp3')
  assert.equal(h.characters, characters, 'repeated completion must not inflate the cache budget')
  assert.equal(h.get('tree', h.TTL_MS), null)
  assert.equal(h.characters, 0)
})

test('directory snapshots have name, character and directory limits with LRU eviction', () => {
  const h = index()
  for (const key of ['one', 'two', 'three']) h.put(key, new JavaSet([key]), 0)
  h.get('one', 1)
  h.put('four', new JavaSet(['four']), 1)
  assert.equal(h.get('two', 2), null)
  assert.equal(h.get('one', 2).has('one'), true)
  h.put('huge', new JavaSet(['x'.repeat(h.MAX_CHARACTERS + 1)]), 3)
  assert.equal(h.get('huge', 3), null)
  h.put('many', new JavaSet(Array.from({ length: h.MAX_NAMES + 1 }, (_, id) => String(id))), 3)
  assert.equal(h.get('many', 3), null)
  h.invalidate('one')
  assert.equal(h.get('one', 3), null)
  assert.ok(h.snapshots.size <= h.MAX_DIRECTORIES)
  assert.ok(h.characters <= h.MAX_CHARACTERS)
})

test('worker destination creation records provider names and invalidates failed destination ownership', () => {
  const source = read('android/app/src/main/java/cn/toside/music/mobile/download/MusicDownloadWorker.java')
  const destination = body(source, 'private Destination copyToDestination(')
  assert.match(destination, /DownloadDirectoryIndex\.get\(treeUri, now\)/)
  assert.match(destination, /names = readNames\(directory\);\s*DownloadDirectoryIndex\.put/)
  assert.match(destination, /fileName = actualName;[^]*?DownloadDirectoryIndex\.created\(treeUri, fileName\)/)
  assert.match(destination, /if \(!copied\) \{\s*DownloadDirectoryIndex\.invalidate\(treeUri\)/)
  assert.match(source, /if \(!completed && destination != null\) \{\s*DownloadDirectoryIndex\.invalidate\(treeUri\)/)
  assert.match(source, /if \(!completed\) cleanupFailedDestination\(\)/)
})

for (const closeFails of [false, true]) {
  test(`local lyric sidecar closes after early return${closeFails ? ' even if the audio wrapper close fails' : ''}`, () => {
    const java = patches.find(([file, , to]) => file.endsWith('Metadata.java') && to.startsWith('public static String readLyric(ReactApplicationContext'))[2]
    const files = []
    const h = {
      MediaFile: class {
        constructor(context, file) { this.file = file; this.closed = false; files.push(this) }
        getFile() { return this.file }
        exists() { return true }
        closeFile() { this.closed = true; if (closeFails && !this.file.endsWith('.lrc')) throw new Error('close failed') }
      },
      readLyricFile: () => 'sidecar lyric',
      AudioFileIO: { read: () => assert.fail('the sidecar should return first') },
    }
    const control = body(java, 'public static String readLyric(')
      .replace(/\b(?:MediaFile|File|String|Tag|org\.jaudiotagger\.audio\.AudioFile) (mediaFile|lrcMediaFile|file|lrc|tag|audioFile)\b/g, 'const $1')
      .replace(/""\.equals\(lrc\)/g, '(lrc === "")')
    const readLyric = vm.runInThisContext('(function(context, filePath, isReadLrcFile) { with(this) {' + control + '}})')
    if (closeFails) assert.throws(() => readLyric.call(h, {}, '/song.mp3', true), /close failed/)
    else assert.equal(readLyric.call(h, {}, '/song.mp3', true), 'sidecar lyric')
    assert.equal(files.length, 2)
    assert.ok(files.every(file => file.closed))
  })
}

test('SAF and lyric dependency patches round-trip and use paired streams with appropriate buffers', () => {
  for (const [file, from, to] of patches) {
    const installed = read('node_modules/' + file).replace(/\r\n/g, '\n')
    assert.ok(installed.includes(to), file)
    assert.equal(installed.replace(to, from).replace(from, to), installed)
    assert.doesNotMatch(to, /new byte\[1024\]/)
  }
  const lyric = patches.find(([, , to]) => to.startsWith('public static String readLyricFile'))[2]
  assert.match(lyric, /try \(FileInputStream fileInputStream = new FileInputStream\(lrcFile\);\s*ByteArrayOutputStream byteArrayOutputStream/)
  for (const patch of patches.filter(([file]) => file.endsWith('MediaFile.java') || file.endsWith('FileSystem.java'))) assert.match(patch[2], /new byte\[64 \* 1024\]/)
})
