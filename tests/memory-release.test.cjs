const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const { EventEmitter } = require('node:events')
const ts = require('typescript')

const compiled = new Map()
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value))
const flush = async() => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)) }
const deferred = () => {
  let resolve, reject
  const promise = new Promise((_resolve, _reject) => { resolve = _resolve; reject = _reject })
  return { promise, resolve, reject }
}
const timers = () => {
  let next = 0
  const tasks = new Map()
  return {
    setTimeout(fn, delay) { const id = ++next; tasks.set(id, { fn, delay }); return id },
    clearTimeout(id) { tasks.delete(id) },
    async run(delay) {
      for (const [id, task] of [...tasks]) if (task.delay === delay) { tasks.delete(id); task.fn() }
      await flush()
    },
    tasks,
  }
}
const jsx = (type, props) => ({ type, props })
const load = (file, mocks = {}, globals = {}) => {
  if (!compiled.has(file)) {
    compiled.set(file, ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
    }).outputText)
  }
  const context = {
    exports: {},
    AbortController,
    Buffer,
    setTimeout,
    clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    require: name => {
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' }
      assert.ok(Object.hasOwn(mocks, name), `Unexpected import: ${file}: ${name}`)
      return mocks[name]
    },
    ...globals,
  }
  vm.runInNewContext(compiled.get(file), context, { filename: file })
  return context.exports
}

// Run the real components with controlled effects, visibility and native refs.
const hookHost = () => {
  let current
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const react = {
    memo: fn => fn,
    forwardRef: fn => fn,
    useState(initial) {
      const frame = current; const index = frame.cursor++
      if (!frame.slots[index]) {
        const slot = { value: typeof initial === 'function' ? initial() : initial }
        slot.set = next => {
          next = typeof next === 'function' ? next(slot.value) : next
          if (!Object.is(next, slot.value)) { slot.value = next; frame.dirty = true }
        }
        frame.slots[index] = slot
      }
      const slot = frame.slots[index]
      return [slot.value, slot.set]
    },
    useRef(initial) {
      const frame = current; const index = frame.cursor++
      return frame.slots[index] ??= { current: initial }
    },
    useMemo(fn, deps) {
      const frame = current; const index = frame.cursor++; const old = frame.slots[index]
      if (!old || !same(old.deps, deps)) frame.slots[index] = { value: fn(), deps }
      return frame.slots[index].value
    },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps) },
    useEffect(effect, deps) {
      const frame = current; const index = frame.cursor++; const old = frame.slots[index]
      if (old && same(old.deps, deps)) return
      const slot = { deps }
      frame.slots[index] = slot
      frame.effects.push(() => { old?.cleanup?.(); slot.cleanup = effect() })
    },
    useImperativeHandle(ref, factory, deps) {
      react.useEffect(() => {
        if (!ref) return
        ref.current = factory()
        return () => { ref.current = null }
      }, deps)
    },
  }
  return {
    react,
    visible: () => current.visible,
    frame: () => ({ visible: true, slots: [], connect() {} }),
    render(frame, component) {
      for (let attempt = 0; attempt < 20; attempt++) {
        current = frame
        frame.cursor = 0
        frame.effects = []
        frame.dirty = false
        const tree = component()
        current = null
        frame.connect(tree)
        frame.effects.forEach(effect => effect())
        if (!frame.dirty) return tree
      }
      throw new Error('Render did not settle')
    },
    unmount(frame) { frame.slots.forEach(slot => slot?.cleanup?.()); frame.slots = [] },
  }
}
const elements = (tree, type) => {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(child => elements(child, type))
  return [...(tree.type === type ? [tree] : []), ...elements(tree.props?.children, type)]
}
const modal = (frame, type) => {
  const widget = {
    visible: false,
    props: null,
    setVisible(value) {
      if (value === this.visible) return
      this.visible = value
      if (!value) this.props?.onHide?.()
    },
  }
  frame.connect = tree => {
    const node = elements(tree, type)[0]
    if (node) { widget.props = node.props; node.props.ref.current = widget }
  }
  return widget
}
const constants = load('src/config/constant.ts')
const song = id => ({ id: String(id), name: `Song ${id}`, singer: 'Artist', source: 'tx', interval: '03:00', meta: { albumName: 'Album' } })
const style = { createStyle: value => value, toast() {} }
const theme = { useTheme: () => ({}) }
const frames = clock => ({ requestAnimationFrame: fn => clock.setTimeout(fn, 'frame'), cancelAnimationFrame: clock.clearTimeout })

