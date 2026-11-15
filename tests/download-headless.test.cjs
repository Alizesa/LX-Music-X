const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const vm = require('node:vm')
const { load, flush, deferred } = require('./helpers/load.cjs')
const { createHarness, task, completed } = require('./helpers/download-cleanup-runtime.cjs')

const runtimeHarness = ({ bootstrap = async() => {} } = {}) => {
  const appState = { currentState: 'background' }
  const setting = { 'common.langId': 'zh_cn', 'common.apiSource': 'source' }
  const counts = { settings: 0, i18n: 0, scripts: 0, sources: 0 }
  let options
  const global = { i18n: { availableLocales: ['zh_cn'], setLanguage() {} } }
  const runtime = load('src/core/init/musicRuntime.ts', {
    'react-native': { AppState: appState },
    '@/core/common': { initSetting: async() => { counts.settings++; await bootstrap(); return setting } },
    '@/core/apiSource': { setApiSource: () => { counts.sources++ } },
    '@/store/setting/state': { default: { setting } },
    './i18n': { default: async() => { counts.i18n++ } },
    './userApi': { default: async(_setting, value) => { counts.scripts++; options = value } },
  }, { global })
  return { runtime, counts, appState, options: () => options }
}

const serviceHarness = (api, runtime = runtimeHarness(), caches = { releaseIdleCaches() {}, releaseIdleLocalListCache() {} }) => {
  const acknowledgments = []
  const clock = new Map(); let sequence = 0
  const service = load('src/core/downloadService.ts', {
    'react-native': { AppState: runtime.appState },
    './init/musicRuntime': runtime.runtime,
    './download': api,
    '@/utils/nativeModules/download': { finishDownloadQueueDispatch: async(workId, success) => { acknowledgments.push({ workId, success }) } },
    './cacheLifecycle': caches,
    './localList': caches,
  }, {
    setTimeout: (fn, delay) => { const id = ++sequence; clock.set(id, { fn, delay }); return id },
    clearTimeout: id => clock.delete(id),
  })
  return { ...service, acknowledgments, clock, runtime }
}

test('foreground and headless initialization share settings and install the source listeners once', async() => {
  const h = runtimeHarness()
  const settings = await Promise.all([h.runtime.initializeRuntimeSettings(), h.runtime.initializeRuntimeSettings()])
  await Promise.all(settings.map(setting => h.runtime.initializeMusicRuntime(setting)))
  assert.deepEqual(h.counts, { settings: 1, i18n: 1, scripts: 1, sources: 1 })
  assert.equal(h.options().suppressDialogs(), true)
  h.appState.currentState = 'active'
  assert.equal(h.options().suppressDialogs(), false)
})

test('background startup waits for AppLaunched before reading window state or registering navigation', async() => {
  const launch = []
  let fonts = 0; let windows = 0; let navigation = 0
  load('src/app.ts', {
    '@/utils/errorHandle': {},
    '@/utils/log': {},
    '@/utils/bootLog': { bootLog() {} },
    '@/config/globalData': {},
    '@/utils/data': { getFontSize: async() => { fonts++; return 1 } },
    './utils/nativeModules/utils': {},
    './utils/windowSizeTools': { windowSizeTools: { init: async() => { windows++ } } },
    './navigation/regLaunchedEvent': { listenLaunchEvent() {}, onAppLaunched: callback => launch.push(callback) },
    'react-native': { NativeModules: { DownloadModule: { downloadHeadlessBoot: true } } },
    './utils/tools': { tipDialog: async() => { throw new Error('unexpected dialog') } },
    '@/navigation': { init: () => { navigation++ } },
  }, { global: { lx: {} } })
  await flush()
  assert.equal(fonts, 0); assert.equal(windows, 0); assert.equal(navigation, 0)
  launch[0](); launch[0]()
  await flush()
  assert.equal(fonts, 1); assert.equal(windows, 1); assert.equal(navigation, 1)
})

