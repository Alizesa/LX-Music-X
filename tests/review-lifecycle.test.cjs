const assert = require('node:assert/strict')
const { test } = require('node:test')
const { spawnSync } = require('node:child_process')
const { load, deferred, flush } = require('./helpers/load.cjs')
const { harness: musicHarness } = require('./helpers/music-utils.cjs')
const { hookHost, jsx, elements } = require('./helpers/react.cjs')

for (const kind of ['url', 'lyric', 'pic']) {
  test(`cancelled local ${kind} initialization detaches without waiting for the shared source`, async() => {
    const h = musicHarness()
    const calls = []
    let observers = 0
    const then = h.initialization.promise.then.bind(h.initialization.promise)
    h.initialization.promise.then = (...args) => { observers++; return then(...args) }
    for (let i = 0; i < 64; i++) {
      const song = { id: String(i), source: 'local', meta: {} }
      const controller = new AbortController()
      let cancel
      const promise = kind === 'url'
        ? h.api.getOnlineOtherSourceMusicUrlByLocal(song, false, { onCancel: fn => { cancel = fn } })
        : kind === 'lyric'
          ? h.api.getOnlineOtherSourceLyricByLocal(song, false, controller.signal)
          : h.api.getOnlineOtherSourcePicByLocal(song, controller.signal)
      calls.push(assert.rejects(promise, error => error.message === h.message.requestMsg.cancelRequest))
      if (cancel) cancel()
      else controller.abort()
    }
    await Promise.all(calls)
    assert.equal(observers, 1)
    assert.equal(h.requests.length, 0)
    h.initialization.resolve(true)
    await flush()
    assert.equal(h.requests.length, 0)
  })
}

