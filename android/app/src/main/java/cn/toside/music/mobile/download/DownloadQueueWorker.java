package cn.toside.music.mobile.download;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.ForegroundInfo;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.Operation;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import com.facebook.react.ReactApplication;
import com.facebook.react.ReactInstanceEventListener;
import com.facebook.react.ReactInstanceManager;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.ReactContext;
import com.facebook.react.bridge.UiThreadUtil;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.jstasks.HeadlessJsTaskConfig;
import com.facebook.react.jstasks.HeadlessJsTaskContext;
import com.facebook.react.jstasks.HeadlessJsTaskEventListener;
import com.google.common.util.concurrent.FutureCallback;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.MoreExecutors;

import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

// 原生完成时唤醒 JS 填补有限窗口，进程被杀后也不依赖页面重新打开。
public final class DownloadQueueWorker extends Worker {
  private static final String WORK_NAME = "lx-download-dispatch";
  private static final String TASK_NAME = "LXDownloadQueue";
  private static final String CHANNEL_ID = "music_downloads";
  private static final Object DISPATCH_LOCK = new Object();
  private static DownloadDispatchState state;
  private static final ConcurrentHashMap<String, Dispatch> RUNNING = new ConcurrentHashMap<>();
  private volatile Dispatch dispatch;
  private volatile ReactInstanceManager manager;
  private volatile ReactInstanceEventListener contextListener;

  public DownloadQueueWorker(@NonNull Context context, @NonNull WorkerParameters params) {
    super(context, params);
  }

  private static SharedPreferences preferences(Context context) {
    return context.getSharedPreferences("lx-download-dispatch", Context.MODE_PRIVATE);
  }

  private static DownloadDispatchState state(Context context) {
    if (state == null) {
      SharedPreferences saved = preferences(context);
      state = new DownloadDispatchState(saved.getLong("requested", 0), saved.getLong("completed", 0));
    }
    return state;
  }

  private static void persist(Context context) {
    if (!preferences(context).edit().putLong("requested", state.requested).putLong("completed", state.completed).commit()) {
      throw new IllegalStateException("Unable to persist download dispatch");
    }
  }

  static void schedule(Context context) {
    try {
      synchronized (DISPATCH_LOCK) {
        boolean enqueue = state(context).request();
        try { persist(context); } catch (RuntimeException error) { Log.w("LXDownload", "Unable to persist pending dispatch", error); }
        if (enqueue) enqueue(context);
      }
    } catch (RuntimeException error) {
      Log.w("LXDownload", "Unable to schedule download dispatch", error);
    }
  }

  public static void recoverPending(Context context) {
    try {
      synchronized (DISPATCH_LOCK) {
        if (state(context).recover()) enqueue(context);
      }
    } catch (RuntimeException error) {
      Log.w("LXDownload", "Unable to recover download dispatch", error);
    }
  }

