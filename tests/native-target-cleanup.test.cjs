const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const file = 'android/app/src/main/java/cn/toside/music/mobile/download/DownloadCleanupStore.java'
const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
const body = signature => {
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
const compile = signature => vm.runInThisContext('(function(record, recovery) { with(this) {' + body(signature)
  .replace(/Document document;/g, 'let document;')
  .replace(/List<Document> candidates/g, 'const candidates')
  .replace(/boolean (temporary|confirmedRename)/g, 'const $1')
  .replace(/String previous/g, 'const previous')
  .replace(/\b(DIRECT_CREATING|CREATING|CREATED|RENAMING|WRITING|DELETING|DELETED)\.equals\(record\.phase\)/g, '(record.phase === $1)')
  .replace(/record\.uri\.isEmpty\(\)/g, '(record.uri.length === 0)')
  .replace(/candidates\.size\(\)/g, 'candidates.length')
  .replace(/candidates\.isEmpty\(\)/g, '(candidates.length === 0)')
  .replace(/candidates\.get\(0\)/g, 'candidates[0]')
  .replace(/document\.uri\.equals\(record\.uri\)/g, '(document.uri === record.uri)')
  .replace(/document\.name\.equals\(record\.(finalName|actualName)\)/g, '(document.name === record.$1)')
  .replace(/new IOException\(/g, 'new Error(') + '}})')

// Run the committed cleanup policy after erasing Java type declarations.
// AtomicFile, SAF and Java execution remain CI/APK verification boundaries.
const harness = ({ phase = 'writing', uri = 'content://fixture/tree/root/document/audio', actualName = 'song.mp3', files, completions } = {}) => {
  const prefix = 'lx-download-tmp-22222222-2222-4222-8222-222222222222'
  const initial = { workId: '11111111-1111-4111-8111-111111111111', taskId: 'song', treeUri: 'content://fixture/tree/root', finalName: 'song.mp3', prefix, phase, uri, actualName }
  const disk = new Map([[initial.workId, structuredClone(initial)]])
  const documents = new Map(files ?? [[uri, actualName]])
  const receipts = new Map(completions ?? [])
  const writes = []
  const deleted = []
  const h = { DIRECT_CREATING: 'direct-creating', CREATING: 'creating', CREATED: 'created', RENAMING: 'renaming', WRITING: 'writing', DELETING: 'deleting', DELETED: 'deleted', disk, documents, receipts, writes, deleted, failures: {} }
  const retire = compile('private static void retireDeleted(')
  h.retireDeleted = (record, recovery) => retire.call(h, record, recovery)
  const cleanup = compile('static void cleanupRecord(')
  const recovery = {
    completion: id => receipts.get(id) ?? null,
    completedFile: uri => [...receipts.values()].includes(uri),
    document: (_, uri) => documents.has(uri) ? { uri, name: documents.get(uri) } : null,
    find: record => [...documents].filter(([, name]) => name.startsWith(record.prefix)).map(([uri, name]) => ({ uri, name })),
    delete: (_, uri) => {
      if (h.failures.delete) return false
      deleted.push(uri)
      documents.delete(uri)
      return true
    },
    persist: record => {
      if (h.failures.persist === true || h.failures.persist === record.phase) throw new Error('journal write failed')
      writes.push(structuredClone(record))
      disk.set(record.workId, structuredClone(record))
    },
    remove: record => {
      if (h.failures.remove) throw new Error('journal removal failed')
      disk.delete(record.workId)
    },
  }
  h.recover = () => {
    const saved = disk.get(initial.workId)
    if (saved) cleanup.call(h, structuredClone(saved), recovery)
  }
  h.initial = initial
  return h
}

test('a failed target delete retains its URI and restart cleans it before retiring ownership', () => {
  const h = harness()
  h.failures.delete = true
  assert.throws(h.recover, /Unable to delete/)
  assert.equal(h.disk.get(h.initial.workId).uri, h.initial.uri)
  assert.equal(h.documents.size, 1)
  h.failures.delete = false
  h.recover()
  assert.equal(h.disk.size, 0)
  assert.equal(h.documents.size, 0)
  assert.equal(h.writes.at(-1).phase, 'deleted')
})

test('a created marker document is recovered after death before the returned URI was journaled', () => {
  const h = harness({ phase: 'creating', uri: '', files: [] })
  h.documents.set('content://fixture/tree/root/document/temporary', h.initial.prefix + '.mp3')
  h.documents.set('content://fixture/tree/root/document/user', 'song.mp3')
  h.recover()
  assert.equal(h.disk.size, 0)
  assert.deepEqual([...h.documents.values()], ['song.mp3'])
  assert.equal(h.writes[0].phase, 'created')
  assert.equal(h.writes[0].uri, h.deleted[0])
})

test('failure to journal a discovered target does not delete it and the pre-create intent remains', () => {
  const h = harness({ phase: 'creating', uri: '', files: [] })
  h.documents.set('content://fixture/tree/root/document/temporary', h.initial.prefix + '.mp3')
  h.failures.persist = true
  assert.throws(h.recover, /journal write failed/)
  assert.equal(h.deleted.length, 0)
  assert.equal(h.disk.get(h.initial.workId).phase, 'creating')
  h.failures.persist = false
  h.recover()
  assert.equal(h.disk.size, 0)
  assert.equal(h.documents.size, 0)
})

test('death after file deletion but before a deleted checkpoint can recover an absent target', () => {
  const h = harness()
  h.failures.persist = 'deleted'
  assert.throws(h.recover, /journal write failed/)
  assert.equal(h.documents.size, 0)
  assert.equal(h.disk.get(h.initial.workId).phase, 'deleting')
  h.failures.persist = false
  h.recover()
  assert.equal(h.disk.size, 0)
})

test('a durable deleted checkpoint cannot delete a later file that reuses the same URI', () => {
  const h = harness()
  h.failures.remove = true
  assert.throws(h.recover, /journal removal failed/)
  assert.equal(h.disk.get(h.initial.workId).phase, 'deleted')
  h.documents.set(h.initial.uri, 'song.mp3')
  h.failures.remove = false
  h.recover()
  assert.equal(h.documents.size, 1)
  assert.equal(h.deleted.length, 1)
  assert.equal(h.disk.size, 0)
})

test('death during deletion does not delete an ordinary file that may have reused the URI', () => {
  const h = harness({ phase: 'deleting' })
  assert.throws(h.recover, /Unconfirmed destination deletion/)
  assert.equal(h.documents.size, 1)
  assert.equal(h.deleted.length, 0)
  assert.equal(h.disk.size, 1)
})

for (const otherWork of [false, true]) {
  test(`cleanup preserves the file protected by ${otherWork ? 'another' : 'its own'} completion receipt`, () => {
    const h = harness()
    h.receipts.set(otherWork ? 'other' : h.initial.workId, h.initial.uri)
    h.recover()
    assert.equal(h.disk.size, 0)
    assert.equal(h.deleted.length, 0)
    assert.equal(h.documents.size, 1)
  })
}

test('a completion protected through journal-removal failure remains safe after the receipt is acknowledged', () => {
  const h = harness()
  h.receipts.set(h.initial.workId, h.initial.uri)
  h.failures.remove = true
  assert.throws(h.recover, /journal removal failed/)
  assert.equal(h.deleted.length, 0)
  // Native acknowledgement must retain the completion receipt until this
  // pending journal has really been retired.
  assert.match(body('static synchronized void finishCompleted('), /if \(completion == null\) throw/)
  h.failures.remove = false
  h.recover()
  h.receipts.clear()
  h.recover()
  assert.equal(h.documents.size, 1)
})

test('an unconfirmed URI-changing rename preserves its intent and does not guess a same-name user file', () => {
  const h = harness({ phase: 'renaming', files: [['content://fixture/tree/root/document/new-id', 'song.mp3']] })
  assert.throws(h.recover, /Unconfirmed download rename/)
  assert.equal(h.documents.size, 1)
  assert.equal(h.deleted.length, 0)
  assert.equal(h.disk.size, 1)
})

test('a marker-preserving failed rename cleans the original empty staging document', () => {
  const h = harness({ phase: 'renaming', files: [] })
  h.documents.set(h.initial.uri, h.initial.prefix + '.mp3')
  h.recover()
  assert.equal(h.disk.size, 0)
  assert.equal(h.documents.size, 0)
})

test('an unconfirmed direct-create fallback does not guess a same-name file', () => {
  const h = harness({ phase: 'direct-creating', uri: '', files: [['content://fixture/tree/root/document/user', 'song.mp3']] })
  assert.throws(h.recover, /Unconfirmed destination creation/)
  assert.equal(h.deleted.length, 0)
  assert.equal(h.disk.size, 1)
})

test('null create results retain both marker and direct intents because the provider may have committed before returning', () => {
  const worker = fs.readFileSync(path.join(__dirname, '../android/app/src/main/java/cn/toside/music/mobile/download/MusicDownloadWorker.java'), 'utf8')
  const branches = [...worker.matchAll(/destination = directory\.createFile\([^\n]+\);\s*if \(destination == null\) \{([^}]+)\}/g)]
  assert.equal(branches.length, 2)
  for (const branch of branches) assert.doesNotMatch(branch[1], /discard|remove|retire|finishCompleted/)
  const marker = harness({ phase: 'creating', uri: '', files: [] })
  marker.documents.set('content://fixture/tree/root/document/committed', marker.initial.prefix + '.mp3')
  marker.recover()
  assert.equal(marker.deleted.length, 1)
  assert.equal(marker.disk.size, 0)
  const direct = harness({ phase: 'direct-creating', uri: '', files: [['content://fixture/tree/root/document/committed', 'song.mp3']] })
  assert.throws(direct.recover, /Unconfirmed destination creation/)
  assert.equal(direct.deleted.length, 0)
  assert.equal(direct.disk.size, 1)
})

test('worker and native cancellation preserve target ownership before file I/O and receipt acknowledgement', () => {
  const base = path.join(__dirname, '../android/app/src/main/java/cn/toside/music/mobile/download')
  const worker = fs.readFileSync(path.join(base, 'MusicDownloadWorker.java'), 'utf8')
  const creating = worker.indexOf('DownloadCleanupStore.begin(')
  const create = worker.indexOf('directory.createFile(mimeType, ownership.temporaryName())')
  const renaming = worker.indexOf('DownloadCleanupStore.prepareRename(')
  const rename = worker.indexOf('destination.renameTo(fileName)')
  const writing = worker.indexOf('DownloadCleanupStore.prepareWrite(')
  const output = worker.indexOf('openOutputStream(destination.getUri(), "w")')
  assert.ok(creating < create && create < renaming && renaming < rename && rename < writing && writing < output)
  assert.ok(worker.indexOf('DownloadCleanupStore.hasPendingTask') < worker.indexOf('download(sourceUrl'))
  assert.ok(worker.indexOf('DownloadCompletionStore.read') < worker.indexOf('download(sourceUrl'))
  assert.match(worker, /if \(DownloadCleanupStore.hasPendingTask[^]*?DownloadCleanupStore.cleanupTask[^]*?DownloadDirectoryIndex.invalidate\(treeUri\)/)
  assert.doesNotMatch(worker, /destination\.delete\(\)|destination\.file\.delete\(\)/)
  assert.match(worker, /if \(!completed\) cleanupFailedDestination\(\)/)
  assert.ok(worker.indexOf('streamsClosed.set(null)') < worker.indexOf('if (!completed) cleanupFailedDestination()'))
  assert.match(worker, /if \(!renamed\) \{[^]*?cleanupWork[^]*?beginDirect[^]*?directory.createFile\(mimeType, fileName\)[^]*?prepareWrite/)
  assert.doesNotMatch(worker, /new HashSet<>\(names\)|names.addAll\(reserved/)
  const module = fs.readFileSync(path.join(base, 'DownloadModule.java'), 'utf8')
  const ack = module.slice(module.indexOf('public void acknowledgeCompletion'))
  assert.ok(ack.indexOf('DownloadCleanupStore.finishCompleted') < ack.indexOf('DownloadCompletionStore.acknowledge'))
  assert.match(module, /Futures.addCallback\(cleanup, new FutureCallback<Object>/)
  assert.match(module, /Boolean.FALSE.equals\(cleaned\)/)
  const application = fs.readFileSync(path.join(base, '../MainApplication.java'), 'utf8')
  assert.match(application, /DownloadCleanupStore.recoverPending\(this\)/)
  const early = worker.slice(worker.indexOf('if (receipt != null)'), worker.indexOf('if (DownloadCleanupStore.hasPendingTask'))
  assert.match(early, /clearCompletedPartial\(taskId\)/)
  assert.doesNotMatch(early, /download\(/)
  assert.ok(ack.indexOf('DownloadPartialStore.clear') < ack.indexOf('DownloadCompletionStore.acknowledge'))
})

test('partial cleanup preserves a newer work owner and refuses a file with an active writer', () => {
  const partial = fs.readFileSync(path.join(__dirname, '../android/app/src/main/java/cn/toside/music/mobile/download/DownloadPartialStore.java'), 'utf8')
  const start = partial.indexOf('static synchronized boolean clear(')
  const code = partial.slice(partial.indexOf('{', start) + 1, partial.lastIndexOf('\n  }'))
    .replace(/String owner = owner\(/g, 'const owner = readOwner(')
    .replace(/File (partial|base) =/g, 'const $1 =')
    .replace(/AtomicFile ownership =/g, 'const ownership =')
    .replace(/workId.equals\(owner\)/g, '(workId === owner)')
    .replace(/workId.isEmpty\(\)/g, '(workId.length === 0)')
    .replace(/WRITERS.containsKey\(taskId\)/g, 'WRITERS.has(taskId)')
    .replace(/new File\(base.getPath\(\) \+ ".bak"\)/g, 'backup')
  const clear = vm.runInThisContext('(function(context, taskId, workId) { with(this) {' + code + '}})')
  let owner = 'old'
  let deleted = 0
  let removed = 0
  let canDelete = true
  const h = {
    readOwner: () => owner,
    WRITERS: new Map(),
    MusicDownloadWorker: { otherTaskRunning: () => false, getPartialFile: () => ({ exists: () => true, delete: () => { if (canDelete) deleted++; return canDelete } }) },
    file: () => ({ delete: () => { removed++ }, getBaseFile: () => ({ exists: () => false, getPath: () => '/partial.owner' }) }),
    backup: { exists: () => false },
  }
  owner = 'new'
  assert.equal(clear.call(h, {}, 'song', 'old'), true)
  assert.equal(deleted, 0)
  assert.equal(removed, 0)
  owner = 'old'
  h.WRITERS.set('song', 'old')
  assert.equal(clear.call(h, {}, 'song', 'old'), false)
  h.WRITERS.clear()
  canDelete = false
  assert.equal(clear.call(h, {}, 'song', 'old'), false)
  assert.equal(removed, 0)
  canDelete = true
  assert.equal(clear.call(h, {}, 'song', 'old'), true)
  assert.equal(deleted, 1)
  assert.equal(removed, 1)
  assert.equal(clear.call(h, {}, 'song', ''), true)
  assert.equal(deleted, 2, 'task-only cancellation can remove its stopped partial without a native ID')
  h.WRITERS.set('song', 'new')
  assert.equal(clear.call(h, {}, 'song', ''), false)
  assert.equal(deleted, 2, 'task-only cleanup cannot remove an active newer writer')
  assert.match(partial, /output.getFD\(\).sync\(\)/)
  assert.match(partial, /if \(!workId.equals\(owner\(context, taskId\)\)\)/)
  assert.match(partial, /static synchronized void begin/)
})

test('changed URI identity and ambiguous creation candidates keep recoverable ownership', () => {
  const changed = harness({ actualName: 'song.mp3', files: [['content://fixture/tree/root/document/audio', 'different.mp3']] })
  assert.throws(changed.recover, /identity changed/)
  assert.equal(changed.documents.size, 1)
  const ambiguous = harness({ phase: 'creating', uri: '', files: [] })
  ambiguous.documents.set('one', ambiguous.initial.prefix + '.mp3')
  ambiguous.documents.set('two', ambiguous.initial.prefix + ' (1).mp3')
  assert.throws(ambiguous.recover, /Ambiguous/)
  assert.equal(ambiguous.disk.size, 1)
  assert.equal(ambiguous.documents.size, 2)
})

test('journal and scheduling contracts preserve durability and avoid a global lock during slow SAF deletion', () => {
  const save = body('private static synchronized void save(')
  assert.ok(save.indexOf('bytes.length > 64 * 1024') < save.indexOf('file.startWrite()'))
  assert.ok(save.indexOf('output.getFD().sync()') < save.indexOf('file.finishWrite(output)'))
  assert.match(save, /Record committed = read\(context, record.workId\)/)
  assert.match(save, /file.failWrite\(output\)/)
  assert.match(source, /new ThreadPoolExecutor\(2, 2, 0L, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>\(16\)\)/)
  assert.match(source, /if \(pending != null\) return pending/)
  assert.doesNotMatch(source, /synchronized (?:boolean|void|ListenableFuture<[^>]+>) cleanup(?:Work|Task|All|Record)/)
  assert.ok(body('static ListenableFuture<Boolean> cleanupWork(').indexOf('IN_FLIGHT.remove(workId)') < body('static ListenableFuture<Boolean> cleanupWork(').indexOf('future.set(result)'))
  assert.match(body('static synchronized Set<String> reservedNames('), /names.add\(record.finalName\)/)
  assert.match(body('private static Uri scopedUri('), /Refusing to delete a download directory/)
  assert.match(body('private static synchronized void remove('), /base.exists\(\) \|\| new File/)
})
