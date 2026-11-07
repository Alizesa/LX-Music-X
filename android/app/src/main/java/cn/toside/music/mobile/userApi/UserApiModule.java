package cn.toside.music.mobile.userApi;

import android.os.Bundle;
import android.os.Handler;
import android.os.Message;
import android.util.Log;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableMap;
import java.lang.Thread;
import java.util.concurrent.ConcurrentHashMap;

public class UserApiModule extends ReactContextBaseJavaModule {
  private final ConcurrentHashMap<String, JavaScriptThread> runtimes = new ConcurrentHashMap<>();
  private final ReactApplicationContext reactContext;

  private int listenerCount = 0;

  UserApiModule(ReactApplicationContext reactContext) {
    super(reactContext);
    this.reactContext = reactContext;
  }

  @Override
  public String getName() {
    return "UserApiModule";
  }

  @ReactMethod
  public void addListener(String eventName) {
    if (listenerCount == 0) {
      // Set up any upstream listeners or background tasks as necessary
    }

    listenerCount += 1;
  }

  @ReactMethod
  public void removeListeners(Integer count) {
    listenerCount -= count;
    if (listenerCount == 0) {
      // Remove upstream listeners, stop unnecessary background tasks
    }
  }

  @ReactMethod
  public void loadScript(ReadableMap data) {
    loadScriptForRuntime("main", data);
  }

  @ReactMethod
  public void loadScriptForRuntime(String runtimeId, ReadableMap data) {
    destroyRuntime(runtimeId);
    Bundle info = Arguments.toBundle(data);
    JavaScriptThread thread = new JavaScriptThread(this.reactContext, info);
    thread.prepareHandler(new JsHandler(this.reactContext.getMainLooper(), new UtilsEvent(this.reactContext, runtimeId)));
    runtimes.put(runtimeId, thread);
    thread.getHandler().sendEmptyMessage(HandlerWhat.INIT);
    thread.setUncaughtExceptionHandler((t, ex) -> {
      // 用局部变量，别读字段：destroy 后字段已经是 null
      Handler jsHandler = thread.getHandler();
      if (jsHandler != null) {
        Message message = jsHandler.obtainMessage();
        message.what = HandlerWhat.LOG;
        message.obj = new Object[]{"error", "Uncaught exception in JavaScriptThread: " + ex.getMessage()};
        jsHandler.sendMessage(message);
      }
      Log.e("JavaScriptThread", "Uncaught exception in JavaScriptThread: " + ex.getMessage());
    });
    Log.d("UserApi", "Module Thread id: " + Thread.currentThread().getId());
  }

  @ReactMethod
  public boolean sendAction(String action, String info) {
    return sendActionForRuntime("main", action, info);
  }

  @ReactMethod
  public boolean sendActionForRuntime(String runtimeId, String action, String info) {
    JavaScriptThread javaScriptThread = runtimes.get(runtimeId);
    if (javaScriptThread == null) return false;
    Handler jsHandler = javaScriptThread.getHandler();
    Message message = jsHandler.obtainMessage();
    message.what = HandlerWhat.ACTION;
    message.obj = new Object[]{action, info};
    jsHandler.sendMessage(message);
    return true;
  }

  @ReactMethod
  public void destroy() {
    destroyRuntime("main");
  }

  @ReactMethod
  public void destroyRuntime(String runtimeId) {
    JavaScriptThread javaScriptThread = runtimes.remove(runtimeId);
    if (javaScriptThread == null) return;
    // 先摘掉引用拒绝新请求，再让脚本线程自己销毁上下文并退出。
    // 不能在这里直接 quit()：DESTROY 可能还没被消费，QuickJS 上下文就漏了
    javaScriptThread.getHandler().sendEmptyMessage(HandlerWhat.DESTROY);
  }

  @Override
  public void invalidate() {
    for (String runtimeId : runtimes.keySet()) destroyRuntime(runtimeId);
    super.invalidate();
  }
}