const localHarness = read => {
  const clock = timers()
  const player = { playInfo: { playerListId: null }, playMusicInfo: { listId: null } }
  const globals = { ...clock, global: { lx: { restorePlayInfo: null } } }
  const manager = load('src/utils/listManage.ts', {
    '@/utils/data': { getListMusics: read },
    '@/utils/common': {},
    '@/utils/localMatchIndex': { syncLocalMatchIndexWithList: async() => {} },
    '@/config/constant': constants,
    '@/store/player/state': { default: player },
    '@/core/player/playQueue': { isPlayQueueFromList: () => false },
  }, globals)
  const lifecycle = load('src/core/localList.ts', {
    '@/config/constant': constants,
    '@/utils/listManage': manager,
    '@/utils/localMatchIndex': {},
    '@/store/player/state': { default: player },
  }, globals)
  return { clock, manager, lifecycle }
}

test('a local list finishing after the close deadline is released without another queue event', async() => {
  const gate = deferred(); const h = localHarness(() => gate.promise)
  const loading = h.lifecycle.retainLocalList('screen')
  h.lifecycle.releaseLocalList('screen')
  await h.clock.run(3000)
  gate.resolve(Array.from({ length: 5000 }, (_, i) => song(i)))
  await loading
  await h.clock.run(3000)
  assert.equal(h.manager.allMusicList.has(constants.LIST_IDS.LOCAL), false)
})

test('a late failed lease cannot release a new consumer with the same reason', async() => {
  const gate = deferred(); const h = localHarness(() => gate.promise)
  const loading = h.lifecycle.retainLocalList('screen')
  h.lifecycle.releaseLocalList('screen')
  await h.lifecycle.retainLocalList('screen', false)
  h.manager.allMusicList.set(constants.LIST_IDS.LOCAL, [song(1)])
  gate.reject(new Error('read failed'))
  await assert.rejects(loading, /read failed/)
  await h.clock.run(3000)
  assert.equal(h.manager.allMusicList.has(constants.LIST_IDS.LOCAL), true)
  h.lifecycle.releaseLocalList('screen')
  await h.clock.run(3000)
  assert.equal(h.manager.allMusicList.has(constants.LIST_IDS.LOCAL), false)
})

