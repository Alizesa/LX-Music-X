const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { deferred } = require('./helpers/load.cjs')

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

// These hosts execute type-erased Java control flow, not Java/JNI/Android.
test('rapid native preloads remove superseded queued commands and settle their promises', () => {
  const source = read('patches/AudioPreloader.java')
  const jobs = []
  const results = []
  const running = []
  const h = { active: null, closed: false, limit: 100, PlaybackDebugLogger: { event() {} }, SystemClock: { elapsedRealtime: () => 0 } }
  const compile = (signature, parameters) => vm.runInThisContext('(function(env, ' + parameters + ') { with(env) { with(this) {' + body(source, signature)
    .replace(/synchronized \(task\)/g, '')
    .replace(/\b(?:Task|Runnable|Promise|long) (task|command|pending|bytes)\b/g, 'const $1')
    .replace(/\(long\) /g, '')
    .replace(/task\.id\.equals\(id\)/g, '(task.id === id)')
    .replace(/active\.id\.equals\(id\)/g, '(active.id === id)')
    .replace(/\(\) ->/g, '() =>') + '}}})')
  const cancel = compile('synchronized void cancel()', '')
  h.Task = class {
    constructor(id) { this.id = id; this.startedAt = 0; this.cancelled = false; this.worker = null; this.queued = null; this.pendingPromise = null }
    cancel() { cancel.call(this, h) }
  }
  h.executor = {
    execute: command => jobs.push(command),
    remove: command => { const at = jobs.indexOf(command); if (at < 0) return false; jobs.splice(at, 1); return true },
  }
  h.run = (task, url, agent, bytes, promise) => {
    task.queued = task.pendingPromise = null
    task.worker = { interrupt() {} }
    running.push({ task, url, promise })
  }
  const cancelTask = compile('private void cancelTask(', 'task')
  h.cancelTask = task => cancelTask.call(h, h, task)
  const preload = compile('public synchronized void preload(', 'id, url, userAgent, maxBytes, promise')
  const start = id => preload.call(h, h, id, 'https://audio.test/' + id, '', 100, { resolve: value => results.push({ id, value }), reject: code => results.push({ id, code }) })
  start('running')
  jobs.shift()()
  for (let index = 0; index < 20; index++) start('queued-' + index)
  assert.equal(running.length, 1)
  assert.equal(running[0].task.cancelled, true)
  assert.equal(jobs.length, 1)
  assert.equal(results.length, 19)
  assert.ok(results.every(result => result.code === 'preload_cancelled'))
  h.cancelTask(h.active)
  assert.equal(jobs.length, 0)
  assert.equal(h.active, null)
  assert.equal(results.length, 20)
  assert.equal(results.some(result => result.id === 'running'), false, 'a running read keeps its own terminal cleanup')
  assert.match(body(source, 'private void run('), /task\.queued = null;\s*task\.pendingPromise = null;/)
})

test('a slow SAF writer cannot block completion of another native cancellation', async() => {
  const source = read('android/app/src/main/java/cn/toside/music/mobile/download/MusicDownloadWorker.java')
  const slow = deferred()
  const fast = deferred()
  const workers = new Map()
  for (const [id, gate] of [['slow', slow], ['fast', fast]]) {
    workers.set(id, {
      getId: () => id,
      value: () => id,
      streamsClosed: gate.promise,
    })
  }
  const h = {
    RUNNING: workers,
    KEY_TASK_ID: 'taskId',
    MoreExecutors: { directExecutor: () => null },
    Futures: { allAsList: Promise.all.bind(Promise), transform: (promise, fn) => promise.then(fn) },
  }
  const control = body(source, 'public static ListenableFuture<Void> whenStopped(')
    .replace(/List<ListenableFuture<Void>> pending = new ArrayList<>\(\);/g, 'const pending = [];')
    .replace(/for \(MusicDownloadWorker worker : RUNNING\.values\(\)\)/g, 'for (const worker of RUNNING.values())')
    .replace(/!workId\.isEmpty\(\)/g, 'workId.length > 0')
    .replace(/worker\.getId\(\)\.toString\(\)\.equals\(workId\)/g, '(worker.getId().toString() === workId)')
    .replace(/worker\.value\(KEY_TASK_ID\)\.equals\(taskId\)/g, '(worker.value(KEY_TASK_ID) === taskId)')
    .replace(/pending\.add\(/g, 'pending.push(')
    .replace(/ignored ->/g, 'ignored =>')
  const whenStopped = vm.runInThisContext('(function(workId, taskId) { with(this) {' + control + '}})')
  let slowFinished = false
  const a = whenStopped.call(h, 'slow', null).then(() => { slowFinished = true })
  const b = whenStopped.call(h, 'fast', null)
  fast.resolve(null)
  await b
  assert.equal(slowFinished, false)
  slow.resolve(null)
  await a
  const module = read('android/app/src/main/java/cn/toside/music/mobile/download/DownloadModule.java')
  assert.match(module, /Futures\.addCallback\(MusicDownloadWorker\.whenStopped/)
  assert.doesNotMatch(module, /awaitStopped\(|cancellations|newSingleThreadExecutor/)
  assert.ok(source.indexOf('streamsClosed.set(null)') > source.indexOf('RUNNING.remove(getId().toString(), this)'))
})

test('cache statistics coalesce a burst without scanning on the RN invocation path', () => {
  const source = read('android/app/src/main/java/cn/toside/music/mobile/cache/CacheModule.java')
  const jobs = []
  const values = []
  const errors = []
  let scans = 0
  const h = {
    statisticsLock: {},
    statisticsWaiters: [],
    statisticsPending: false,
    STATISTICS: { execute: fn => jobs.push(fn) },
    getReactApplicationContext: () => ({ getCacheDir: () => '/internal', getExternalCacheDir: () => '/external' }),
    getDirSize: () => { scans++; return 10 },
  }
  const compile = (signature, parameters) => vm.runInThisContext('(function(' + parameters + ') { with(this) {' + body(source, signature)
    .replace(/synchronized \(statisticsLock\)/g, '')
    .replace(/\b(?:String|Exception|long) (size|failure|fileSize)\b/g, 'let $1')
    .replace(/List<Promise> waiters;/g, 'let waiters;')
    .replace(/new ArrayList<>\(\)/g, '[]')
    .replace(/for \(Promise waiter : waiters\)/g, 'for (const waiter of waiters)')
    .replace(/catch \(Exception error\)/g, 'catch (error)')
    .replace(/String\.valueOf\(/g, 'String(')
    .replace(/this::readCacheSize/g, '() => readCacheSize()')
    .replace(/statisticsWaiters\.add\(/g, 'statisticsWaiters.push(') + '}})')
  h.readCacheSize = compile('private void readCacheSize()', '')
  const request = compile('public void getAppCacheSize(', 'promise')
  const promise = { resolve: value => values.push(value), reject: (...args) => errors.push(args) }
  for (let index = 0; index < 1000; index++) request.call(h, promise)
  assert.equal(scans, 0)
  assert.equal(jobs.length, 1)
  jobs.shift()()
  assert.equal(scans, 2)
  assert.equal(values.length, 1000)
  assert.ok(values.every(value => value === '20'))
  assert.equal(h.statisticsWaiters.length, 0)
  assert.equal(h.statisticsPending, false)
  h.getDirSize = () => { throw new Error('scan failed') }
  request.call(h, promise)
  jobs.shift()()
  assert.equal(errors.length, 1)
  assert.equal(errors[0][0], 'cache_size_failed')
  assert.equal(h.statisticsWaiters.length, 0)
})
