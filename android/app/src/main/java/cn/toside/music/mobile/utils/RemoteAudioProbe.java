package cn.toside.music.mobile.utils;

import android.annotation.TargetApi;
import android.media.MediaDataSource;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.os.Build;
import android.os.SystemClock;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.WritableMap;

import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Collections;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Future;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/** Bounded, cancellable probes. Signed URLs are never logged or saved. */
final class RemoteAudioProbe {
  private final ConcurrentHashMap<String, Task> tasks = new ConcurrentHashMap<>();
  private final ThreadPoolExecutor workers = new ThreadPoolExecutor(
      4, 4, 10, TimeUnit.SECONDS, new LinkedBlockingQueue<>(12));
  private final ScheduledExecutorService deadlines = Executors.newSingleThreadScheduledExecutor();

  RemoteAudioProbe() { workers.allowCoreThreadTimeOut(true); }

  void start(String id, String url, boolean inspect, double timeoutMs, Promise promise) {
    Task task = new Task(id, promise, Math.max(1, Math.min((long) timeoutMs, 5000)));
    Task previous = tasks.put(id, task);
    if (previous != null) previous.cancel();
    try {
      task.timer = deadlines.schedule(task::cancel, task.remaining(), TimeUnit.MILLISECONDS);
      task.work = workers.submit(() -> task.finish(read(task, url, inspect), false));
      if (task.done.get()) task.work.cancel(true);
    } catch (RuntimeException ignored) { task.cancel(); }
  }

  void cancel(String id) {
    Task task = tasks.get(id);
    if (task != null) task.cancel();
  }

  void close() {
    for (Task task : tasks.values()) task.cancel();
    workers.shutdownNow();
    deadlines.shutdownNow();
  }

  private static WritableMap unavailable() {
    WritableMap result = Arguments.createMap();
    result.putBoolean("readable", false);
    return result;
  }

  private final class Task {
    final String id;
    final Promise promise;
    final long deadline;
    final AtomicBoolean done = new AtomicBoolean();
    volatile HttpURLConnection connection;
    volatile Closeable source;
    volatile Future<?> work;
    volatile ScheduledFuture<?> timer;

    Task(String id, Promise promise, long timeoutMs) {
      this.id = id;
      this.promise = promise;
      deadline = SystemClock.elapsedRealtime() + timeoutMs;
    }

    long remaining() { return Math.max(1, deadline - SystemClock.elapsedRealtime()); }

    void check() throws IOException {
      if (done.get() || Thread.currentThread().isInterrupted() || SystemClock.elapsedRealtime() >= deadline) {
        throw new IOException("Audio probe cancelled or timed out");
      }
    }

    void cancel() { finish(unavailable(), true); }

    void finish(WritableMap result, boolean cancelWork) {
      if (!done.compareAndSet(false, true)) return;
      tasks.remove(id, this);
      if (timer != null) timer.cancel(false);
      // Resolve first: disposal of an Android network object must not delay JS fallback.
      promise.resolve(result);
      if (cancelWork) {
        if (work != null) work.cancel(true);
        HttpURLConnection activeConnection = connection;
        Closeable activeSource = source;
        if (activeConnection != null) activeConnection.disconnect();
        if (activeSource != null) try { activeSource.close(); } catch (IOException ignored) {}
        workers.purge();
      }
    }
  }