test('closed playlist panels hold no queue snapshots or listeners and reopen with fresh data', async() => {
  const h = hookHost(); const clock = timers(); const app = new EventEmitter(); const state = new EventEmitter()
  let queue = Array.from({ length: 3000 }, (_, i) => ({ queueId: `q${i}`, musicInfo: song(i) }))
  const player = { tempPlayList: [], playInfo: { playerPlayIndex: 0 }, playMusicInfo: { musicInfo: null } }
  const Panel = load('src/components/player/PlayerPlaylist.tsx', {
    react: h.react,
    'react-native': { Dimensions: { get: () => ({ height: 800 }) }, StyleSheet: { create: value => value }, Animated: {} },
    '@/components/common/Popup': { default: 'Popup' },
    '@/components/common/Text': { default: 'Text' },
    '@/components/common/Icon': { Icon: 'Icon' },
    '@/store/theme/hook': theme,
    '@/store/player/hook': { usePlayInfo: () => player.playInfo, usePlayMusicInfo: () => player.playMusicInfo },
    '@/store/player/state': { default: player },
    '@/core/player/player': {},
    '@/core/player/tempPlayList': {},
    '@/core/player/playQueue': { getPlayQueue: () => queue },
    '@/config/constant': constants,
    '@/utils/pixelRatio': { scaleSizeH: value => value },
    '@/utils/tools': style,
    '@/utils/hooks': { useTabletLayout: () => ({ isWide: false, height: 800 }) },
    '@/utils/layout': {},
    '@/utils/hooks/useScreenVisible': { useScreenVisible: h.visible },
  }, { ...frames(clock), global: { app_event: app, state_event: state, lx: { fontSize: 1 }, i18n: { t: value => value } } }).default
  const panels = Array.from({ length: 3 }, () => {
    const frame = h.frame(); const ref = { current: null }; const popup = modal(frame, 'Popup')
    return { frame, ref, popup, render: () => h.render(frame, () => Panel({}, ref)) }
  })
  panels.forEach(panel => assert.equal(panel.render(), null))
  assert.equal(app.listenerCount('playQueueUpdate'), 0)
  assert.equal(state.listenerCount('playTempPlayListChanged'), 0)
  const panel = panels[0]
  panel.ref.current.show()
  panel.render()
  await clock.run('frame')
  assert.equal(app.listenerCount('playQueueUpdate'), 1)
  assert.ok(panel.frame.slots.some(slot => Array.isArray(slot.value) && slot.value.length === 3000))
  panel.popup.setVisible(false)
  assert.equal(panel.render(), null)
  assert.equal(app.listenerCount('playQueueUpdate'), 0)
  assert.ok(panel.frame.slots.every(slot => !Array.isArray(slot.value) || slot.value.length === 0))
  queue = [{ queueId: 'new', musicInfo: song('new') }]
  app.emit('playQueueUpdate', queue)
  panel.ref.current.show()
  panel.render()
  assert.ok(panel.frame.slots.some(slot => Array.isArray(slot.value) && slot.value[0]?.queueId === 'new'))
  panel.frame.visible = false
  assert.equal(panel.render(), null)
  assert.equal(app.listenerCount('playQueueUpdate'), 0)
  await clock.run('frame')
  assert.equal(panel.popup.visible, false)
  panels.forEach(panel => h.unmount(panel.frame))
})

const chooserHarness = read => {
  const h = hookHost(); const frame = h.frame(); const ref = { current: null }; const popup = modal(frame, 'Modal')
  const Component = load('src/components/common/ChoosePath/List.tsx', {
    react: h.react,
    'react-native': { View: 'View' },
    '@/utils/fs': { externalStorageDirectoryPath: '/music', readDir: read },
    '@/utils/tools': style,
    '@/components/common/Modal': { default: 'Modal' },
    './components/Header': { default: 'Header' },
    './components/Main': { default: 'Main' },
    './components/Footer': { default: 'Footer' },
    '@/utils': { sizeFormate: () => '' },
    '@/store/theme/hook': theme,
  }).default
  return { h, frame, ref, popup, render: () => h.render(frame, () => Component({ onConfirm() {} }, ref)) }
}
const files = count => Array.from({ length: count }, (_, i) => ({ name: `file${i}`, path: `/music/file${i}`, isFile: true, isDirectory: false, lastModified: 0, size: 100 }))

test('file chooser explicit close and Android back both release rows and directory caches', async() => {
  let reads = 0
  const h = chooserHarness(async() => { reads++; return files(5000) })
  h.render()
  for (const close of [() => h.ref.current.hide(), () => h.popup.setVisible(false)]) {
    h.ref.current.show('Files', '/music')
    await flush()
    assert.equal(elements(h.render(), 'Main')[0].props.list.length, 5000)
    close()
    assert.equal(elements(h.render(), 'Main')[0].props.list.length, 0)
  }
  assert.equal(reads, 2)
  h.h.unmount(h.frame)
})

test('a directory read finishing after close cannot refill caches or overwrite a reopened chooser', async() => {
  const old = deferred()
  let reads = 0
  const h = chooserHarness(async() => ++reads === 1 ? old.promise : files(2))
  h.render()
  h.ref.current.show('Files', '/music')
  h.ref.current.hide()
  h.render()
  old.resolve(files(5000))
  await flush()
  assert.equal(elements(h.render(), 'Main')[0].props.list.length, 0)
  h.ref.current.show('Files', '/music')
  await flush()
  assert.equal(elements(h.render(), 'Main')[0].props.list.length, 2)
  assert.equal(reads, 2)
  h.h.unmount(h.frame)
})