test('the registered headless entry forwards native dispatch data to the production handler', async() => {
  let taskName; let provider; let forwarded
  load('index.js', {
    './shim': {},
    './src/app': {},
    'react-native': { AppRegistry: { registerHeadlessTask: (name, value) => { taskName = name; provider = value } } },
    './src/core/downloadService': { runDownloadQueueDispatch: async data => { forwarded = data } },
  })
  assert.equal(taskName, 'LXDownloadQueue')
  await provider()({ workId: 'dispatch' })
  assert.deepEqual(forwarded, { workId: 'dispatch' })
})

test('a warm headless attempt consumes completion receipts when every broadcast was missed', async() => {
  const h = await createHarness({ active: Array.from({ length: 8 }, (_, i) => task(String(i))) })
  await serviceHarness(h.api).runDownloadQueueDispatch({ workId: 'first-window' })
  for (const item of await h.data.getDownloadActiveTasks()) {
    if (!item.nativeId) continue
    h.receipts.set(item.nativeId, completed(item.id, item.nativeId, 'content://ready/' + item.id))
  }
  const service = serviceHarness(h.api)
  let done = false
  const work = service.runDownloadQueueDispatch({ workId: 'missed-broadcasts' }).then(() => { done = true })
  for (let i = 0; i < 8; i++) { if (done) break; await flush(); await h.run(250) }
  await work
  await h.run(250)
  assert.equal(h.enqueued.length, 8)
  assert.equal(h.urlCalls(), 8)
  assert.equal(h.local.size, 4)
})

test('native completion restarts the JS instance for every window and all 30 downloads still finish once', async() => {
  const h = await createHarness({ active: Array.from({ length: 30 }, (_, i) => task(String(i))) })
  let current = h
  let windows = 0
  while (true) {
    const service = serviceHarness(current.api)
    let done = false
    const work = service.runDownloadQueueDispatch({ workId: 'dispatch-' + windows }).then(() => { done = true })
    for (let tick = 0; tick < 12; tick++) {
      if (done) break
      await flush(); await current.run(250)
    }
    await work
    assert.deepEqual(service.acknowledgments, [{ workId: 'dispatch-' + windows, success: true }])
    assert.deepEqual(service.runtime.counts, { settings: 1, i18n: 1, scripts: 1, sources: 1 })
    if (current.historyApi.getDownloadHistoryCount() === 30) break
    const scheduled = (await current.data.getDownloadActiveTasks()).filter(item => item.nativeId && (item.status === 'waiting' || item.status === 'run'))
    assert.ok(scheduled.length <= 4)
    for (const item of scheduled) {
      const path = 'content://download/' + item.id
      h.files.add(path)
      h.receipts.set(item.nativeId, completed(item.id, item.nativeId, path))
    }
    current = h.restart()
    windows++
    assert.ok(windows <= 20, 'dispatch did not progress')
  }
  assert.equal(h.enqueued.length, 30)
  assert.equal(h.urlCalls(), 30)
  assert.equal(new Set(h.enqueued.map(item => item.taskId)).size, 30)
  assert.equal(h.local.size, 30)
  assert.equal(h.receipts.size, 0)
})

test('a failed headless bootstrap keeps waiting tasks and receipts available for the next attempt', async() => {
  const h = await createHarness({ active: Array.from({ length: 10 }, (_, i) => task(String(i))) })
  let fail = true
  const runtime = runtimeHarness({ bootstrap: async() => { if (fail) throw new Error('settings unavailable') } })
  const service = serviceHarness(h.api, runtime)
  await assert.rejects(service.runDownloadQueueDispatch({ workId: 'failed' }), /settings unavailable/)
  assert.equal((await h.data.getDownloadActiveTasks()).length, 10)
  assert.equal(h.urlCalls(), 0)
  assert.deepEqual(service.acknowledgments, [{ workId: 'failed', success: false }])
  fail = false
  await service.runDownloadQueueDispatch({ workId: 'retried' })
  assert.equal(h.enqueued.length, 4)
})

