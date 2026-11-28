// Pinned fork: clearing its JS callback alone leaves a Handler.postDelayed on Android.
const java = 'android/src/main/java/com/ocetnik/timer/BackgroundTimerModule.java'

module.exports = [
  ...['timeoutId', 'intervalId'].map(id => [
    'index.js',
    `      // RNBackgroundTimer.clearTimeout(${id});`,
    `      if (Platform.OS === 'android' && typeof RNBackgroundTimer.clearTimeout === 'function') RNBackgroundTimer.clearTimeout(${id});`,
  ]),
  [java, 'import android.os.PowerManager;', 'import android.os.Looper;\nimport android.os.Message;'],
  [java, '    private Handler handler;', `    private Handler handler;
    private Handler timeoutHandler;
    private boolean invalidated;`],
  [java, `    public void start(final int delay) {
        handler = new Handler();`, `    public synchronized void start(final int delay) {
        if (invalidated) return;
        stop();
        handler = new Handler(timerLooper());`],
  [java, `    public void stop() {
        // avoid null pointer exceptio when stop is called without start
        if (handler != null) handler.removeCallbacks(runnable);
    }`, `    public synchronized void stop() {
        if (handler != null) handler.removeCallbacks(runnable);
        handler = null;
        runnable = null;
    }`],
  [java, '    private void sendEvent(ReactContext reactContext, String eventName) {', `    private synchronized void sendEvent(ReactContext reactContext, String eventName) {
        if (invalidated || !reactContext.hasActiveReactInstance()) return;`],
  [java, `    @ReactMethod
    public void setTimeout(final int id, final double timeout) {
        Handler handler = new Handler();
        handler.postDelayed(() -> {
            if (reactContext.hasActiveReactInstance()) {
                reactContext
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                    .emit("backgroundTimer.timeout", id);
            }
       }, (long) timeout);
    }

    /*@ReactMethod
    public void clearTimeout(final int id) {
        // todo one day..
        // not really neccessary to have
    }*/`, `    private static Looper timerLooper() {
        Looper current = Looper.myLooper();
        return current != null ? current : Looper.getMainLooper();
    }

    private synchronized boolean fireTimeout(Message message) {
        if (!invalidated && reactContext.hasActiveReactInstance()) {
            reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                .emit("backgroundTimer.timeout", message.what);
        }
        return true;
    }

    @ReactMethod
    public synchronized void setTimeout(final int id, final double timeout) {
        if (invalidated) return;
        if (timeoutHandler == null) timeoutHandler = new Handler(timerLooper(), this::fireTimeout);
        // Message.what is the JS timer ID. No per-timer Handler, Runnable or reference map.
        timeoutHandler.sendEmptyMessageDelayed(id, Math.max(0L, (long) timeout));
    }

    @ReactMethod
    public synchronized void clearTimeout(final int id) {
        if (timeoutHandler != null) timeoutHandler.removeMessages(id);
    }

    @Override
    public synchronized void invalidate() {
        invalidated = true;
        if (timeoutHandler != null) timeoutHandler.removeCallbacksAndMessages(null);
        timeoutHandler = null;
        stop();
        super.invalidate();
    }`],
]
