package cn.toside.music.mobile.userApi;

import android.util.Log;

import androidx.annotation.Nullable;

import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

public class UtilsEvent {
  final String API_ACTION = "api-action";
  private final ReactApplicationContext reactContext;
  private final String runtimeId;

  UtilsEvent(ReactApplicationContext reactContext) {
    this(reactContext, "main");
  }

  UtilsEvent(ReactApplicationContext reactContext, String runtimeId) {
    this.reactContext = reactContext;
    this.runtimeId = runtimeId;
  }

  public void sendEvent(String eventName, @Nullable WritableMap params) {
    if (params != null) params.putString("runtimeId", runtimeId);
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
      .emit(eventName, params);
  }
}
