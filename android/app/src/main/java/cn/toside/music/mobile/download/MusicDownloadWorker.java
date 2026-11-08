package cn.toside.music.mobile.download;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.documentfile.provider.DocumentFile;
import androidx.work.Data;
import androidx.work.ForegroundInfo;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Semaphore;

public class MusicDownloadWorker extends Worker {
  public static final String ACTION_UPDATE = "io.github.alizesa.lxmusicx.DOWNLOAD_UPDATE";
  public static final String TAG = "lx-music-download";
  public static final String KEY_TASK_ID = "taskId";
  public static final String KEY_URL = "url";
  public static final String KEY_TREE_URI = "treeUri";
  public static final String KEY_FILE_NAME = "fileName";
  public static final String KEY_MIME_TYPE = "mimeType";
  public static final String KEY_DOWNLOADED = "downloaded";
  public static final String KEY_TOTAL = "total";
  public static final String KEY_FILE_URI = "filePath";
  public static final String KEY_ERROR = "error";
  private static final String CHANNEL_ID = "music_downloads";
  private static final Semaphore DOWNLOAD_SLOTS = new Semaphore(2, true);
  private static final ConcurrentHashMap<String, MusicDownloadWorker> RUNNING = new ConcurrentHashMap<>();
  private final CountDownLatch finished = new CountDownLatch(1);
  private final Object lifecycle = new Object();
  private Thread workerThread;
  private volatile HttpURLConnection currentConnection;
  private boolean notificationChannelCreated = false;

  public MusicDownloadWorker(@NonNull Context context, @NonNull WorkerParameters params) {
    super(context, params);
  }

  @NonNull
  @Override
  public Result doWork() {
    RUNNING.put(getId().toString(), this);
    synchronized (lifecycle) { workerThread = Thread.currentThread(); }
    String taskId = value(KEY_TASK_ID);
    String sourceUrl = value(KEY_URL);
    String treeUri = value(KEY_TREE_URI);
    String requestedFileName = value(KEY_FILE_NAME);
    String mimeType = value(KEY_MIME_TYPE);
    boolean acquired = false;
    boolean completed = false;
    Destination destination = null;
    try {
      throwIfStopped();
      DOWNLOAD_SLOTS.acquire();
      acquired = true;
      throwIfStopped();
      setForegroundAsync(createForegroundInfo(requestedFileName, 0, 0));
      sendUpdate(taskId, "run", 0, 0, null, null, requestedFileName);
      File partial = getPartialFile(getApplicationContext(), taskId);
      File parent = partial.getParentFile();
      if (parent != null && !parent.exists() && !parent.mkdirs()) throw new IOException("Unable to create download directory");
      long total = download(sourceUrl, partial, taskId, requestedFileName);
      throwIfStopped();
      destination = copyToDestination(partial, treeUri, requestedFileName, mimeType);
      throwIfStopped();
      if (!partial.delete()) partial.deleteOnExit();
      Data output = progressData(total, total)
        .putString(KEY_FILE_URI, destination.uri)
        .putString(KEY_FILE_NAME, destination.fileName)
        .build();
      sendUpdate(taskId, "completed", total, total, destination.uri, null, destination.fileName);
      completed = true;
      return Result.success(output);
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      return Result.failure(errorData(error));
    } catch (Exception error) {
      if (isStopped()) return Result.failure(errorData(error));
      if (getRunAttemptCount() < 2) return Result.retry();
      sendUpdate(taskId, "error", 0, 0, null, error.getMessage(), requestedFileName);
      return Result.failure(errorData(error));
    } finally {
      try {
        if (!completed && destination != null) destination.file.delete();
      } finally {
        if (acquired) DOWNLOAD_SLOTS.release();
        synchronized (lifecycle) { workerThread = null; }
        RUNNING.remove(getId().toString(), this);
        finished.countDown();
      }
    }
  }

  @Override
  public void onStopped() {
    super.onStopped();
    synchronized (lifecycle) {
      if (workerThread != null) workerThread.interrupt();
    }
    HttpURLConnection connection = currentConnection;
    if (connection != null) {
      try { connection.disconnect(); } catch (Exception ignored) {}
    }
  }

