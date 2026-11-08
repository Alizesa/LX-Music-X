const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const compiled = new Map()
const load = (file, mocks = {}, globals = {}) => {
  if (!compiled.has(file)) compiled.set(file, ts.transpileModule(fs.readFileSync(path.join(__dirname, '../..', file), 'utf8'), {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText)
  const context = {
    exports: {}, AbortController, Buffer, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    require: name => {
      assert.ok(Object.hasOwn(mocks, name), `Unexpected import: ${file}: ${name}`)
      return mocks[name]
    },
    ...globals,
  }
  vm.runInNewContext(compiled.get(file), context, { filename: file })
  return context.exports
}
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = async() => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)) }

module.exports = { load, deferred, flush }