const sdkHarness = () => {
  let requests = 0; let count = 1000; let gate = null
  const exports = load('src/utils/musicSdk/kg/songList.js', {
    '../../request': {
      httpFetch: url => {
        requests++
        const body = url.includes('.html')
          ? `var dataFromSmarty = ${JSON.stringify(Array.from({ length: count }, (_, i) => ({ hash: `hash${i}` })))}`
          : 'var phpParam = {"specialname":"Fixture"};'
        return { promise: gate ? gate.promise : Promise.resolve({ body }) }
      },
    },
    '../../index': {},
    './vendors/infSign.min': {},
    './util': {},
  })
  const sdk = exports.default
  sdk.getMusicInfos = async raw => raw.map(item => ({ id: item.hash, normalized: true }))
  return { sdk, exports, requests: () => requests, setCount: value => { count = value }, setGate: value => { gate = value } }
}

test('Kugou shares cache normalized songs under a separate key and respect the song budget', async() => {
  const h = sdkHarness()
  const info = await h.sdk.getListInfoByChain('a')
  const songs = await h.sdk.getUserListDetailByPcChain('a')
  assert.strictEqual(await h.sdk.getUserListDetailByPcChain('a'), songs)
  assert.strictEqual(await h.sdk.getListInfoByChain('a'), info)
  assert.equal(h.requests(), 2)
  assert.equal(songs[0].normalized, true)
  for (let i = 0; i < 20; i++) await h.sdk.getUserListDetailByPcChain(String(i))
  assert.ok(h.sdk.cache.size <= 16)
  assert.ok([...h.sdk.cache.values()].reduce((total, value) => total + (Array.isArray(value) ? value.length : 0), 0) <= 3000)
  h.setCount(4000)
  await h.sdk.getUserListDetailByPcChain('oversize')
  assert.equal(h.sdk.cache.has('oversize_pc_list'), false)
})

test('clearing SDK caches cannot be undone by an earlier in-flight response', async() => {
  const h = sdkHarness(); const gate = deferred()
  h.setGate(gate)
  const loading = h.sdk.getUserListDetailByPcChain('a')
  h.exports.clearSongListCache()
  gate.resolve({ body: 'var dataFromSmarty = [{"hash":"a"}]' })
  assert.equal((await loading).length, 1)
  assert.equal(h.sdk.cache.size, 0)
})

const detailCacheHarness = (globals = {}) => {
  const records = new Map()
  let index = {}
  const data = {
    getBrowseDetailCache: async key => copy(records.get(key)) ?? null,
    saveBrowseDetailCache: async(key, value) => { records.set(key, copy(value)) },
    getBrowseDetailCacheIndex: async() => copy(index),
    saveBrowseDetailCacheIndex: async value => { index = copy(value) },
    removeBrowseDetailCaches: async keys => { keys.forEach(key => records.delete(key)) },
  }
  const api = load('src/core/detailCache.ts', { '@/utils/data': data }, globals)
  return { api, data, records }
}
const singerHarness = () => {
  const cache = detailCacheHarness(); const clock = timers()
  const state = load('src/store/singer/state.ts')
  const actions = load('src/store/singer/action.ts', {
    './state': state, '@/utils': { toNewMusicInfo: value => value, deduplicationList: value => [...new Map(value.map(item => [item.id, item])).values()] },
  }, clock)
  const requests = []
  const page = number => ({ list: [song(number)], total: 3, allPage: 3, limit: 1, source: 'tx' })
  const sdk = {
    tx: {
      singer: {
        getDetail: async mid => { requests.push('detail'); return { info: { ...state.createSingerRecord(mid).info }, songs: page(1) } },
        getSongs: async(mid, number) => { requests.push('songs'); return page(number) },
        getAlbums: async(mid, number) => { requests.push('albums'); return { ...page(number), list: [{ id: 'a', mid: 'a' }] } },
      },
      album: { getSongs: async(mid, number) => { requests.push('albumSongs'); return page(number) } },
    },
  }
  const api = load('src/core/singer.ts', {
    '@/store/singer/state': state,
    '@/store/singer/action': actions,
    '@/utils/musicSdk': { default: sdk },
    './detailCache': cache.api,
  })
  return { cache, state: state.default, actions, api, sdk, requests, clock }
}

