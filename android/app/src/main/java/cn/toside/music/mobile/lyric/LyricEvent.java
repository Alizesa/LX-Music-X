package cn.toside.music.mobile.lyric;

import androidx.annotation.Nullable;

import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

public class LyricEvent {
  final String SET_VIEW_POSITION = "set-position";
  final String LYRIC_Line_PLAY = "lyric-line-play";
  // 窗口被长按（用来锁定桌面歌词，锁不锁由 JS 侧的设置决定）
  final String VIEW_LONG_PRESS = "view-long-press";

  private final ReactApplicationContext reactContext;
  LyricEvent(ReactApplicationContext reactContext) { this.reactContext = reactContext; }

  public void sendEvent(String eventName, @Nullable WritableMap params) {
    // Log.d("Lyric", "senEvent: " + eventName);
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
      .emit(eventName, params);
  }
}
