const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createHash } = require('node:crypto')
const { scriptHarness } = require('./helpers/user-api-script.cjs')

const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n')
const modulePath = 'android/quickjs/'
const method = (source, signature) => {
  const start = source.indexOf(signature)
  assert.notEqual(start, -1, signature)
  const open = source.indexOf('{', start)
  let depth = 1
  let end = open + 1
  for (; depth && end < source.length; end++) {
    if (source[end] === '{') depth++
    if (source[end] === '}') depth--
  }
  assert.equal(depth, 0)
  return source.slice(open + 1, end - 1)
}

test('the local JNI module keeps pinned 2.4.0 sources, licenses and every required C/C++ include', () => {
  const manifest = JSON.parse(read(modulePath + 'upstream.json'))
  assert.equal(manifest.wrapper.revision, 'd561f7b99a09bbf9ff5017a4152eca5359eccfa3')
  assert.equal(manifest.engine.revision, 'c46516996da53eaf2f9aca516264870e25719d76')
  assert.match(read(modulePath + 'LICENSE.wrapper'), /Apache License/)
  assert.match(read(modulePath + 'src/main/native/quickjs/LICENSE'), /Fabrice Bellard/)
  for (const file of manifest.files) {
    const source = read(modulePath + file.target)
    if (!manifest.patchedFiles.includes(file.target)) {
      assert.equal(createHash('sha256').update(source).digest('hex'), file.sha256, file.target)
    }
    if (/\.(?:cpp|c|h)$/.test(file.target)) {
      for (const include of source.matchAll(/^#\s*include\s*"([^"\n]+)"/gm)) {
        assert.ok(fs.existsSync(path.resolve(root, modulePath, path.dirname(file.target), include[1])), file.target + ': ' + include[1])
      }
    }
  }
  const cmake = read(modulePath + 'src/main/CMakeLists.txt')
  for (const file of cmake.matchAll(/native\/[^\s)]+\.(?:cpp|c)/g)) {
    assert.ok(fs.existsSync(path.join(root, modulePath, 'src/main', file[0])), file[0])
  }
  assert.match(cmake, /CONFIG_BIGNUM/)
  assert.match(read(modulePath + 'build.gradle'), /ndkVersion rootProject\.ext\.ndkVersion/)
  assert.match(read(modulePath + 'build.gradle'), /reactNativeArchitectures/)
  assert.match(read(modulePath + 'build.gradle'), /wrapper-java:2\.4\.0/)
  assert.match(read('android/app/build.gradle'), /implementation project\(':quickjs'\)/)
  assert.doesNotMatch(read('android/app/build.gradle'), /wrapper-android:/)
})