  private static void enqueue(Context context) {
    try {
      OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(DownloadQueueWorker.class)
        .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
        .addTag(MusicDownloadWorker.TAG)
        .build();
      // 没有原生调度者时替换旧终态边缘的 work；queued 标记合并后续触发。
      Operation operation = WorkManager.getInstance(context).enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.REPLACE, request);
      Futures.addCallback(operation.getResult(), new FutureCallback<Operation.State.SUCCESS>() {
        @Override
        public void onSuccess(Operation.State.SUCCESS result) {}

        @Override
        public void onFailure(Throwable error) {
          synchronized (DISPATCH_LOCK) { if (!state(context).isActive()) state.enqueueFailed(); }
          Log.w("LXDownload", "Unable to enqueue download dispatch", error);
        }
      }, MoreExecutors.directExecutor());
    } catch (RuntimeException error) {
      state(context).enqueueFailed();
      throw error;
    }
  }

  static boolean complete(String token, boolean success) {
    Dispatch current = RUNNING.get(token);
    return current != null && current.finish(success);
  }

  static boolean isDispatching() {
    synchronized (DISPATCH_LOCK) { return state != null && state.isActive(); }
  }

  @NonNull
  @Override
  public Result doWork() {
    // 每次尝试用独立 token，旧 JS 回执不能完成新的重试。
    String owner = UUID.randomUUID().toString();
    synchronized (DISPATCH_LOCK) { state(getApplicationContext()).start(owner); }
    try {
      if (isStopped()) return Result.failure();
      setForegroundAsync(foreground()).get(20, TimeUnit.SECONDS);
      while (!isStopped()) {
        long generation;
        synchronized (DISPATCH_LOCK) { generation = state(getApplicationContext()).claim(); }
        if (!runDispatch()) return getRunAttemptCount() < 2 ? Result.retry() : Result.failure();
        synchronized (DISPATCH_LOCK) {
          // 新终态在当前 HeadlessTask 期间到达，就在原 work 内补跑一次。
          if (state.complete(owner, generation)) {
            persist(getApplicationContext());
            return Result.success();
          }
        }
      }
      return Result.failure();
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      return Result.failure();
    } catch (Exception error) {
      Log.w("LXDownload", "Download dispatch failed", error);
      return getRunAttemptCount() < 2 ? Result.retry() : Result.failure();
    } finally {
      synchronized (DISPATCH_LOCK) { state(getApplicationContext()).fail(owner); }
    }
  }

  private boolean runDispatch() throws InterruptedException {
    String token = UUID.randomUUID().toString();
    Dispatch current = new Dispatch(token);
    dispatch = current;
    RUNNING.put(token, current);
    try {
      UiThreadUtil.runOnUiThread(() -> startReactTask(current));
      return current.finished.await(120, TimeUnit.SECONDS) && current.success && !isStopped();
    } finally {
      current.finish(false);
      RUNNING.remove(token, current);
      dispatch = null;
      UiThreadUtil.runOnUiThread(() -> {
        if (manager != null && contextListener != null) manager.removeReactInstanceEventListener(contextListener);
        contextListener = null;
        if (current.context != null) {
          current.context.removeTaskEventListener(current);
          if (current.taskId >= 0 && current.context.isTaskRunning(current.taskId)) current.context.finishTask(current.taskId);
          current.context = null;
        }
        manager = null;
      });
    }
  }

  @Override
  public void onStopped() {
    super.onStopped();
    Dispatch current = dispatch;
    if (current != null) current.finish(false);
  }

  private void startReactTask(Dispatch current) {
    if (current.signalled.get() || isStopped()) return;
    try {
      ReactApplication application = (ReactApplication) getApplicationContext();
      manager = application.getReactNativeHost().getReactInstanceManager();
      ReactContext context = manager.getCurrentReactContext();
      if (context != null) {
        invokeTask(context, current);
        return;
      }
      contextListener = contextCreated -> {
        if (contextListener != null) manager.removeReactInstanceEventListener(contextListener);
        contextListener = null;
        invokeTask(contextCreated, current);
      };
      manager.addReactInstanceEventListener(contextListener);
      manager.createReactContextInBackground();
    } catch (RuntimeException error) {
      Log.w("LXDownload", "Unable to initialize download JS", error);
      current.finish(false);
    }
  }

  private void invokeTask(ReactContext context, Dispatch current) {
    if (current.signalled.get() || isStopped()) return;
    try {
      WritableMap data = Arguments.createMap();
      data.putString("workId", current.token);
      current.context = HeadlessJsTaskContext.getInstance(context);
      current.context.addTaskEventListener(current);
      current.taskId = current.context.startTask(new HeadlessJsTaskConfig(TASK_NAME, data, 90_000, true));
    } catch (RuntimeException error) {
      Log.w("LXDownload", "Unable to start download JS", error);
      current.finish(false);
    }
  }

  private ForegroundInfo foreground() {
    NotificationManager notifications = (NotificationManager) getApplicationContext().getSystemService(Context.NOTIFICATION_SERVICE);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      notifications.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "Music downloads", NotificationManager.IMPORTANCE_LOW));
    }
    NotificationCompat.Builder notification = new NotificationCompat.Builder(getApplicationContext(), CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentTitle("LX Music X")
      .setContentText("准备下载")
      .setOnlyAlertOnce(true)
      .setOngoing(true);
    return new ForegroundInfo(19999, notification.build());
  }

  private static final class Dispatch implements HeadlessJsTaskEventListener {
    final String token;
    final CountDownLatch finished = new CountDownLatch(1);
    final AtomicBoolean signalled = new AtomicBoolean();
    volatile boolean success;
    HeadlessJsTaskContext context;
    int taskId = -1;

    Dispatch(String token) { this.token = token; }

    boolean finish(boolean result) {
      if (!signalled.compareAndSet(false, true)) return false;
      success = result;
      finished.countDown();
      return true;
    }

    @Override
    public void onHeadlessJsTaskStart(int id) {}

    @Override
    public void onHeadlessJsTaskFinish(int id) {
      // RN 超时结束不等于下载准备成功；只有 JS 明确回执才是成功。
      if (id == taskId) finish(false);
    }
  }
}