  private static HttpURLConnection open(Task task, String url, long position, int size) throws IOException {
    task.check();
    URL address = new URL(url);
    if (!"https".equals(address.getProtocol()) && !"http".equals(address.getProtocol())) throw new IOException("Invalid protocol");
    HttpURLConnection connection = (HttpURLConnection) address.openConnection();
    task.connection = connection;
    task.check();
    int timeout = (int) Math.min(task.remaining(), 1500);
    connection.setConnectTimeout(timeout);
    connection.setReadTimeout(timeout);
    connection.setInstanceFollowRedirects(true);
    connection.setRequestProperty("Range", "bytes=" + position + "-" + (position + size - 1));
    connection.setRequestProperty("Accept-Encoding", "identity");
    connection.setRequestProperty("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
    return connection;
  }

  private static WritableMap read(Task task, String url, boolean inspectDuration) {
    WritableMap result = unavailable();
    HttpURLConnection connection = null;
    String resolvedUrl;
    long length = -1;
    try {
      connection = open(task, url, 0, 1);
      int status = connection.getResponseCode();
      if (status < 200 || status >= 300) return result;
      // Close after the first byte even if the server ignores Range.
      try (InputStream stream = connection.getInputStream()) {
        if (stream.read() < 0) return result;
      }
      resolvedUrl = connection.getURL().toString();
      String range = connection.getHeaderField("Content-Range");
      String total = status == 206 && range != null ? range.substring(range.lastIndexOf('/') + 1) : connection.getHeaderField("Content-Length");
      try { length = Long.parseLong(total); } catch (Exception ignored) {}
      result.putBoolean("readable", true);
      task.check();
    } catch (Exception ignored) {
      return unavailable();
    } finally {
      if (connection != null) connection.disconnect();
      task.connection = null;
    }
    if (!inspectDuration) return result;

    MediaExtractor extractor = new MediaExtractor();
    try {
      task.check();
      if (Build.VERSION.SDK_INT >= 23) {
        // Own the HTTP reads so cancellation/deadline also covers MediaExtractor.
        Api23.configure(extractor, task, resolvedUrl, length);
      } else {
        // API 21/22 has no MediaDataSource; the task watchdog still bounds the wait.
        extractor.setDataSource(resolvedUrl, Collections.emptyMap());
      }
      task.check();
      for (int index = 0; index < extractor.getTrackCount(); index++) {
        MediaFormat format = extractor.getTrackFormat(index);
        String mime = format.getString(MediaFormat.KEY_MIME);
        if (mime == null || !mime.startsWith("audio/") || !format.containsKey(MediaFormat.KEY_DURATION)) continue;
        result.putString("mime", mime);
        result.putDouble("durationMs", format.getLong(MediaFormat.KEY_DURATION) / 1000.0);
        break;
      }
    } catch (Exception ignored) {
      // Unknown duration cannot establish that the track is complete.
    } finally {
      extractor.release();
      if (task.source != null) try { task.source.close(); } catch (IOException ignored) {}
    }
    return result;
  }

  @TargetApi(23)
  private static final class Api23 {
    static void configure(MediaExtractor extractor, Task task, String url, long length) throws IOException {
      RangeSource source = new RangeSource(task, url, length);
      task.source = source;
      task.check();
      extractor.setDataSource(source);
    }

    private static final class RangeSource extends MediaDataSource {
      final Task task;
      final String url;
      final long length;
      volatile boolean closed;
      int bytesRead;

      RangeSource(Task task, String url, long length) { this.task = task; this.url = url; this.length = length; }

      @Override public long getSize() { return length; }

      @Override public int readAt(long position, byte[] buffer, int offset, int size) throws IOException {
        task.check();
        if (closed) throw new IOException("Audio probe closed");
        if (size == 0) return 0;
        if (length >= 0 && position >= length) return -1;
        // Headers suffice for normal MP3/FLAC files. Never scan/download a whole song.
        int count = Math.min(size, Math.min(65536, 1048576 - bytesRead));
        if (count <= 0) throw new IOException("Audio probe byte limit");
        HttpURLConnection connection = null;
        try {
          connection = open(task, url, position, count);
          int status = connection.getResponseCode();
          if (status != 206 && !(status == 200 && position == 0)) throw new IOException("Audio range unavailable");
          if (status == 206) {
            String range = connection.getHeaderField("Content-Range");
            if (range == null || !range.startsWith("bytes " + position + "-")) throw new IOException("Invalid audio range");
          }
          try (InputStream stream = connection.getInputStream()) {
            int total = 0;
            while (total < count) {
              task.check();
              int read = stream.read(buffer, offset + total, count - total);
              if (read < 0) break;
              total += read;
            }
            task.check();
            bytesRead += total;
            return total > 0 ? total : -1;
          }
        } finally {
          if (connection != null) connection.disconnect();
          task.connection = null;
        }
      }

      @Override public void close() {
        closed = true;
        HttpURLConnection connection = task.connection;
        if (connection != null) connection.disconnect();
      }
    }
  }
}