for (const foreground of [false, true]) {
  test(`a headless deadline ${foreground ? 'keeps foreground requests running' : 'cancels background preparation and preserves pending songs'}`, async() => {
    const first = deferred(); let requests = 0
    const h = await createHarness({ active: Array.from({ length: 10 }, (_, i) => task(String(i))), url: () => ++requests === 1 ? first.promise : Promise.resolve('https://fixture/current') })
    const runtime = runtimeHarness(); if (foreground) runtime.appState.currentState = 'active'
    const service = serviceHarness(h.api, runtime)
    const work = service.runDownloadQueueDispatch({ workId: 'expired' })
    const outcome = work.then(() => null, error => error)
    await flush()
    assert.equal(h.urlCalls(), 1)
    const timer = [...service.clock.values()].find(value => value.delay === 75000)
    timer.fn()
    assert.match((await outcome).message, /取消http请求/)
    await flush()
    first.resolve('https://fixture/late')
    await flush()
    assert.deepEqual(service.acknowledgments, [{ workId: 'expired', success: false }])
    if (!foreground) {
      assert.equal(h.enqueued.length, 0)
      assert.equal(h.urlCalls(), 1)
      await h.api.initDownloads()
      await flush()
    }
    assert.equal(h.enqueued.length, 4)
    assert.equal((await h.data.getDownloadActiveTasks()).length, 10)
  })
}

test('native dispatch coalesces terminal events, retries finitely and separates acknowledgment attempts', () => {
  const native = fs.readFileSync('android/app/src/main/java/cn/toside/music/mobile/download/DownloadQueueWorker.java', 'utf8')
  assert.match(native, /enqueueUniqueWork\(WORK_NAME, ExistingWorkPolicy\.REPLACE, request\)/)
  assert.match(native, /setRequiredNetworkType\(NetworkType\.CONNECTED\)/)
  assert.match(native, /getRunAttemptCount\(\) < 2/)
  assert.match(native, /UUID\.randomUUID\(\)\.toString\(\)/)
  assert.match(native, /RUNNING\.remove\(token, current\)/)
  assert.match(native, /removeReactInstanceEventListener/)
  assert.match(native, /removeTaskEventListener/)
  const module = fs.readFileSync('android/app/src/main/java/cn/toside/music/mobile/download/DownloadModule.java', 'utf8')
  assert.match(module, /Operation operation = WorkManager\.getInstance\(reactContext\)\.enqueueUniqueWork/)
  assert.match(module, /onSuccess\(Operation\.State\.SUCCESS result\)[\s\S]*?promise\.resolve\(request\.getId\(\)\.toString\(\)\)/)
})

// 执行原生纯协调类的方法正文；Android/WorkManager 调用由下方可控时序模型代替。
const nativeCoordinator = (requested = 0, completed = 0) => {
  const source = fs.readFileSync('android/app/src/main/java/cn/toside/music/mobile/download/DownloadDispatchState.java', 'utf8')
  const state = { requested: 0, completed: 0, queued: false, owner: null }
  for (const match of source.matchAll(/\n {2}(?:(?:boolean|void|long) )?(\w+)\(([^)]*)\) \{([\s\S]*?)\n {2}\}/g)) {
    const parameters = match[2] ? match[2].split(',').map(value => value.trim().split(' ').at(-1)) : []
    const body = match[3].replace(/owner\.equals\(identity\)/g, '(owner === identity)')
    state[match[1]] = vm.runInNewContext('(function (' + parameters.join(',') + ') { with (this) {' + body + '} })')
  }
  state.DownloadDispatchState(requested, completed)
  return state
}