test('hidden singer and album records are released and restore all loaded pages without HTTP', async() => {
  const h = singerHarness()
  h.actions.retainSingerRecord('s')
  await h.api.getSingerDetail('s')
  await h.api.getSingerSongs('s', 2)
  await h.api.getSingerAlbums('s', 1)
  h.actions.releaseSingerRecord('s')
  assert.equal(h.state.singers.s, undefined)
  h.actions.retainSingerRecord('s')
  const restored = await h.api.getSingerDetail('s')
  assert.equal(restored.songs.page, 2)
  assert.equal(restored.songs.list.length, 2)
  assert.equal((await h.api.getSingerAlbums('s', 1)).list.length, 1)
  assert.equal(h.requests.length, 3)
  h.actions.retainAlbumRecord('a')
  await h.api.getAlbumSongs('a', 1)
  await h.api.getAlbumSongs('a', 2)
  h.actions.releaseAlbumRecord('a')
  assert.equal(h.state.albumSongs.a, undefined)
  h.actions.retainAlbumRecord('a')
  assert.equal((await h.api.getAlbumSongs('a', 1)).page, 2)
  assert.equal(h.requests.length, 5)
})

test('late detail responses do not resurrect released records or overwrite newly opened records', async() => {
  const h = singerHarness(); const gate = deferred()
  h.actions.retainAlbumRecord('a')
  h.sdk.tx.album.getSongs = () => gate.promise
  const loading = h.api.getAlbumSongs('a', 1)
  await flush()
  h.actions.releaseAlbumRecord('a')
  gate.resolve({ list: [song('old')], total: 1, allPage: 1, limit: 1, source: 'tx' })
  await loading
  assert.equal(h.state.albumSongs.a, undefined)
  assert.equal(h.cache.records.has('album_a'), false)
})

test('a shared visible singer keeps its record until the last screen releases it', async() => {
  const h = singerHarness()
  h.actions.retainSingerRecord('s')
  h.actions.retainSingerRecord('s')
  const record = await h.api.getSingerDetail('s')
  h.actions.releaseSingerRecord('s')
  h.actions.releaseIdleSingerCaches()
  assert.strictEqual(h.state.singers.s, record)
  h.actions.releaseSingerRecord('s')
  assert.equal(h.state.singers.s, undefined)
})

test('detail snapshots coalesce pending writes, limit disk entries and recover after write failures', async() => {
  const h = detailCacheHarness({ Date: { now: () => 1000 } })
  h.api.saveDetailCache('same', { page: 1 })
  h.api.saveDetailCache('same', { page: 2 })
  assert.equal((await h.api.getDetailCache('same')).page, 2)
  const write = h.data.saveBrowseDetailCache
  h.data.saveBrowseDetailCache = async() => { throw new Error('disk full') }
  h.api.saveDetailCache('failed', {})
  assert.equal(await h.api.getDetailCache('failed'), null)
  h.data.saveBrowseDetailCache = write
  for (let i = 0; i < 40; i++) h.api.saveDetailCache(`key${i}`, { value: i })
  assert.equal((await h.api.getDetailCache('key39')).value, 39)
  assert.equal(h.records.size, 32)
})

const t = value => value
const lang = { useI18n: () => t }

test('a failed detail index write removes its orphan snapshot and later writes still succeed', async() => {
  const h = detailCacheHarness()
  const saveIndex = h.data.saveBrowseDetailCacheIndex
  h.data.saveBrowseDetailCacheIndex = async() => { throw new Error('index unavailable') }
  h.api.saveDetailCache('orphan', { page: 1 })
  assert.equal(await h.api.getDetailCache('orphan'), null)
  assert.equal(h.records.has('orphan'), false)
  h.data.saveBrowseDetailCacheIndex = saveIndex
  h.api.saveDetailCache('next', { page: 2 })
  assert.equal((await h.api.getDetailCache('next')).page, 2)
})

