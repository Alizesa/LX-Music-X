const test = require('node:test')
const assert = require('node:assert/strict')
const { createState, registerPush, publishManifest, validateTargetVersion } = require('../publish/release-state.cjs')
const { createSourceHistory } = require('../publish/source-history.cjs')
const { selectUpdate } = require('../shared/release')
const { manifest } = require('./helpers/release.cjs')

const sha = value => value.repeat(40)
const push = (branch, value, before, extra = {}) => ({ branch, sha: sha(value), before: sha(before), ...extra })

test('a delayed Next source already included in stable cannot become a higher-version update', () => {
  const state = createState('1.9.2', 100000)
  const stable = registerPush(state, push('master', 'b', '0', { bootstrap: true }))
  const preview = registerPush(state, push('Next', 'a', '0', { bootstrap: true }), {
    isAncestor: (older, newer) => older === sha('a') && newer === sha('b'),
  })
  assert.equal(preview.version, '1.9.3-next.2')
  assert.equal(preview.supersededBy, stable.tag)
  assert.equal(state.nextTargetVersion, '1.9.4')
  const update = { ...manifest(preview.version, preview.versionCode), sourceSha: preview.sourceSha }
  assert.equal(selectUpdate([update], 'next', stable.version, stable.versionCode), null)
  assert.equal(publishManifest(state, update), false)
  assert.equal(state.channels.next, undefined)
  assert.equal(state.builds[`Next/${sha('a')}`].status, 'published')
})

test('pending previews use the stable source current at allocation, not registration time', () => {
  const state = createState('1.9.2', 100000)
  registerPush(state, push('Next', 'c', 'a'))
  registerPush(state, push('master', 'd', '0', { bootstrap: true }))
  registerPush(state, push('Next', 'a', '0', { bootstrap: true }), { isAncestor: () => true })
  assert.equal(state.builds[`Next/${sha('a')}`].supersededBy, 'v1.9.3')
  assert.equal(state.builds[`Next/${sha('c')}`].supersededBy, 'v1.9.3')
  assert.equal(state.builds[`Next/${sha('c')}`].version, '1.9.3-next.3')
})

test('new Next work after stable still advances the preview target and Android code', () => {
  const state = createState('1.9.2', 100000)
  registerPush(state, push('master', 'b', '0', { bootstrap: true }))
  const next = registerPush(state, push('Next', 'c', 'a', { bootstrap: true }), { isAncestor: () => false })
  assert.equal(next.version, '1.9.4-next.2')
  assert.equal(next.supersededBy, undefined)
})

test('invalid targets are rejected before the event or its branch is changed', () => {
  for (const targetVersion of ['2.0', '', '02.0.0', '2.0.0-next.1', '2.0.0+build.1', 2]) {
    const state = createState('1.9.2', 100000)
    const before = structuredClone(state)
    assert.throws(() => registerPush(state, push('Next', 'a', '0', { bootstrap: true, targetVersion })))
    assert.deepEqual(state, before)
  }
  assert.equal(validateTargetVersion(null), null)
  assert.equal(validateTargetVersion('2.10.0'), '2.10.0')
})

test('a legacy invalid pending target cannot roll back its predecessor or another branch', () => {
  const state = createState('1.9.2', 100000)
  registerPush(state, push('Next', 'a', '0', { bootstrap: true }))
  state.events[`Next/${sha('c')}`] = push('Next', 'c', 'b', { targetVersion: '2.0' })
  assert.equal(registerPush(state, push('Next', 'b', 'a')).version, '1.9.3-next.2')
  assert.match(state.events[`Next/${sha('c')}`].error, /Invalid version/)
  assert.equal(registerPush(state, push('master', 'd', '0', { bootstrap: true })).version, '1.9.3')
  const corrected = registerPush(state, push('Next', 'c', 'b', { targetVersion: '2.0.0' }), { correctTarget: true })
  assert.equal(corrected.version, '2.0.0-next.4')
  assert.equal(state.events[`Next/${sha('c')}`], undefined)
  assert.equal(registerPush(state, push('Next', 'c', 'b', { targetVersion: '3.0.0' }), { correctTarget: true }), corrected)
})

test('an explicit correction survives an older waiting run registering its original target again', () => {
  const state = createState('1.9.2', 100000)
  registerPush(state, push('Next', 'c', 'b', { targetVersion: '2.0.0' }))
  registerPush(state, push('Next', 'c', 'b', { targetVersion: '1.10.0' }), { correctTarget: true })
  registerPush(state, push('Next', 'c', 'b', { targetVersion: '2.0.0' }))
  registerPush(state, push('Next', 'b', '0', { bootstrap: true }))
  assert.equal(state.builds[`Next/${sha('c')}`].version, '1.10.0-next.2')
})

test('restored build records recover branch cursors even when an older public run is retried first', () => {
  const state = createState('1.9.2', 100000)
  registerPush(state, push('master', 'a', '0', { bootstrap: true }))
  registerPush(state, push('master', 'b', 'a'))
  state.branches = {}
  registerPush(state, push('master', 'a', '0'))
  assert.equal(state.branches.master, sha('b'))
  assert.equal(registerPush(state, push('master', 'c', 'b')).version, '1.9.5')
})

test('source ancestry reuses immutable results and fetches only missing commit objects', () => {
  const commands = []
  let present = false
  const compare = createSourceHistory('/fixture', (executable, args) => {
    commands.push(args)
    if (args[0] === 'fetch') { present = true; return '' }
    if (!present) throw Object.assign(new Error('missing object'), { status: 128 })
    if (args[2] === sha('c')) throw Object.assign(new Error('not an ancestor'), { status: 1 })
    return ''
  })
  assert.equal(compare(sha('a'), sha('b')), true)
  assert.equal(compare(sha('a'), sha('b')), true)
  assert.equal(compare(sha('c'), sha('b')), false)
  assert.equal(commands.filter(args => args[0] === 'fetch').length, 1)
  assert.equal(commands.filter(args => args[0] === 'merge-base').length, 3)
  assert.throws(() => compare('--upload-pack=bad', sha('b')), /Invalid source/)
})