test('pending source initialization no longer retains cancelled local song objects', () => {
  const result = spawnSync(process.execPath, ['--expose-gc', '-e', `
    const assert = require('node:assert/strict')
    const { harness } = require('./tests/helpers/music-utils.cjs')
    const h = harness()
    const refs = []
    global.keepSource = h
    ;(async() => {
      for (let i = 0; i < 64; i++) {
        let music = { id: String(i), source: 'local', payload: new Array(10000).fill(i), meta: {} }
        refs.push(new WeakRef(music))
        let cancel
        const request = h.api.getOnlineOtherSourceMusicUrlByLocal(music, false, { onCancel: fn => { cancel = fn } }).catch(() => {})
        cancel()
        cancel = music = null
        await request
      }
      for (let i = 0; i < 12; i++) {
        await new Promise(resolve => setImmediate(resolve))
        global.gc()
      }
      assert.equal(refs.filter(ref => ref.deref()).length, 0)
    })().catch(error => { console.error(error); process.exitCode = 1 })
  `], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})

test('lyric conversion preserves original raw text and metadata and converts each display field once', async() => {
  const h = musicHarness()
  h.setting['player.isS2t'] = true
  const raw = { lyric: 'raw', tlyric: 'raw translation', rlyric: 'raw romanization', lxlyric: 'raw timing' }
  const input = { lyric: 'display', tlyric: 'translation', rlyric: 'romanization', lxlyric: 'timing', rawlrcInfo: raw, isEdited: true, qqLyricVersion: 2 }
  const result = await h.api.buildLyricInfo(input)
  assert.equal(h.conversions.length, 4)
  assert.equal(result.rawlrcInfo, raw)
  assert.equal(result.isEdited, true)
  assert.equal(result.qqLyricVersion, 2)
  assert.equal(result.lyric, 'converted:display')
  const withoutRaw = await h.api.buildLyricInfo({ lyric: 'original' })
  assert.equal(withoutRaw.rawlrcInfo.lyric, 'original')
})

test('legacy songs from removed SDKs reject as unsupported without needing a failure-only provider', async() => {
  const h = musicHarness()
  const options = { musicInfo: { id: 'old', source: 'xm', meta: {} }, isRefresh: true, allowToggleSource: false, onToggleSource() {} }
  await assert.rejects(h.api.handleGetOnlinePicUrl(options), /Unsupported music source/)
  await assert.rejects(h.api.handleGetOnlineLyricInfo(options), /Unsupported music source/)
})

const commentHarness = () => {
  const requests = []
  const sdk = { getComment: request, getHotComment: request }
  function request(music, page, limit, signal) {
    const gate = deferred()
    requests.push({ music, page, limit, signal, gate })
    return gate.promise
  }
  const utils = load('src/screens/Comment/utils.ts', {
    '@/utils': { toOldMusicInfo: value => value },
    '@/utils/musicSdk': { default: { tx: { comment: sdk } } },
    '@/utils/message': load('src/utils/message.ts'),
  })
  const api = load('src/screens/Comment/controller.ts', { './utils': utils, '@/utils/message': load('src/utils/message.ts') })
  return { ...api, requests, utils }
}
const response = (prefix, page = 1) => ({ comments: [{ id: prefix + page, reply: [{ id: prefix + '-reply' }] }], total: 1500, maxPage: 100 })

test('a late comment for A cannot replace B after song change or hidden-tab disposal', async() => {
  const h = commentHarness()
  let view
  const a = h.createCommentController({ id: 'A', source: 'tx' }, 'hot', next => { view = next }, () => {})
  const pendingA = a.refresh()
  a.dispose()
  const b = h.createCommentController({ id: 'B', source: 'tx' }, 'new', next => { view = next }, () => {})
  const pendingB = b.refresh()
  h.requests[1].gate.resolve(response('B'))
  await pendingB
  h.requests[0].gate.resolve(response('A'))
  await pendingA
  assert.equal(view.comments[0].id, 'B1')
  assert.equal(h.requests[0].signal.aborted, true)
  b.dispose()
})

test('comment retries stop on disposal and a superseded refresh cannot publish status or rows', async() => {
  const h = commentHarness()
  const changes = []
  const api = h.createCommentController({ id: 'A', source: 'tx' }, 'hot', next => changes.push(next), () => {})
  const old = api.refresh()
  const fresh = api.refresh()
  h.requests[1].gate.resolve(response('fresh'))
  await fresh
  h.requests[0].gate.reject(new Error('late failure'))
  await old
  assert.equal(changes.at(-1).comments[0].id, 'fresh1')
  const hidden = api.refresh()
  api.dispose()
  h.requests[2].gate.reject(new Error('failed while hidden'))
  await hidden
  assert.equal(h.requests.length, 3)
})

test('comment page retention is bounded and evicted earlier pages remain accessible', async() => {
  const h = commentHarness()
  let view
  const api = h.createCommentController({ id: 'A', source: 'tx' }, 'hot', next => { view = next }, () => {})
  for (let page = 1; page <= 12; page++) {
    const request = page === 1 ? api.refresh() : api.next()
    h.requests.at(-1).gate.resolve(response('page', page))
    await request
    assert.ok(view.comments.length <= h.MAX_COMMENT_PAGES)
  }
  assert.equal(view.hasPrevious, true)
  assert.equal(view.comments[0].id, 'page8')
  const previous = api.previous()
  assert.equal(h.requests.at(-1).page, 7)
  h.requests.at(-1).gate.resolve(response('page', 7))
  await previous
  assert.equal(view.comments[0].id, 'page7')
  assert.equal(view.comments.length, 5)
  api.dispose()
})

test('comment images do not request or measure an image before click and decode within fixed bounds', () => {
  const host = hookHost(); const frame = host.frame()
  const Image = load('src/screens/Comment/components/CommentImage.tsx', {
    react: host.react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { TouchableOpacity: 'Press', View: 'View' },
    '@/components/common/Image': { default: 'Image', getSize() { assert.fail('Original image decoded before click') } },
    '@/utils/tools': { createStyle: value => value },
    '@/components/common/Text': { default: 'Text' },
    '@/utils/pixelRatio': { scaleSizeH: value => value },
    '@/theme': { BorderWidths: { normal: 1 } },
    '@/store/theme/hook': { useTheme: () => ({}) },
  }, { global: { i18n: { t: key => key } } }).default
  const render = (url = 'huge-image') => host.render(frame, () => Image({ url, maxWidth: 600 }))
  let tree = render()
  assert.equal(elements(tree, 'Image').length, 0)
  elements(tree, 'Press')[0].props.onPress()
  tree = render()
  const props = elements(tree, 'Image')[0].props
  assert.equal(props.resizeMethod, 'resize')
  assert.ok(props.style.width <= 260 && props.style.height <= 260)
  assert.equal(elements(render('another-image'), 'Image').length, 0)
  host.unmount(frame)
})

test('search suggestions coalesce input and cancel pending timers and late responses on hide and unmount', async() => {
  const host = hookHost(); const frame = host.frame(); const ref = { current: null }
  const timers = new Map(); const requests = []; let nextTimer = 0
  const state = { temp_source: 'kw', tipListInfo: { text: '', source: 'kw', list: [] } }
  const TipList = load('src/screens/Home/Views/Search/TipList.tsx', {
    react: host.react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '@/components/SearchTipList': { default: 'Tips' },
    '@/components/common/Button': { default: 'Button' },
    '@/components/common/Text': { default: 'Text' },
    '@/utils/tools': { createStyle: value => value },
    '@/utils/pixelRatio': { scaleSizeH: value => value },
    '@/utils/musicSdk': {
      default: {
        kw: {
          tipSearch: {
            search: (text, signal) => {
              const gate = deferred(); requests.push({ text, signal, gate }); return gate.promise
            },
          },
        },
      },
    },
    '@/store/search/state': { default: state },
    '@/core/search/search': {
      setSearchText: text => { state.text = text },
      setTipListInfo: (text, source) => { Object.assign(state.tipListInfo, { text, source }) },
      setTipList: list => { state.tipListInfo.list = list },
    },
  }, {
    setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer },
    clearTimeout: id => timers.delete(id),
  }).default
  frame.connect = tree => { if (tree) tree.props.ref.current = { setList() {}, setHeight() {} } }
  const render = () => host.render(frame, () => TipList({ onSearch() {} }, ref))
  render()
  ref.current.search('a', 400)
  ref.current.search('ab', 400)
  render()
  assert.equal(timers.size, 1)
  ref.current.hide()
  render()
  assert.equal(timers.size, 0)
  assert.equal(requests.length, 0)
  ref.current.search('fresh', 400)
  render()
  const timer = [...timers.values()][0]; timers.clear(); timer()
  assert.equal(requests.length, 1)
  ref.current.hide()
  render()
  assert.equal(requests[0].signal.aborted, true)
  requests[0].gate.resolve(['late'])
  await flush()
  assert.equal(state.tipListInfo.list.length, 0)
  ref.current.search('unmount', 400)
  host.unmount(frame)
  assert.equal(timers.size, 0)
})

