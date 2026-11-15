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
import androidx.work.Operation;
import androidx.work.WorkInfo;
import androidx.work.WorkManager;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.modules.core.DeviceEventManagerModule;
import com.google.common.util.concurrent.FutureCallback;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.MoreExecutors;
import com.google.common.util.concurrent.ListenableFuture;

import java.io.File;
import java.util.Map;
import java.util.HashMap;
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
  public Map<String, Object> getConstants() {
    Map<String, Object> constants = new HashMap<>();
    constants.put("downloadHeadlessBoot", DownloadQueueWorker.isDispatching() && reactContext.getCurrentActivity() == null);
    return constants;
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
    Operation operation = WorkManager.getInstance(reactContext).enqueueUniqueWork(
      "lx-download-" + taskId,
      ExistingWorkPolicy.REPLACE,
      request
    );
    Futures.addCallback(operation.getResult(), new FutureCallback<Operation.State.SUCCESS>() {
      @Override
      public void onSuccess(Operation.State.SUCCESS result) {
        promise.resolve(request.getId().toString());
      }

      @Override
      public void onFailure(Throwable error) {
        promise.reject("enqueue_download_failed", error);
      }
    }, MoreExecutors.directExecutor());
  }

  @ReactMethod
  public void pause(String workId, Promise promise) {
    cancelAndWait(workId, null, false, promise);
  }

  @ReactMethod
  public void remove(String workId, String taskId, boolean deletePartial, Promise promise) {
    cancelAndWait(workId, taskId, deletePartial, promise);
  }

  private void cancelAndWait(String workId, String taskId, boolean deletePartial, Promise promise) {
    try {
      WorkManager manager = WorkManager.getInstance(reactContext);
      Operation operation;
      if (workId != null && !workId.isEmpty()) {
        operation = manager.cancelWorkById(UUID.fromString(workId));
      } else if (taskId != null && !taskId.isEmpty()) {
        operation = manager.cancelUniqueWork("lx-download-" + taskId);
      } else {
        promise.reject("invalid_work_id", "Missing download identity");
        return;
      }
      Futures.addCallback(operation.getResult(), new FutureCallback<Operation.State.SUCCESS>() {
        @Override
        public void onSuccess(Operation.State.SUCCESS result) {
          Futures.addCallback(MusicDownloadWorker.whenStopped(workId, taskId), new FutureCallback<Void>() {
            @Override
            public void onSuccess(Void ignored) {
              try {
                ListenableFuture<?> cleanup = workId != null && !workId.isEmpty()
                  ? DownloadCleanupStore.cleanupWork(reactContext, workId, MusicDownloadWorker::isRunning)
                  : DownloadCleanupStore.cleanupTask(reactContext, taskId, MusicDownloadWorker::isRunning);
                Futures.addCallback(cleanup, new FutureCallback<Object>() {
                  @Override
                  public void onSuccess(Object cleaned) {
                    if (Boolean.FALSE.equals(cleaned)) {
                      promise.reject("cancel_download_failed", "A previous destination is still being written");
                      return;
                    }
                    try {
                      if (deletePartial) {
                        if (!DownloadPartialStore.clear(reactContext, taskId, workId)) {
                          promise.reject("delete_partial_failed", "Unable to delete partial download");
                          return;
                        }
                      }
                      promise.resolve(null);
                    } catch (Exception error) {
                      promise.reject("cancel_download_failed", error);
                    }
                  }

                  @Override
                  public void onFailure(Throwable error) { promise.reject("cancel_download_failed", error); }
                }, MoreExecutors.directExecutor());
              } catch (Exception error) {
                promise.reject("cancel_download_failed", error);
              }
            }

            @Override
            public void onFailure(Throwable error) {
              promise.reject("cancel_download_failed", error);
            }
          }, MoreExecutors.directExecutor());
        }

        @Override
        public void onFailure(Throwable error) {
          promise.reject("cancel_download_failed", error);
        }
      }, MoreExecutors.directExecutor());
    } catch (IllegalArgumentException error) {
      promise.reject("invalid_work_id", error);
    } catch (Exception error) {
      promise.reject("cancel_download_failed", error);
    }
  }

  @ReactMethod
  public void getState(String workId, Promise promise) {
    try {
      Data completion = DownloadCompletionStore.read(reactContext, workId);
      if (completion != null) {
        promise.resolve(completionMap(workId, completion));
        return;
      }
      Futures.addCallback(WorkManager.getInstance(reactContext).getWorkInfoById(UUID.fromString(workId)),
        new FutureCallback<WorkInfo>() {
          @Override
          public void onSuccess(WorkInfo info) {
            promise.resolve(toMap(info));
          }

          @Override
          public void onFailure(Throwable error) {
            promise.reject("get_download_state_failed", error);
          }
        }, MoreExecutors.directExecutor());
    } catch (Exception error) {
      promise.reject("get_download_state_failed", error);
    }
  }

  @ReactMethod
  public void acknowledgeCompletion(String workId, Promise promise) {
    try {
      Data receipt = DownloadCompletionStore.read(reactContext, workId);
      if (receipt != null && !DownloadPartialStore.clear(reactContext, receipt.getString(MusicDownloadWorker.KEY_TASK_ID), workId)) {
        promise.reject("ack_download_completion_failed", "Unable to remove completed partial download");
        return;
      }
      DownloadCleanupStore.finishCompleted(reactContext, workId);
      DownloadCompletionStore.acknowledge(reactContext, workId);
      promise.resolve(null);
    } catch (Exception error) {
      promise.reject("ack_download_completion_failed", error);
    }
  }

  @ReactMethod
  public void getCompletionIds(Promise promise) {
    try {
      WritableArray result = Arguments.createArray();
      for (String workId : DownloadCompletionStore.ids(reactContext)) {
        Data data = DownloadCompletionStore.read(reactContext, workId);
        if (data == null) continue;
        WritableMap identity = Arguments.createMap();
        identity.putString("nativeId", workId);
        identity.putString("taskId", data.getString(MusicDownloadWorker.KEY_TASK_ID));
        result.pushMap(identity);
      }
      promise.resolve(result);
    } catch (Exception error) {
      promise.reject("get_download_completions_failed", error);
    }
  }

  private WritableMap completionMap(String workId, Data data) {
    WritableMap map = Arguments.createMap();
    map.putString("nativeId", workId);
    map.putString("taskId", data.getString(MusicDownloadWorker.KEY_TASK_ID));
    map.putString("status", "completed");
    map.putDouble("downloaded", data.getLong(MusicDownloadWorker.KEY_DOWNLOADED, 0));
    map.putDouble("total", data.getLong(MusicDownloadWorker.KEY_TOTAL, 0));
    putString(map, "filePath", data.getString(MusicDownloadWorker.KEY_FILE_URI));
    putString(map, "fileName", data.getString(MusicDownloadWorker.KEY_FILE_NAME));
    return map;
  }

  @ReactMethod
  public void finishQueueDispatch(String token, boolean success, Promise promise) {
    DownloadQueueWorker.complete(token, success);
    promise.resolve(null);
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