test('releasable online lists discard rows and selections, reject hidden writes, and preserve opt-out lists', () => {
  for (const releaseOnHide of [true, false]) {
    const h = hookHost(); const frame = h.frame(); const ref = { current: null }; const clock = timers()
    const scroll = load('src/utils/hooks/useListScrollRestore.ts', { react: h.react }, frames(clock))
    const List = load('src/components/OnlineList/List.tsx', {
      react: h.react,
      'react-native': { FlatList: 'FlatList', View: 'View', RefreshControl: 'RefreshControl' },
      './ListItem': { default: 'ListItem', ITEM_HEIGHT: 50 },
      '@/utils/tools': { ...style, getRowInfo: () => ({ rowNum: 1 }) },
      '@/store/theme/hook': theme,
      '@/store/setting/state': { default: { setting: {} } },
      './MultipleModeBar': { MULTI_SELECT_BAR_HEIGHT: 40 },
      '@/lang': lang,
      '@/components/common/Text': { default: 'Text' },
      './listAction': {},
      '@/store/setting/hook': { useSettingValue: () => false },
      '@/utils/hooks/useScreenVisible': { useScreenVisible: h.visible },
      '@/utils/hooks/useListScrollRestore': scroll,
    }, frames(clock)).default
    const props = { releaseOnHide, onRefresh() {}, onLoadMore() {}, onSelectAll() {} }
    const render = () => h.render(frame, () => List(props, ref))
    render()
    ref.current.setList(Array.from({ length: 5000 }, (_, i) => song(i)), false, false)
    render()
    ref.current.selectAll(true)
    frame.visible = false
    assert.equal(render().props.data.length, releaseOnHide ? 0 : 5000)
    assert.equal(ref.current.getSelectedList().length, releaseOnHide ? 0 : 5000)
    if (releaseOnHide) {
      ref.current.setList([song('late')], false, false)
      assert.equal(render().props.data.length, 0)
      frame.visible = true
      render()
      ref.current.setList([song('fresh')], false, false)
      assert.equal(render().props.data[0].id, 'fresh')
    }
    h.unmount(frame)
  }
})

test('scroll restoration survives the temporary empty list and user scrolling takes over afterward', async() => {
  const h = hookHost(); const frame = h.frame(); const clock = timers(); const scrolls = []
  const ref = { current: { scrollToOffset: value => scrolls.push(value.offset) } }
  const api = load('src/utils/hooks/useListScrollRestore.ts', { react: h.react }, frames(clock))
  let ready = true
  const render = () => h.render(frame, () => api.useListScrollRestore(ref, frame.visible, ready))
  let view = render()
  view.onLayout({ nativeEvent: { layout: { height: 600 } } })
  view.onContentSizeChange(300, 5000)
  view.onScrollBeginDrag({ nativeEvent: { contentOffset: { y: 1800 } } })
  frame.visible = false
  ready = false
  render()
  frame.visible = true
  view = render()
  view.onContentSizeChange(300, 200)
  view.onScroll({ nativeEvent: { contentOffset: { y: 0 } } })
  await clock.run('frame')
  assert.equal(scrolls.length, 0)
  ready = true
  view = render()
  await clock.run('frame')
  assert.equal(scrolls.length, 0)
  view.onContentSizeChange(300, 700)
  view.onScroll({ nativeEvent: { contentOffset: { y: 100 } } })
  view.onContentSizeChange(300, 5000)
  assert.equal(scrolls.at(-1), 1800)
  view.onScroll({ nativeEvent: { contentOffset: { y: 1800 } } })
  view.onScrollBeginDrag({ nativeEvent: { contentOffset: { y: 2300 } } })
  const previous = scrolls.length
  view.onContentSizeChange(300, 6000)
  assert.equal(scrolls.length, previous)
  h.unmount(frame)
})