const errorLogHarness = () => {
  const values = new Map(); const timers = new Map(); let id = 0
  const files = {
    temporaryDirectoryPath: '/cache',
    existsFile: async path => values.has(path),
    stat: async path => ({ size: Buffer.byteLength(values.get(path) ?? '') }),
    readFile: async path => values.get(path) ?? '',
    writeFile: async(path, value) => { values.set(path, value) },
    appendFile: async(path, value) => { values.set(path, (values.get(path) ?? '') + value) },
    moveFile: async(from, to) => { values.set(to, values.get(from)); values.delete(from) },
    unlink: async path => { values.delete(path) },
  }
  const clock = { setTimeout: fn => { timers.set(++id, fn); return id }, clearTimeout: id => timers.delete(id) }
  // Mutable forwarding functions let the real writer encounter slow/failing native I/O.
  const forwarding = Object.fromEntries(Object.entries(files).map(([key, fn]) => [key, typeof fn === 'function' ? (...args) => files[key](...args) : fn]))
  const api = load('src/utils/log.ts', {
    '@/utils/fs': forwarding,
    'react-native-background-timer': { default: clock },
    './debugLogWriter': load('src/utils/debugLogWriter.ts'),
  })
  return { api, files, values, timers }
}

test('the legacy error logger bounds retained messages after initialization fails', async() => {
  const h = errorLogHarness()
  const exists = h.files.existsFile
  h.files.existsFile = async() => { throw new Error('unavailable') }
  h.api.log.error('initial')
  await h.api.init()
  for (let i = 0; i < 1000; i++) h.api.log.error(`message-${i} ` + 'x'.repeat(1024))
  assert.equal(h.timers.size, 1)
  h.files.existsFile = exists
  const result = await h.api.getLogs()
  assert.ok(Buffer.byteLength(result) < 66 * 1024)
  assert.ok(result.includes('message-999'))
  assert.ok(!result.includes('message-0 '))
  assert.ok(result.includes('log.dropped'))
})

