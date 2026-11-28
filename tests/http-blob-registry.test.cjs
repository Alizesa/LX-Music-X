const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const babel = require('@babel/core')
const { load } = require('./helpers/load.cjs')

test('repeated reads of RN fetch responses leave no owned IDs in the installed BlobRegistry', async() => {
  const modules = new Map(); let releases = 0
  const app = { AbortController, unescape, __blobCollectorProvider: () => null }
  const native = { createFromParts() {}, release() { releases++ } }
  const rn = id => {
    if (modules.has(id)) return modules.get(id).exports
    const mod = { exports: {} }; modules.set(id, mod)
    const filename = path.join(path.dirname(require.resolve('react-native/package.json')), 'Libraries/Blob', `${id}.js`)
    const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
      configFile: false, babelrc: false, plugins: ['@babel/plugin-transform-flow-strip-types', '@babel/plugin-transform-modules-commonjs'],
    })
    vm.runInNewContext(code, {
      exports: mod.exports,
      module: mod,
      global: app,
      require: name => name === './NativeBlobModule' ? native : name.startsWith('./') ? rn(name.slice(2)) : require(name),
    })
    return mod.exports
  }
  class Reader {
    readAsText() { this.result = 'hello'; this.onload() }
    readAsDataURL() { this.result = 'data:application/octet-stream;base64,YWJj'; this.onload() }
  }
  const env = { Blob: rn('Blob'), FileReader: Reader }
  vm.runInNewContext(fs.readFileSync(require.resolve('whatwg-fetch'), 'utf8'), env)
  const registry = rn('BlobRegistry'); const manager = rn('BlobManager'); let id = 0
  app.fetch = async() => new env.Response(manager.createFromOptions({ blobId: `body-${++id}`, type: 'text/plain', size: 3, offset: 0 }))
  app.FileReader = Reader
  const { createFetchData } = load('src/utils/httpRequest.js', { 'react-native-background-timer': { default: { setTimeout, clearTimeout } } }, { global: app })
  const read = createFetchData()
  for (let i = 0; i < 300; i++) {
    const binary = i % 2 === 1
    const { body } = await read('https://fixture/item', { binary }).request
    assert.equal(body.toString(), binary ? 'abc' : 'hello')
    assert.equal(!!registry.has(`body-${id}`), false)
  }
  assert.equal(releases, 300)
})
