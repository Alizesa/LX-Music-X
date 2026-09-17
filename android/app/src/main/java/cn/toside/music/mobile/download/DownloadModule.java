package cn.toside.music.mobile.download;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;

import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkInfo;
import androidx.work.WorkManager;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import java.io.File;
import java.util.Map;
import java.util.UUID;

public class DownloadModule extends ReactContextBaseJavaModule {
  public static final String EVENT_NAME = "lx-download-update";
  private final ReactApplicationContext reactContext;
  private final BroadcastReceiver receiver;
  private boolean receiverRegistered = false;

  DownloadModule(ReactApplicationContext reactContext) {
    super(reactContext);
    this.reactContext = reactContext;
    receiver = new BroadcastReceiver() {
      @Override
      public void onReceive(Context context, Intent intent) {
        WritableMap event = Arguments.createMap();
        if (intent.getExtras() != null) {
          for (String key : intent.getExtras().keySet()) {
            Object value = intent.getExtras().get(key);
            if (value instanceof String) event.putString(key, (String) value);
            else if (value instanceof Long) event.putDouble(key, ((Long) value).doubleValue());
            else if (value instanceof Integer) event.putInt(key, (Integer) value);
            else if (value instanceof Boolean) event.putBoolean(key, (Boolean) value);
          }
        }
        emit(event);
      }
    };
  }

  @NonNull
  @Override
  public String getName() {
    return "DownloadModule";
  }

  @Override
  public void initialize() {
    super.initialize();
    if (receiverRegistered) return;
    ContextCompat.registerReceiver(
      reactContext,
      receiver,
      new IntentFilter(MusicDownloadWorker.ACTION_UPDATE),
      ContextCompat.RECEIVER_NOT_EXPORTED
    );
    receiverRegistered = true;
  }

  @Override
  public void invalidate() {
    if (receiverRegistered) {
      reactContext.unregisterReceiver(receiver);
      receiverRegistered = false;
    }
    super.invalidate();
  }

  private void emit(WritableMap event) {
    if (!reactContext.hasActiveReactInstance()) return;
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
      .emit(EVENT_NAME, event);
  }

  @ReactMethod
  public void addListener(String eventName) {}

  @ReactMethod
  public void removeListeners(Integer count) {}

  @ReactMethod
  public void enqueue(String taskId, String url, String treeUri, String fileName, String mimeType, ReadableMap headers, Promise promise) {
    Data.Builder input = new Data.Builder()
      .putString(MusicDownloadWorker.KEY_TASK_ID, taskId)
      .putString(MusicDownloadWorker.KEY_URL, url)
      .putString(MusicDownloadWorker.KEY_TREE_URI, treeUri)
      .putString(MusicDownloadWorker.KEY_FILE_NAME, fileName)
      .putString(MusicDownloadWorker.KEY_MIME_TYPE, mimeType);
    if (headers != null) {
      for (Map.Entry<String, Object> entry : headers.toHashMap().entrySet()) {
        if (entry.getValue() != null) input.putString("header_" + entry.getKey(), String.valueOf(entry.getValue()));
      }
    }
    Constraints constraints = new Constraints.Builder()
      .setRequiredNetworkType(NetworkType.CONNECTED)
      .build();
    OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(MusicDownloadWorker.class)
      .setInputData(input.build())
      .setConstraints(constraints)
      .addTag(MusicDownloadWorker.TAG)
      .addTag("lx-download-" + taskId)
      .build();
    WorkManager.getInstance(reactContext).enqueueUniqueWork(
      "lx-download-" + taskId,
      ExistingWorkPolicy.REPLACE,
      request
    );
    promise.resolve(request.getId().toString());
  }

  @ReactMethod
  public void pause(String workId, Promise promise) {
    try {
      WorkManager.getInstance(reactContext).cancelWorkById(UUID.fromString(workId));
      promise.resolve(null);
    } catch (IllegalArgumentException error) {
      promise.reject("invalid_work_id", error);
    }
  }

  @ReactMethod
  public void remove(String workId, String taskId, boolean deletePartial, Promise promise) {
    try {
      if (workId != null && !workId.isEmpty()) {
        WorkManager.getInstance(reactContext).cancelWorkById(UUID.fromString(workId));
      }
      if (deletePartial) {
        File partial = MusicDownloadWorker.getPartialFile(reactContext, taskId);
        if (partial.exists() && !partial.delete()) {
          promise.reject("delete_partial_failed", "Unable to delete partial download");
          return;
        }
      }
      promise.resolve(null);
    } catch (IllegalArgumentException error) {
      promise.reject("invalid_work_id", error);
    }
  }

  @ReactMethod
  public void getState(String workId, Promise promise) {
    try {
      WorkInfo info = WorkManager.getInstance(reactContext)
        .getWorkInfoById(UUID.fromString(workId))
        .get();
      promise.resolve(toMap(info));
    } catch (Exception error) {
      promise.reject("get_download_state_failed", error);
    }
  }

  private WritableMap toMap(WorkInfo info) {
    if (info == null) return null;
    WritableMap map = Arguments.createMap();
    map.putString("nativeId", info.getId().toString());
    Data data = info.getState().isFinished() ? info.getOutputData() : info.getProgress();
    String state;
    switch (info.getState()) {
      case RUNNING: state = "run"; break;
      case SUCCEEDED: state = "completed"; break;
      case FAILED: state = "error"; break;
      case CANCELLED: state = "pause"; break;
      default: state = "waiting";
    }
    map.putString("status", state);
    map.putDouble("downloaded", data.getLong(MusicDownloadWorker.KEY_DOWNLOADED, 0));
    map.putDouble("total", data.getLong(MusicDownloadWorker.KEY_TOTAL, 0));
    putString(map, "filePath", data.getString(MusicDownloadWorker.KEY_FILE_URI));
    putString(map, "fileName", data.getString(MusicDownloadWorker.KEY_FILE_NAME));
    putString(map, "error", data.getString(MusicDownloadWorker.KEY_ERROR));
    return map;
  }

  private void putString(WritableMap map, String key, String value) {
    if (value != null) map.putString(key, value);
  }
}
