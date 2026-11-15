const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')

test('the actual preload reads native script text only when requested and caches the immutable value', () => {
  let reads = 0
  const context = vm.createContext({
    __lx_native_call__: () => {},
    __lx_native_call__raw_script: () => { reads++; return 'source body' },
  })
  for (const name of ['set_timeout', 'clear_timeout', 'utils_str2b64', 'utils_b642buf', 'utils_str2md5', 'utils_aes_encrypt', 'utils_rsa_encrypt']) context[`__lx_native_call__${name}`] = () => ''
  const source = fs.readFileSync(path.join(__dirname, '../android/app/src/main/assets/script/user-api-preload.js'), 'utf8')
  vm.runInContext(source, context)
  context.lx_setup('key', 'id', 'Name', '', '', '', '')
  assert.equal(reads, 0)
  assert.equal(context.__lx_native_call__raw_script, undefined)
  assert.equal(context.lx.currentScriptInfo.rawScript, 'source body')
  assert.equal(context.lx.currentScriptInfo.rawScript, 'source body')
  assert.equal(reads, 1)
  assert.equal(Object.isFrozen(context.lx.currentScriptInfo), true)
})

test('the preload retains the rawScript fallback for an older native setup caller', () => {
  const context = vm.createContext({ __lx_native_call__: () => {} })
  const source = fs.readFileSync(path.join(__dirname, '../android/app/src/main/assets/script/user-api-preload.js'), 'utf8')
  vm.runInContext(source, context)
  context.lx_setup('key', 'id', 'Name', '', '', '', '', 'legacy body')
  assert.equal(context.lx.currentScriptInfo.rawScript, 'legacy body')
})

test('native setup passes metadata and keeps script text behind the private getter', () => {
  const source = fs.readFileSync(path.join(__dirname, '../android/app/src/main/java/cn/toside/music/mobile/userApi/QuickJS.java'), 'utf8')
  const setup = source.split('\n').find(line => line.includes('callFunction("lx_setup"'))
  assert.ok(setup)
  assert.equal(setup.includes('rawScript'), false)
  assert.match(source, /setProperty\("__lx_native_call__raw_script", args -> rawScript\)/)
})