test('JNI argument ownership covers conversion failures and is released before exception reporting', () => {
  const source = read(modulePath + 'src/main/native/cpp/quickjs_wrapper.cpp')
  const call = method(source, 'jobject QuickJSWrapper::call(')
  assert.match(call, /~ScopedCallArguments\(\) \{ clear\(\); \}/)
  assert.match(call, /for \(JSValue value : values\) JS_FreeValue\(ctx, value\)/)
  assert.match(call, /owned\.values\.push_back\(jsArg\)/)
  assert.match(call, /JS_IsException\(jsArg\) \|\| env->ExceptionCheck\(\)/)
  const invocation = call.indexOf('JSValue ret = JS_Call(')
  const cleanup = call.indexOf('owned.clear();', invocation)
  const exception = call.indexOf('if (JS_IsException(ret))', invocation)
  const report = call.indexOf('throwJSException(env, context);', invocation)
  assert.ok(invocation < cleanup && cleanup < exception && exception < report)
  assert.match(call.slice(exception), /JS_FreeValue\(context, ret\);\s*throwJSException/)
  const reporting = method(source, 'static void tryToTriggerOnError(')
  assert.match(reporting, /JS_FreeValue\(ctx, result\)/)
  assert.match(reporting, /JS_FreeValue\(ctx, onerror\);\s*JS_FreeValue\(ctx, global\)/)
  const stringify = method(source, 'static string reportingValueToString(')
  assert.match(stringify, /if \(JS_IsException\(value\)\) \{\s*discardReportingException\(ctx\);\s*return fallback;/)
  assert.match(stringify, /if \(text == nullptr\) \{\s*discardReportingException\(ctx\);\s*return fallback;/)
  assert.ok(stringify.indexOf('text == nullptr') < stringify.indexOf('string result(text)'))
  assert.match(stringify, /JS_FreeCString\(ctx, text\)/)
})

// Execute the Java method's control flow after erasing local variable types.
// This checks the source's finally paths; it does not execute Java or JNI.
const functionControl = () => {
  const source = read(modulePath + 'src/main/java/com/whl/quickjs/wrapper/SafeJSFunction.java')
  const compile = signature => vm.runInThisContext('(function(args) { with (this) {' + method(source, signature)
    .replace(/\bint (releases|i)\b/g, 'let $1')
    .replace(/super\.release\(\)/g, 'releaseNative()') + '}})')
  const host = {
    callDepth: 0,
    deferredReleases: 0,
    thisPointer: 1,
    references: 1,
    checkRefCountIsZero() { assert.ok(this.references > 0) },
    releaseNative() { this.references-- },
    getContext() { return { call: (...args) => host.invoke(...args) } },
    call: compile('public Object call(Object... args)'),
    release: compile('public void release()'),
  }
  return host
}

for (const fails of [false, true]) {
  test(`function references release after a ${fails ? 'failed' : 'successful'} invocation`, () => {
    const host = functionControl()
    host.invoke = () => {
      host.release()
      assert.equal(host.references, 1, 'release while native code is calling must be deferred')
      if (fails) throw new Error('script failed')
      return 'response'
    }
    if (fails) assert.throws(() => host.call([]), /script failed/)
    else assert.equal(host.call([]), 'response')
    assert.equal(host.references, 0)
    assert.equal(host.callDepth, 0)
    assert.equal(host.deferredReleases, 0)
  })
}

test('a nested callback cannot release the function while its outer native call is running', () => {
  const host = functionControl()
  host.invoke = () => {
    if (host.callDepth === 1) {
      host.call([])
      assert.equal(host.references, 1)
    } else host.release()
  }
  host.call([])
  assert.equal(host.references, 0)
  assert.equal(host.callDepth, 0)
})

test('the application releases every acquired function and discarded object result', () => {
  const source = read('android/app/src/main/java/cn/toside/music/mobile/userApi/QuickJS.java')
  const invoke = method(source, 'private void callFunction(')
  assert.match(invoke, /function\.callVoid\(params\);\s*} finally \{\s*function\.release\(\);/)
  assert.match(method(source, 'private void evaluateScript('), /result instanceof JSObject.*\(\(JSObject\) result\)\.release\(\)/)
  assert.match(source, /SafeQuickJSContext\.create\(\)/)
  assert.equal((source.match(/\.getJSFunction\(/g) || []).length, 1)
  assert.equal((source.match(/\.evaluate\(/g) || []).length, 1)
})

test('the real preload script removes a throwing response callback and accepts the following response', () => {
  const h = scriptHarness()
  h.context.lx.request('https://audio.test/fails', {}, () => { throw new Error('response failed') })
  const key = h.calls.at(-1).data.requestKey
  assert.throws(() => h.respond(key, null, 'body'.repeat(10000)), /response failed/)
  assert.equal(h.queue.size, 0)
  let callbacks = 0
  h.context.lx.request('https://audio.test/next', {}, () => { callbacks++ })
  assert.doesNotThrow(() => h.respond(h.calls.at(-1).data.requestKey))
  assert.equal(callbacks, 1)
  assert.equal(h.queue.size, 0)
})