test('the local songs screen releases its UI and lease in the background and reloads from disk', async() => {
  let reads = 0
  const core = localHarness(async() => { reads++; return Array.from({ length: 5000 }, (_, i) => song(i)) })
  const h = hookHost(); const frame = h.frame(); const clock = timers()
  const scroll = load('src/utils/hooks/useListScrollRestore.ts', { react: h.react }, frames(clock))
  const Component = load('src/screens/LocalSongs/index.tsx', {
    react: h.react,
    'react-native': { FlatList: 'FlatList', View: 'View' },
    '@/components/PageContent': { default: 'PageContent' },
    '@/components/common/StatusBar': {},
    '@/components/SimpleHeader': {},
    '@/components/player/PlayerBar': {},
    '@/components/common/Text': {},
    '@/components/common/Image': {},
    '@/core/common': { setComponentId() {} },
    '@/config/constant': constants,
    '@/core/list': { getListMusics: core.manager.getListMusics },
    '@/core/localList': core.lifecycle,
    '@/core/player/tempPlayList': {},
    '@/utils/localMediaMetadata': {},
    '@/utils/fs': {},
    '@/utils/music': {},
    '@/store/setting/state': { default: { setting: {} } },
    '@/store/theme/hook': theme,
    '@/lang': lang,
    '@/utils/tools': style,
    '@/utils/hooks/useScreenVisible': { useScreenVisible: h.visible },
    '@/utils/hooks/useListScrollRestore': scroll,
  }, frames(clock)).default
  const render = () => h.render(frame, () => Component({ componentId: 'local' }))
  render()
  await flush()
  assert.equal(elements(render(), 'FlatList')[0].props.data.length, 5000)
  frame.visible = false
  assert.equal(elements(render(), 'FlatList')[0].props.data.length, 0)
  await core.clock.run(3000)
  assert.equal(core.manager.allMusicList.has(constants.LIST_IDS.LOCAL), false)
  frame.visible = true
  render()
  await flush()
  assert.equal(elements(render(), 'FlatList')[0].props.data.length, 5000)
  assert.equal(reads, 2)
  h.unmount(frame)
})

test('songlist responses and scheduled frames cannot write back after unmount', async() => {
  const state = load('src/store/songlist/state.ts')
  const actions = load('src/store/songlist/action.ts', { './state': state })
  const gate = deferred(); const clock = timers()
  const core = load('src/core/songlist.ts', {
    '@/store/songlist/action': actions,
    '@/utils': { toNewMusicInfo: value => value, deduplicationList: value => value },
    '@/utils/musicSdk': { default: { kw: { songList: { getListDetail: () => gate.promise } } } },
  })
  const h = hookHost(); const frame = h.frame(); const ref = { current: null }
  const Component = load('src/screens/SonglistDetail/MusicList.tsx', {
    react: h.react,
    '@/components/OnlineList': { default: 'OnlineList' },
    '@/core/songlist': core,
    '@/store/songlist/state': state,
    './listAction': {},
    './Header': {},
    './state': { useListInfo: () => ({ id: 'fixture', source: 'kw' }) },
  }, frames(clock)).default
  h.render(frame, () => Component({ componentId: 'fixture' }, ref))
  const loading = ref.current.loadList('kw', 'fixture')
  await flush()
  h.unmount(frame)
  core.clearListDetail()
  gate.resolve({ source: 'kw', list: Array.from({ length: 30 }, (_, i) => song(i)), total: 30, limit: 30, info: {} })
  await loading
  await clock.run('frame')
  assert.equal(state.default.listDetailInfo.list.length, 0)
  assert.equal(state.default.listDetailInfo.id, '')
})

test('closing a song menu releases a full selection and ignores a late playlist picker', async() => {
  const h = hookHost(); const frame = h.frame(); const ref = { current: null }; const popup = modal(frame, 'Popup'); const gate = deferred()
  const Component = load('src/components/OnlineList/ListMenu.tsx', {
    react: h.react,
    'react-native': { ScrollView: 'ScrollView', View: 'View' },
    '@/lang': lang,
    '@/components/common/Popup': { default: 'Popup' },
    '@/components/common/Text': {},
    '@/components/common/Image': {},
    '@/components/common/Icon': {},
    '@/components/common/AddToPlaylistIcon': {},
    '@/components/common/LikedHeart': {},
    '@/components/common/MenuRow': { default: 'MenuRow' },
    '@/store/theme/hook': theme,
    '@/core/dislikeList': { hasDislike: () => false },
    '@/utils/data': { hasMusicUrlByMusic: async() => false },
    '@/core/player/player': {},
    '@/core/qqMusicFavorite': { useQQMusicLiked: () => false, loadWritableQQMusicPlaylists: () => gate.promise },
    '@/utils/tools': style,
    '@/utils/hooks/useScreenVisible': { useScreenVisible: h.visible },
  }).default
  const render = () => h.render(frame, () => Component({}, ref))
  render()
  ref.current.show({ musicInfo: song(1), selectedList: Array.from({ length: 5000 }, (_, i) => song(i)), single: false, index: 0 })
  let tree = render()
  elements(tree, 'MenuRow').find(row => row.props.label === 'qq_playlist_add_to').props.onPress()
  render()
  popup.setVisible(false)
  tree = render()
  assert.ok(frame.slots.every(slot => !slot.value?.selectedList?.length && !slot.current?.selectedList?.length))
  gate.resolve(Array.from({ length: 1000 }, (_, i) => ({ id: i, name: String(i) })))
  await flush()
  tree = render()
  assert.equal(elements(tree, 'MenuRow').length, 0)
  assert.ok(frame.slots.every(slot => !Array.isArray(slot.value) || slot.value.length === 0))
  h.unmount(frame)
})