test('completion before acknowledgment reruns the same dispatcher and completion after sealing queues exactly one successor', () => {
  const state = nativeCoordinator()
  let workState = 'running'; let pending = 0; let replacements = 0
  const enqueue = policy => {
    if (policy === 'KEEP' && workState === 'running') return
    workState = 'queued'; pending = 1; replacements++
  }
  // 旧 KEEP 策略在此窗口会丢弃最后一次完成通知。
  enqueue('KEEP')
  assert.equal(pending, 0)
  assert.equal(state.request(), true)
  state.start('current')
  const before = state.claim()
  for (let i = 0; i < 1000; i++) assert.equal(state.request(), false)
  assert.equal(state.complete('current', before), false)
  assert.equal(state.complete('current', state.claim()), true)
  // WorkManager 仍标记旧 work 为 RUNNING；原生 owner 已封口。
  workState = 'running'
  if (state.request()) enqueue('REPLACE')
  for (let i = 0; i < 1000; i++) if (state.request()) enqueue('REPLACE')
  assert.equal(pending, 1)
  assert.equal(replacements, 1)
  state.start('successor')
  assert.equal(state.complete('successor', state.claim()), true)
  assert.equal(state.recover(), false)
})

test('persisted unacknowledged dispatch generations recover after process loss and old owners cannot release a new one', () => {
  const restarted = nativeCoordinator(100, 99)
  assert.equal(restarted.recover(), true)
  assert.equal(restarted.recover(), false)
  restarted.start('new-owner')
  restarted.fail('old-owner')
  assert.equal(restarted.isActive(), true)
  assert.equal(restarted.complete('new-owner', restarted.claim()), true)
  const clean = nativeCoordinator(restarted.requested, restarted.completed)
  assert.equal(clean.recover(), false)
})

test('an obsolete headless deadline cannot suspend preparation owned by a newer attempt', async() => {
  const firstUrl = deferred()
  const h = await createHarness({ active: Array.from({ length: 10 }, (_, i) => task(String(i))), url: () => firstUrl.promise })
  const first = serviceHarness(h.api)
  const oldWork = first.runDownloadQueueDispatch({ workId: 'old' })
  const oldOutcome = oldWork.then(() => null, error => error)
  await flush()
  const second = serviceHarness(h.api)
  const current = second.runDownloadQueueDispatch({ workId: 'current' })
  await flush()
  const oldTimer = [...first.clock.values()].find(value => value.delay === 75000)
  oldTimer.fn()
  assert.match((await oldOutcome).message, /取消http请求/)
  firstUrl.resolve('https://fixture/current')
  await current
  assert.equal(h.enqueued.length, 4)
  assert.equal(h.urlCalls(), 4)
  assert.deepEqual(second.acknowledgments, [{ workId: 'current', success: true }])
})

for (const stage of ['LOCAL', 'history', 'ack']) {
  test(`a headless deadline during ${stage} I/O cannot clear the archive context before it commits`, async() => {
    const gate = deferred()
    const state = completed('ready', 'receipt-work', 'content://ready')
    const h = await createHarness({
      active: [{ ...task('ready'), nativeId: 'receipt-work', status: 'run' }],
      receipts: new Map([['receipt-work', state]]),
      catalog: stage === 'LOCAL' ? { beforeLocal: () => gate.promise } : stage === 'ack' ? { beforeAck: () => gate.promise } : undefined,
    })
    if (stage === 'history') {
      const set = h.disk.native.multiSet
      h.disk.native.multiSet = async values => {
        if (values.some(([key]) => key.startsWith('@download_history_item'))) await gate.promise
        await set(values)
      }
    }
    const service = serviceHarness(h.api)
    const work = service.runDownloadQueueDispatch({ workId: 'catalog-deadline' })
    const outcome = work.then(() => null, error => error)
    await flush(); await h.run(250)
    const timer = [...service.clock.values()].find(value => value.delay === 75000)
    timer.fn()
    await outcome
    gate.resolve()
    await flush()
    assert.equal(h.api.isDownloadCompleted('ready'), true)
    assert.equal(h.receipts.size, 0)
    assert.equal((await h.data.getDownloadActiveTasks()).length, 0)
    assert.equal(h.urlCalls(), 0)
  })
}

