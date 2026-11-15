const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { load, deferred, flush } = require('./helpers/load.cjs')
const { hookHost, jsx, elements } = require('./helpers/react.cjs')
const patches = require('../patches/file-system')

const harness = ({ folder = deferred(), scan = async() => [] } = {}) => {
  const host = hookHost()
  const frame = host.frame()
  const calls = { pickers: 0, imports: [], notices: [] }
  const component = load('src/screens/LocalSongs/index.tsx', {
    react: host.react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { FlatList: 'List', TouchableOpacity: 'Button', View: 'View' },
    '@/components/PageContent': { default: 'Page' },
    '@/components/common/StatusBar': { default: 'StatusBar' },
    '@/components/SimpleHeader': { default: 'Header' },
    '@/components/player/PlayerBar': { default: 'Player' },
    '@/components/common/Text': { default: 'Text' },
    '@/components/common/Image': { default: 'Image' },
    '@/core/common': { setComponentId() {} },
    '@/config/constant': { COMPONENT_IDS: { localSongs: 'local' }, LIST_IDS: { LOCAL: 'LOCAL' } },
    '@/core/list': { getListMusics: async() => [], addListMusics: async(_, songs) => { calls.imports.push(songs) } },
    '@/core/localList': { retainLocalList: async() => [], releaseLocalList() {} },
    '@/core/player/tempPlayList': {},
    '@/utils/localMediaMetadata': { scanAudioFiles: scan, readMetadata: async() => null },
    '@/utils/fs': { selectManagedFolder: async() => { calls.pickers++; return folder.promise } },
    '@/utils/music': { buildLocalMusicInfoByFilePath: file => ({ ...file, meta: {} }) },
    '@/store/setting/state': { default: { setting: { 'list.addMusicLocationType': 'bottom' } } },
    '@/store/theme/hook': { useTheme: () => ({}) },
    '@/lang': { useI18n: () => key => key },
    '@/utils/tools': { createStyle: value => value, toast: (...args) => calls.notices.push(args) },
    '@/utils/hooks/useScreenVisible': { useScreenVisible: host.visible },
    '@/utils/hooks/useListScrollRestore': { useListScrollRestore: () => ({}) },
  }).default
  const render = () => host.render(frame, () => component({ componentId: 'local' }))
  const button = () => elements(render(), 'Header')[0].props.right
  return { host, frame, calls, folder, render, button }
}

for (const outcome of ['cancel', 'reject']) {
  test(`a rapid duplicate import opens one picker and unlocks after picker ${outcome}`, async() => {
    const h = harness()
    const oldButton = h.button()
    oldButton.props.onPress()
    oldButton.props.onPress()
    assert.equal(h.calls.pickers, 1)
    assert.equal(h.button().props.disabled, true)
    if (outcome === 'cancel') h.folder.resolve(null)
    else h.folder.reject(new Error('picker failed'))
    await flush()
    assert.equal(h.button().props.disabled, false)
    assert.equal(h.calls.imports.length, 0)
    h.button().props.onPress()
    assert.equal(h.calls.pickers, 2)
    await flush()
  })
}

test('an import stays locked and completes normally after its page hides', async() => {
  const scanning = deferred()
  const h = harness({ scan: async() => scanning.promise })
  const oldButton = h.button()
  oldButton.props.onPress()
  h.folder.resolve({ path: '/managed' })
  await flush()
  oldButton.props.onPress()
  assert.equal(h.calls.pickers, 1)
  h.frame.visible = false
  h.render()
  scanning.resolve([{ path: '/managed/one.mp3' }])
  await flush()
  assert.equal(h.calls.imports.length, 1)
  assert.equal(h.calls.imports[0][0].path, '/managed/one.mp3')
  assert.equal(h.button().props.disabled, false)
})

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

test('the native selector keeps its original listener on reentry and ignores unrelated activity results', () => {
  const listenerSource = patches[0][2]
  const native = { REQUEST_CODE: 27867, activityEventListener: null, cleared: 0 }
  native.clearPicker = () => { native.activityEventListener = null; native.cleared++ }
  const results = []
  const listener = {
    pendingPromise: { reject: (code, message) => results.push({ code, message }) },
    onPickerResult: () => { results.push({ resolved: null }) },
  }
  native.activityEventListener = listener
  const source = body(listenerSource, 'public final void onActivityResult(')
    .replace(/synchronized \(FileSystemModule\.this\)/g, '')
    .replace(/catch \(Exception error\)/g, 'catch (error)')
    .replace(/error\.getMessage\(\)/g, 'error.message')
  // Java control flow with synchronization/type declarations erased only.
  const handle = vm.runInThisContext('(function(native, activity, requestCode, resultCode, data) { with (native) { with (this) {' + source + '}}})')
  handle.call(listener, native, {}, 1, 0, null)
  assert.equal(native.activityEventListener, listener)
  assert.equal(native.cleared, 0)
  handle.call(listener, native, {}, 27867, 0, null)
  handle.call(listener, native, {}, 27867, 0, null)
  assert.deepEqual(results, [{ resolved: null }])
  assert.equal(native.cleared, 1)
  native.activityEventListener = listener
  listener.onPickerResult = () => { throw new Error('permission failed') }
  handle.call(listener, native, {}, 27867, 0, null)
  assert.deepEqual(results[1], { code: 'ERROR', message: 'permission failed' })
  assert.equal(native.cleared, 2)
  for (const patch of patches.slice(1)) {
    assert.match(patch[2], /public synchronized void openDocument/)
    assert.match(patch[2], /if \(activityEventListener != null\) \{\s*promise\.reject\("E_PICKER_IN_PROGRESS"/)
    assert.doesNotMatch(patch[2], /removeActivityEventListener/)
    assert.match(patch[2], /catch \(Exception e\) \{\s*clearPicker\(\)/)
  }
  assert.match(listenerSource, /finally \{\s*clearPicker\(\)/)
  assert.match(listenerSource, /E_PICKER_CANCELLED/)
  const target = path.join(__dirname, '../node_modules/react-native-file-system', patches[0][0])
  const installed = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n')
  for (const patch of patches) assert.ok(installed.includes(patch[2]))
})