const qqScreenHarness = read => {
  const h = hookHost(); const frame = h.frame()
  let holds = 0
  const list = { setList() {}, setStatus() {} }
  frame.connect = tree => {
    const node = elements(tree, 'OnlineList')[0]
    if (node) node.props.ref.current = list
  }
  const Component = load('src/screens/QQPlaylist/index.tsx', {
    react: h.react,
    'react-native': { View: 'View' },
    '@/utils/hooks/useScreenVisible': { useScreenVisible: h.visible },
    '@/components/PageContent': { default: 'PageContent' },
    '@/components/common/StatusBar': {},
    '@/components/SimpleHeader': {},
    '@/components/player/PlayerBar': {},
    '@/components/OnlineList': { default: 'OnlineList' },
    '@/components/common/Text': {},
    '@/components/common/ImageBackground': {},
    '@/components/common/Icon': {},
    '@/components/common/IconAction': {},
    '@/components/common/PlusMinusIcon': {},
    '@/core/common': { setComponentId() {} },
    '@/config/constant': constants,
    '@/core/list': {},
    '@/core/player/player': {},
    '@/core/qqMusic': {},
    '@/core/qqMusicFavorite': {
      getQQMusicLikedSongs: () => null,
      isQQMusicLikedSongsStale: async() => false,
      loadQQMusicLikedSongsCache: read,
      retainQQMusicLikedSongs: () => { holds++ },
      releaseQQMusicLikedSongs: () => { holds-- },
    },
    '@/core/qqMusicPlaylistSongsCache': {},
    '@/core/qqMusicDailyPosition': {},
    '@/utils/data': {},
    '@/utils/tools': style,
    '@/utils/pixelRatio': { scaleSizeW: value => value },
    '@/utils/hooks': {},
    '@/lang': lang,
  }).default
  const props = { componentId: 'liked', info: { id: 'liked', name: 'Liked', liked: true } }
  return { h, frame, holds: () => holds, render: () => h.render(frame, () => Component(props)) }
}

test('QQ liked pages release song refs when hidden and restore using the existing local cache', async() => {
  let reads = 0
  const h = qqScreenHarness(async() => { reads++; return Array.from({ length: 5000 }, (_, i) => song(i)) })
  h.render()
  await flush()
  assert.ok(h.frame.slots.some(slot => Array.isArray(slot.current) && slot.current.length === 5000))
  assert.equal(h.holds(), 1)
  h.frame.visible = false
  h.render()
  assert.equal(h.holds(), 0)
  assert.ok(h.frame.slots.every(slot => !Array.isArray(slot.current) || slot.current.length === 0))
  h.frame.visible = true
  h.render()
  await flush()
  assert.equal(reads, 2)
  assert.equal(h.holds(), 1)
  h.h.unmount(h.frame)
  assert.equal(h.holds(), 0)
})

test('a late QQ playlist read cannot refill the hidden screen song ref', async() => {
  const gate = deferred(); const h = qqScreenHarness(() => gate.promise)
  h.render()
  await flush()
  h.frame.visible = false
  h.render()
  gate.resolve(Array.from({ length: 5000 }, (_, i) => song(i)))
  await flush()
  assert.ok(h.frame.slots.every(slot => !Array.isArray(slot.current) || slot.current.length === 0))
  h.h.unmount(h.frame)
})