  // WorkManager 的取消完成只代表状态已变更；模块还要等这里的文件流全部关闭。
  public static void awaitStopped(String workId, String taskId) throws InterruptedException {
    for (MusicDownloadWorker worker : RUNNING.values()) {
      if (workId != null && !workId.isEmpty()
          ? worker.getId().toString().equals(workId)
          : worker.value(KEY_TASK_ID).equals(taskId)) {
        worker.finished.await();
      }
    }
  }

  private void throwIfStopped() throws IOException {
    if (isStopped() || Thread.currentThread().isInterrupted()) throw new IOException("Download cancelled");
  }

  private long download(String sourceUrl, File partial, String taskId, String fileName) throws IOException {
    long existing = partial.exists() ? partial.length() : 0;
    HttpURLConnection connection = openConnection(sourceUrl, existing);
    try {
      int status = connection.getResponseCode();
      if (existing > 0 && status != HttpURLConnection.HTTP_PARTIAL) {
        throwIfStopped();
        connection.disconnect();
        existing = 0;
        if (partial.exists() && !partial.delete()) throw new IOException("Unable to restart partial download");
        connection = openConnection(sourceUrl, 0);
        status = connection.getResponseCode();
      }
      if (status < 200 || status >= 300) throw new IOException("HTTP " + status);
      // URLConnection.getContentLengthLong() 要求 API 24；应用仍支持 Android 6。
      long contentLength = -1;
      String lengthHeader = connection.getHeaderField("Content-Length");
      if (lengthHeader != null) {
        try { contentLength = Long.parseLong(lengthHeader.trim()); } catch (NumberFormatException ignored) {}
      }
      long total = contentLength > 0 ? existing + contentLength : 0;
      long downloaded = existing;
      long lastUpdate = 0;
      throwIfStopped();
      try (
        BufferedInputStream input = new BufferedInputStream(connection.getInputStream());
        BufferedOutputStream output = new BufferedOutputStream(new FileOutputStream(partial, existing > 0))
      ) {
        byte[] buffer = new byte[64 * 1024];
        int count;
        while ((count = input.read(buffer)) != -1) {
          throwIfStopped();
          output.write(buffer, 0, count);
          downloaded += count;
          long now = System.currentTimeMillis();
          if (now - lastUpdate >= 1000) {
            publishProgress(taskId, fileName, downloaded, total);
            lastUpdate = now;
          }
        }
        throwIfStopped();
        output.flush();
      }
      throwIfStopped();
      publishProgress(taskId, fileName, downloaded, total > 0 ? total : downloaded);
      return downloaded;
    } finally {
      connection.disconnect();
      currentConnection = null;
    }
  }

  private HttpURLConnection openConnection(String sourceUrl, long offset) throws IOException {
    throwIfStopped();
    HttpURLConnection connection = (HttpURLConnection) new URL(sourceUrl).openConnection();
    connection.setConnectTimeout(15000);
    connection.setReadTimeout(30000);
    connection.setInstanceFollowRedirects(true);
    connection.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Mobile Safari/537.36");
    for (Map.Entry<String, Object> entry : getInputData().getKeyValueMap().entrySet()) {
      if (entry.getKey().startsWith("header_") && entry.getValue() != null) {
        connection.setRequestProperty(entry.getKey().substring(7), String.valueOf(entry.getValue()));
      }
    }
    if (offset > 0) connection.setRequestProperty("Range", "bytes=" + offset + "-");
    currentConnection = connection;
    if (isStopped()) {
      connection.disconnect();
      throw new IOException("Download cancelled");
    }
    return connection;
  }

