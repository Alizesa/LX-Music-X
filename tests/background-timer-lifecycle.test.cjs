const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const patches = require('../patches/background-timer')
const { load } = require('./helpers/load.cjs')

const root = path.dirname(require.resolve('react-native-background-timer/package.json'))
const index = 'index.js'
const java = 'android/src/main/java/com/ocetnik/timer/BackgroundTimerModule.java'
const installed = name => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n')
const apply = (name, source) => {
  for (const [file, from, to] of patches) {
    if (file !== name || source.includes(to)) continue
    assert.ok(source.includes(from), `missing pinned source in ${file}`)
    source = source.replace(from, to)
  }
  return source
}
const harness = (os = 'android', cancellable = true) => {
  const jobs = new Map(); let listener; let posts = 0; let clears = 0
  const native = { setTimeout(id, ms) { posts++; jobs.set(id, ms) } }
  if (cancellable) native.clearTimeout = id => { clears++; jobs.delete(id) }
  const mobile = {
    NativeModules: { RNBackgroundTimer: native },
    Platform: { OS: os },
    NativeEventEmitter: class { addListener(_name, cb) { listener = cb } },
  }
  const context = { exports: {}, require: () => mobile }
  const code = ts.transpileModule(apply(index, installed(index)), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
  vm.runInNewContext(code, context)
  return { timer: context.exports.default, jobs, posts: () => posts, clears: () => clears, fire(id) { jobs.delete(id); listener(id) } }
}

test('completed short-budget probes withdraw both Android deadlines before they fire', async() => {
  const h = harness()
  const audio = load('src/utils/nativeModules/remoteAudio.ts', {
    'react-native': { NativeModules: { UtilsModule: { startRemoteAudioProbe: async() => ({ readable: true, durationMs: 180000, mime: 'audio/mpeg' }) } } },
    'react-native-background-timer': { default: h.timer },
  })
  for (let i = 0; i < 1000; i++) await audio.probeRemoteAudio(`https://fixture/${i}`, true, { timeoutMs: 5000 })
  assert.equal(h.posts(), 2000); assert.equal(Object.keys(h.timer.callbacks).length, 0)
  assert.equal(h.jobs.size, 0); assert.equal(h.clears(), 2000)
})

test('cancelling a rearmed interval inside its callback does not disturb a sibling timeout', () => {
  const h = harness(); const fired = []
  const once = h.timer.setTimeout(() => fired.push('once'), 30)
  const repeat = h.timer.setInterval(() => { fired.push('interval'); h.timer.clearInterval(repeat) }, 10)
  h.fire(repeat); h.timer.clearInterval(repeat)
  assert.deepEqual([...h.jobs.keys()], [once]); assert.equal(h.clears(), 1)
  h.fire(repeat); h.fire(once)
  assert.deepEqual(fired, ['interval', 'once']); assert.equal(h.jobs.size, 0)
})

test('late events are harmless on older Android bridges and other platforms', () => {
  for (const [os, cancellable] of [['android', false], ['ios', true]]) {
    const h = harness(os, cancellable)
    const id = h.timer.setTimeout(() => assert.fail('cancelled timer fired'), 10)
    h.timer.clearTimeout(id); h.fire(id); assert.equal(h.clears(), 0)
  }
})

test('postinstall applies idempotent timer patches and Android actually removes the queued messages', () => {
  for (const file of [index, java]) {
    const result = apply(file, installed(file)); assert.equal(apply(file, result), result)
  }
  const code = apply(java, installed(java))
  assert.match(code, /sendEmptyMessageDelayed\(id,/)
  assert.match(code, /@ReactMethod\s+public synchronized void clearTimeout\(final int id\)\s*\{\s*if \(timeoutHandler != null\) timeoutHandler.removeMessages\(id\)/)
  assert.match(code, /void invalidate\(\)\s*\{[^}]*removeCallbacksAndMessages\(null\)/s)
  assert.ok(fs.readFileSync(path.join(__dirname, '../dependencies-patch.js'), 'utf8').includes("require('./patches/background-timer')"))
})

// CI runs the actual patched module against a deterministic Handler queue. No Android build/emulator needed.
test('Android Handler entries are withdrawn by ID and module teardown does not affect another owner',
  { skip: !process.env.CI && 'Java compilation runs only in CI' }, () => {
    const { spawnSync } = require('node:child_process')
    const temp = fs.realpathSync(require('node:os').tmpdir())
    const dir = fs.mkdtempSync(path.join(temp, 'lx-android-timers-'))
    const bridge = 'com/facebook/react/bridge/'
    const stubs = {
      'android/os/Looper': 'public class Looper { public static Looper myLooper(){ return null; } public static Looper getMainLooper(){ return new Looper(); } }',
      'android/os/Message': 'public class Message { public int what; public Message(int id){ what=id; } }',
      'android/os/Handler': `import java.util.*;
        public class Handler {
          public interface Callback { boolean handleMessage(Message m); }
          private static class Job { Handler owner; int id; Runnable call; Job(Handler h,int i,Runnable r){ owner=h; id=i; call=r; } }
          private static final List<Job> queue = new ArrayList<>(); private final Callback callback;
          public Handler(Looper l){ this(l,null); } public Handler(Looper l,Callback c){ callback=c; }
          public boolean sendEmptyMessageDelayed(int id,long delay){ queue.add(new Job(this,id,()->callback.handleMessage(new Message(id)))); return true; }
          public void removeMessages(int id){ queue.removeIf(j -> j.owner==this && j.id==id); }
          public void removeCallbacksAndMessages(Object token){ if(token!=null) throw new AssertionError(); queue.removeIf(j -> j.owner==this); }
          public boolean post(Runnable r){ queue.add(new Job(this,-1,r)); return true; }
          public void removeCallbacks(Runnable r){ queue.removeIf(j -> j.owner==this && j.call==r); }
          public static int pending(){ return queue.size(); } public static Runnable dequeue(){ return queue.remove(0).call; }
        }`,
      [bridge + 'ReactMethod']: 'public @interface ReactMethod {}',
      [bridge + 'LifecycleEventListener']: 'public interface LifecycleEventListener {}',
      [bridge + 'ReactContext']: 'public class ReactContext { public boolean hasActiveReactInstance(){return true;} public <T> T getJSModule(Class<T> c){throw new AssertionError();} }',
      [bridge + 'ReactApplicationContext']: 'public class ReactApplicationContext extends ReactContext {}',
      [bridge + 'ReactContextBaseJavaModule']: 'public abstract class ReactContextBaseJavaModule { protected ReactContextBaseJavaModule(ReactApplicationContext c){} public abstract String getName(); public void invalidate(){} }',
      'com/facebook/react/modules/core/DeviceEventManagerModule': 'public class DeviceEventManagerModule { public interface RCTDeviceEventEmitter { void emit(String event, Object value); } }',
    }
    try {
      const sources = Object.entries(stubs).map(([name, body]) => {
        const file = path.join(dir, name + '.java'); fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, `package ${path.posix.dirname(name).replaceAll('/', '.')};\n${body}`)
        return file
      })
      const module = path.join(dir, 'BackgroundTimerModule.java'); fs.writeFileSync(module, apply(java, installed(java)))
      const compile = spawnSync('javac', ['-encoding', 'UTF-8', '-d', dir, ...sources, module, path.join(__dirname, 'native/BackgroundTimerModuleTest.java')], { encoding: 'utf8', timeout: 30000 })
      assert.equal(compile.status, 0, compile.stderr || String(compile.error))
      const result = spawnSync('java', ['-cp', dir, 'com.ocetnik.timer.BackgroundTimerModuleTest'], { encoding: 'utf8', timeout: 30000 })
      assert.equal(result.status, 0, result.stderr || String(result.error))
    } finally {
      if (path.dirname(fs.realpathSync(dir)) === temp) fs.rmSync(dir, { recursive: true, force: true })
    }
  })