test('slow error logging batches appends and serializes clear with writes', async() => {
  const h = errorLogHarness(); const gate = deferred()
  let active = 0; let peak = 0; let calls = 0
  const append = h.files.appendFile
  h.files.appendFile = async(...args) => {
    calls++; active++; peak = Math.max(peak, active)
    try { await gate.promise; await append(...args) } finally { active-- }
  }
  h.api.log.error('first')
  const writing = h.api.init()
  await flush()
  for (let i = 0; i < 1000; i++) h.api.log.error(`queued ${i}`)
  assert.equal(calls, 1)
  gate.resolve()
  await writing
  const logs = await h.api.getLogs()
  assert.ok(logs.includes('queued 999'))
  assert.equal(peak, 1)
  assert.ok(calls <= 3)
  const clearing = h.api.clearLogs()
  h.api.log.error('after clear')
  await clearing
  assert.ok((await h.api.getLogs()).includes('after clear'))
})

test('QQ playlist index touching does not retain the returned song array', () => {
  const result = spawnSync(process.execPath, ['--expose-gc', '-e', `
    const assert = require('node:assert/strict')
    const { load, deferred } = require('./tests/helpers/load.cjs')
    const gate = deferred()
    let songs = Array.from({ length: 10000 }, (_, id) => ({ id }))
    const api = load('src/core/qqMusicPlaylistSongsCache.ts', { '@/utils/data': {
      getQQMusicPlaylistSongsCache: async() => ({}),
      removeQQMusicPlaylistSongsCache: async() => {},
      getQQMusicPlaylistSongsIndex: async() => ({ a: { savedAt: 1, count: 10000 } }),
      getQQMusicPlaylistSongsItem: async() => ({ savedAt: 1, songs }),
      getQQMusicPlaylistSongsItemKeys: async() => ['item_a'],
      getQQMusicPlaylistSongsItemKey: id => 'item_' + id,
      getQQMusicPlaylistSongsItemPrefix: () => 'item_',
      saveQQMusicPlaylistSongsIndex: async() => gate.promise,
    } })
    global.keepCache = { api, gate }
    ;(async() => {
      let returned = await api.getCachedPlaylistSongs('a')
      const ref = new WeakRef(returned)
      songs = returned = null
      for (let i = 0; i < 12; i++) { await new Promise(resolve => setImmediate(resolve)); global.gc() }
      assert.equal(ref.deref(), undefined)
      gate.resolve()
    })().catch(error => { console.error(error); process.exitCode = 1 })
  `], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})

test('slow detail storage has a total pending snapshot budget across different keys', () => {
  const result = spawnSync(process.execPath, ['--expose-gc', '-e', `
    const assert = require('node:assert/strict')
    const { load, deferred, flush } = require('./tests/helpers/load.cjs')
    const gate = deferred()
    const refs = []
    const api = load('src/core/detailCache.ts', { '@/utils/data': {
      getBrowseDetailCacheIndex: async() => ({}),
      saveBrowseDetailCache: async() => gate.promise,
      saveBrowseDetailCacheIndex: async() => {},
      removeBrowseDetailCaches: async() => {},
      getBrowseDetailCache: async() => null,
    } })
    global.keepCache = api
    ;(async() => {
      api.saveDetailCache('blocking', {})
      await flush()
      for (let i = 0; i < 64; i++) {
        let snapshot = { list: Array.from({ length: 100 }, (_, id) => ({ id, text: 'x'.repeat(1000) })) }
        refs.push(new WeakRef(snapshot))
        api.saveDetailCache('key' + i, snapshot)
        snapshot = null
      }
      for (let i = 0; i < 12; i++) { await new Promise(resolve => setImmediate(resolve)); global.gc() }
      const retained = refs.filter(ref => ref.deref()).length
      assert.ok(retained > 0 && retained <= 7, 'retained snapshots: ' + retained)
      gate.resolve()
      await api.getDetailCache('key63')
    })().catch(error => { console.error(error); process.exitCode = 1 })
  `], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
