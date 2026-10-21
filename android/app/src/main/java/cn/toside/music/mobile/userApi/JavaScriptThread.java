package cn.toside.music.mobile.userApi;

import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Message;
import android.util.Log;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.ReactApplicationContext;

public class JavaScriptThread extends HandlerThread {
  private Handler handler;
  private QuickJS javaScriptExecutor;
  private boolean destroyed = false;
  private final ReactApplicationContext reactContext;
  private final Bundle scriptInfo;

  JavaScriptThread(ReactApplicationContext context, Bundle info) {
    super("JavaScriptThread");
    this.reactContext = context;
    this.scriptInfo = info;
  }

  public void prepareHandler(final Handler mainHandler) {
    start();
    Log.d("UserApi [thread]", "running 2");
    this.handler = new Handler(getLooper()) {
      @Override
      public void handleMessage(@NonNull Message message) {
        // 销毁必须先处理：quit() 不保证消费已入队消息，DESTROY 不能排在
        // 「创建执行器」和 ACTION 分发后面
        if (message.what == HandlerWhat.DESTROY) {
          destroyed = true;
          if (javaScriptExecutor != null) {
            javaScriptExecutor.destroy();
            javaScriptExecutor = null;
          }
          // 处理完当前消息后，把已入队的非延迟消息走完再退出 looper。
          // destroyed 保证排在 DESTROY 后面的 ACTION 不会再创建/调用执行器
          quitSafely();
          return;
        }
        if (destroyed) return;

        if (javaScriptExecutor == null) {
          javaScriptExecutor = new QuickJS(reactContext, mainHandler);
          Log.d("UserApi [thread]", "javaScript executor created");
          String result = javaScriptExecutor.loadScript(scriptInfo);
          if ("".equals(result)) {
            Log.d("UserApi [thread]", "script loaded");
            mainHandler.sendEmptyMessage(HandlerWhat.INIT_SUCCESS);
          } else {
            Log.w("UserApi [thread]", "script load failed: " + result);
            mainHandler.sendMessage(mainHandler.obtainMessage(HandlerWhat.INIT_FAILED, result));
          }
        }
        switch (message.what) {
          case HandlerWhat.INIT: break;
          case HandlerWhat.ACTION: {
            if (javaScriptExecutor == null) return;
            Object[] data = (Object[]) message.obj;
            // Log.d("UserApi [handler]", "handler action: " + data[0]);
            javaScriptExecutor.callJS((String) data[0], data[1]);
            return;
          }
          default:
            Log.w("UserApi [handler]", "Unknown message what: " + message.what);
            break;
        }
      }
    };
  }

  public Handler getHandler() {
    return this.handler;
  }
}