test('headless cleanup releases idle caches after the real LOCAL lease settles and preserves the playing list', async() => {
  const constants = load('src/config/constant.ts')
  const player = { playInfo: { playerListId: 'playing' }, playMusicInfo: { listId: 'playing' } }
  const globals = { global: { lx: { restorePlayInfo: null } } }
  const manager = load('src/utils/listManage.ts', {
    '@/utils/data': {},
    '@/utils/common': {},
    '@/utils/localMatchIndex': {},
    '@/config/constant': constants,
    '@/store/player/state': { default: player },
    '@/core/player/playQueue': { isPlayQueueFromList: () => false },
  }, globals)
  const lifecycle = load('src/core/localList.ts', {
    '@/config/constant': constants, '@/utils/listManage': manager, '@/utils/localMatchIndex': {}, '@/store/player/state': { default: player },
  }, globals)
  manager.setMusicList(constants.LIST_IDS.LOCAL, Array.from({ length: 5000 }, (_, i) => ({ id: String(i) })))
  manager.setMusicList('idle', [{ id: 'unused' }]); manager.setMusicList('playing', [{ id: 'current' }])
  const info = { list: [{ id: 'query-result' }], key: 'query', page: 1, limit: 20, total: 1 }
  const empty = () => ({ list: [], key: null, page: 0, limit: 20, total: 0 })
  const search = load('src/core/search/cache.ts', {
    '@/store/search/music/state': { default: { listInfos: { tx: info }, maxPages: {} } },
    '@/store/search/songlist/state': { default: { listInfos: {}, maxPages: {} } },
    '@/store/search/singer/state': { default: { listInfo: empty() } },
    '@/store/search/album/state': { default: { listInfo: empty() } },
    '@/utils/data': { saveSearchResultCache: async() => {} },
    './request': { isSearchPending: () => false, onSearchSettled() {} },
  })
  const gate = deferred()
  const state = completed('ready', 'receipt-work', 'content://ready')
  const h = await createHarness({
    active: [{ ...task('ready'), nativeId: 'receipt-work', status: 'run' }],
    receipts: new Map([['receipt-work', state]]),
    catalog: { beforeLocal: async() => lifecycle.withLocalList('headless-archive', async() => gate.promise, false) },
  })
  const caches = load('src/core/cacheLifecycle.ts', {
    'react-native': { AppState: {} },
    '@/utils/nativeModules/utils': {},
    '@/utils/listManage': manager,
    '@/core/songlist': { releaseIdleSonglistCaches() {} },
    '@/store/singer/action': { releaseIdleSingerCaches() {} },
    '@/core/music/utils': { clearOtherSourceCache() {} },
    '@/core/download': h.api,
    '@/core/search/cache': search,
    '@/utils/musicSdk/kg/songList': { clearSongListCache() {} },
  })
  const service = serviceHarness(h.api, runtimeHarness(), { ...caches, ...lifecycle })
  const work = service.runDownloadQueueDispatch({ workId: 'release-caches' })
  const outcome = work.then(() => null, error => error)
  await flush(); await h.run(250)
  const timer = [...service.clock.values()].find(value => value.delay === 75000)
  timer.fn(); await outcome; await flush()
  assert.equal(manager.allMusicList.has(constants.LIST_IDS.LOCAL), true, 'in-flight LOCAL persistence still owns its rows')
  assert.equal(manager.allMusicList.has('idle'), false)
  assert.equal(manager.allMusicList.has('playing'), true)
  assert.equal(info.list.length, 0)
  gate.resolve(); await flush()
  assert.equal(manager.allMusicList.has(constants.LIST_IDS.LOCAL), false)
  assert.equal(h.api.isDownloadCompleted('ready'), true)
  player.playInfo.playerListId = constants.LIST_IDS.LOCAL
  manager.setMusicList(constants.LIST_IDS.LOCAL, [{ id: 'playing-local' }])
  await service.runDownloadQueueDispatch({ workId: 'keep-playing-cache' })
  assert.equal(manager.allMusicList.has(constants.LIST_IDS.LOCAL), true)
})