  private Destination copyToDestination(File partial, String treeUri, String requestedFileName, String mimeType) throws IOException {
    throwIfStopped();
    DocumentFile directory = DocumentFile.fromTreeUri(getApplicationContext(), Uri.parse(treeUri));
    if (directory == null || !directory.canWrite()) throw new IOException("Download directory is not writable");
    String fileName = availableName(directory, requestedFileName);
    throwIfStopped();
    DocumentFile destination = directory.createFile(mimeType, fileName);
    if (destination == null) throw new IOException("Unable to create destination file");
    boolean copied = false;
    try {
      try (
        BufferedInputStream input = new BufferedInputStream(new FileInputStream(partial));
        OutputStream rawOutput = getApplicationContext().getContentResolver().openOutputStream(destination.getUri(), "w");
        BufferedOutputStream output = rawOutput == null ? null : new BufferedOutputStream(rawOutput)
      ) {
        if (output == null) throw new IOException("Unable to open destination file");
        byte[] buffer = new byte[64 * 1024];
        int count;
        while ((count = input.read(buffer)) != -1) {
          throwIfStopped();
          output.write(buffer, 0, count);
        }
        throwIfStopped();
        output.flush();
      }
      throwIfStopped();
      copied = true;
      return new Destination(destination, fileName);
    } finally {
      if (!copied) destination.delete();
    }
  }

  private String availableName(DocumentFile directory, String requestedName) throws IOException {
    if (directory.findFile(requestedName) == null) return requestedName;
    int dot = requestedName.lastIndexOf('.');
    String stem = dot > 0 ? requestedName.substring(0, dot) : requestedName;
    String extension = dot > 0 ? requestedName.substring(dot) : "";
    for (int index = 1; index < 10000; index++) {
      throwIfStopped();
      String candidate = stem + " (" + index + ")" + extension;
      if (directory.findFile(candidate) == null) return candidate;
    }
    return stem + " (" + System.currentTimeMillis() + ")" + extension;
  }

  private void publishProgress(String taskId, String fileName, long downloaded, long total) {
    setProgressAsync(progressData(downloaded, total).putString(KEY_FILE_NAME, fileName).build());
    setForegroundAsync(createForegroundInfo(fileName, downloaded, total));
    sendUpdate(taskId, "run", downloaded, total, null, null, fileName);
  }

  private Data.Builder progressData(long downloaded, long total) {
    return new Data.Builder().putLong(KEY_DOWNLOADED, downloaded).putLong(KEY_TOTAL, total);
  }

  private Data errorData(Exception error) {
    return new Data.Builder().putString(KEY_ERROR, error.getMessage()).build();
  }

  private ForegroundInfo createForegroundInfo(String fileName, long downloaded, long total) {
    NotificationManager manager = (NotificationManager) getApplicationContext().getSystemService(Context.NOTIFICATION_SERVICE);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !notificationChannelCreated) {
      manager.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "Music downloads", NotificationManager.IMPORTANCE_LOW));
      notificationChannelCreated = true;
    }
    int max = total > 0 ? 100 : 0;
    int progress = total > 0 ? (int) Math.min(100, downloaded * 100 / total) : 0;
    NotificationCompat.Builder notification = new NotificationCompat.Builder(getApplicationContext(), CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentTitle("LX Music X")
      .setContentText(fileName)
      .setOnlyAlertOnce(true)
      .setOngoing(true)
      .setProgress(max, progress, total <= 0);
    return new ForegroundInfo(20000 + Math.abs(value(KEY_TASK_ID).hashCode() % 10000), notification.build());
  }

  private void sendUpdate(String taskId, String status, long downloaded, long total, String filePath, String error, String fileName) {
    Intent intent = new Intent(ACTION_UPDATE).setPackage(getApplicationContext().getPackageName());
    intent.putExtra(KEY_TASK_ID, taskId);
    intent.putExtra("nativeId", getId().toString());
    intent.putExtra("status", status);
    intent.putExtra(KEY_DOWNLOADED, downloaded);
    intent.putExtra(KEY_TOTAL, total);
    if (filePath != null) intent.putExtra(KEY_FILE_URI, filePath);
    if (error != null) intent.putExtra(KEY_ERROR, error);
    if (fileName != null) intent.putExtra(KEY_FILE_NAME, fileName);
    getApplicationContext().sendBroadcast(intent);
  }

  private String value(String key) {
    String value = getInputData().getString(key);
    return value == null ? "" : value;
  }

  public static File getPartialFile(Context context, String taskId) {
    return new File(new File(context.getFilesDir(), "downloads"), taskId + ".part");
  }

  private static class Destination {
    final DocumentFile file;
    final String uri;
    final String fileName;

    Destination(DocumentFile file, String fileName) {
      this.file = file;
      this.uri = file.getUri().toString();
      this.fileName = fileName;
    }
  }
}
