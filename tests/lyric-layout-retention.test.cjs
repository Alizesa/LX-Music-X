const assert = require('node:assert/strict')
const { test } = require('node:test')
const { spawnSync } = require('node:child_process')

test('V8 releases the initial 5000 parsed lines while a hidden rebuilt layout stays mounted', () => {
  const result = spawnSync(process.execPath, ['--expose-gc', '-e', `
    const assert = require('node:assert/strict')
    const { harness, lyrics, flush } = require('./tests/helpers/lyric-runtime.cjs')
    ;(async() => {
      const h = await harness({ scroll: true })
      const initial = h.frame()
      h.render(initial)
      h.api.setLyric(lyrics(5000))
      await flush()
      h.render(initial)
      const rebuilt = h.frame()
      const reference = new WeakRef(h.render(rebuilt).lines)
      assert.equal(reference.deref().length, 5000)
      h.host.unmount(initial)
      rebuilt.visible = false
      h.render(rebuilt)
      global.keepMountedLayout = { h, rebuilt }
      for (let i = 0; i < 12; i++) { await flush(); global.gc() }
      assert.equal(h.parser().lines.length, 0)
      assert.equal(h.tasks.size, 0)
      assert.equal(reference.deref() === undefined, true, 'hidden rebuilt layout must release its initial lines')
      h.host.unmount(rebuilt)
    })().catch(error => { console.error(error); process.exitCode = 1 })
  `], { cwd: process.cwd(), encoding: 'utf8', timeout: 20000 })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
