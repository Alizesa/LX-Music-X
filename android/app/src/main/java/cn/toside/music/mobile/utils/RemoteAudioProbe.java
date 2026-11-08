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
import java.net.SocketTimeoutException;
import java.net.URL;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
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
  // Match src/plugins/player/playList.ts: proxies may serve different audio by User-Agent.
  private static final String USER_AGENT = "Mozilla/5.0 (Linux; Android 10; Pixel 3) AppleWebKit/537.36 "
      + "(KHTML, like Gecko) Chrome/79.0.3945.79 Mobile Safari/537.36";
  private static final int BLOCK_SIZE = 64 * 1024;
  private static final int BYTE_LIMIT = 1024 * 1024;
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
      task.timer = deadlines.schedule(() -> task.cancel("timeout"), task.remaining(), TimeUnit.MILLISECONDS);
      task.work = workers.submit(() -> task.finish(read(task, url, inspect), false));
      if (task.done.get()) task.work.cancel(true);
    } catch (RuntimeException ignored) { task.cancel("busy"); }
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

  private static WritableMap unavailable(String reason) {
    WritableMap result = Arguments.createMap();
    result.putBoolean("readable", false);
    result.putString("reason", reason);
    return result;
  }

  private final class Task {
    final String id;
    final Promise promise;
    final long started = SystemClock.elapsedRealtime();
    final long deadline;
    final AtomicBoolean done = new AtomicBoolean();
    volatile HttpURLConnection connection;
    volatile Closeable source;
    volatile Future<?> work;
    volatile ScheduledFuture<?> timer;
    volatile int requests;
    volatile int bytesRead;
    volatile int httpStatus;
    volatile String failureReason;

    Task(String id, Promise promise, long timeoutMs) {
      this.id = id;
      this.promise = promise;
      deadline = started + timeoutMs;
    }

    long remaining() { return Math.max(1, deadline - SystemClock.elapsedRealtime()); }

    void check() throws IOException {
      if (SystemClock.elapsedRealtime() >= deadline) throw fail("timeout");
      if (done.get() || Thread.currentThread().isInterrupted()) throw fail("cancelled");
    }

    IOException fail(String reason) {
      failureReason = reason;
      return new IOException(reason);
    }

    String reason(Exception error, String fallback) {
      if (failureReason != null) return failureReason;
      return error instanceof SocketTimeoutException ? "timeout" : fallback;
    }

    void cancel() { cancel("cancelled"); }

    void cancel(String reason) { finish(unavailable(reason), true); }

    void finish(WritableMap result, boolean cancelWork) {
      if (!done.compareAndSet(false, true)) return;
      tasks.remove(id, this);
      if (timer != null) timer.cancel(false);
      result.putInt("requests", requests);
      result.putInt("bytesRead", bytesRead);
      if (httpStatus > 0) result.putInt("httpStatus", httpStatus);
      result.putDouble("elapsedMs", SystemClock.elapsedRealtime() - started);
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
    if (!"https".equals(address.getProtocol()) && !"http".equals(address.getProtocol())) throw task.fail("invalid_protocol");
    HttpURLConnection connection = (HttpURLConnection) address.openConnection();
    task.connection = connection;
    task.check();
    task.requests++;
    int timeout = (int) Math.min(task.remaining(), 1500);
    connection.setConnectTimeout(timeout);
    connection.setReadTimeout(timeout);
    connection.setInstanceFollowRedirects(true);
    connection.setRequestProperty("Range", "bytes=" + position + "-" + (position + size - 1));
    connection.setRequestProperty("Accept-Encoding", "identity");
    connection.setRequestProperty("User-Agent", USER_AGENT);
    return connection;
  }

  private static void checkRange(Task task, HttpURLConnection connection, long position) throws IOException {
    String range = connection.getHeaderField("Content-Range");
    if (range == null || !range.startsWith("bytes " + position + "-")) throw task.fail("invalid_range");
  }

  private static byte[] readBlock(Task task, HttpURLConnection connection, int size) throws IOException {
    int count = Math.min(size, BYTE_LIMIT - task.bytesRead);
    if (count <= 0) throw task.fail("byte_limit");
    byte[] buffer = new byte[count];
    int total = 0;
    try (InputStream stream = connection.getInputStream()) {
      while (total < count) {
        task.check();
        int read = stream.read(buffer, total, count - total);
        if (read < 0) break;
        total += read;
        task.bytesRead += read;
      }
      task.check();
    }
    return total == count ? buffer : Arrays.copyOf(buffer, total);
  }

  private static WritableMap read(Task task, String url, boolean inspectDuration) {
    WritableMap result = Arguments.createMap();
    HttpURLConnection connection = null;
    String resolvedUrl;
    byte[] head;
    long length = -1;
    try {
      // Seed the extractor's range cache with this same read; do not request the head twice.
      int count = inspectDuration && Build.VERSION.SDK_INT >= 23 ? BLOCK_SIZE : 1;
      connection = open(task, url, 0, count);
      int status = connection.getResponseCode();
      task.httpStatus = status;
      if (status < 200 || status >= 300) return unavailable("http_error");
      if (status == 206) checkRange(task, connection, 0);
      // Remains bounded even if the server ignores Range. Readability-only checks need one byte.
      head = readBlock(task, connection, count);
      if (head.length == 0) return unavailable("empty");
      resolvedUrl = connection.getURL().toString();
      String range = connection.getHeaderField("Content-Range");
      String total = status == 206 && range != null ? range.substring(range.lastIndexOf('/') + 1) : connection.getHeaderField("Content-Length");
      try { length = Long.parseLong(total); } catch (Exception ignored) {}
      result.putBoolean("readable", true);
      task.check();
    } catch (Exception error) {
      return unavailable(task.reason(error, "network_error"));
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
        Api23.configure(extractor, task, resolvedUrl, length, head);
      } else {
        // API 21/22 has no MediaDataSource; the task watchdog still bounds the wait.
        extractor.setDataSource(resolvedUrl, Collections.singletonMap("User-Agent", USER_AGENT));
      }
      task.check();
      boolean foundDuration = false;
      for (int index = 0; index < extractor.getTrackCount(); index++) {
        MediaFormat format = extractor.getTrackFormat(index);
        String mime = format.getString(MediaFormat.KEY_MIME);
        if (mime == null || !mime.startsWith("audio/")) continue;
        result.putString("mime", mime);
        if (format.containsKey(MediaFormat.KEY_DURATION)) {
          double durationMs = format.getLong(MediaFormat.KEY_DURATION) / 1000.0;
          result.putDouble("durationMs", durationMs);
          if (durationMs > 0) { foundDuration = true; break; }
        }
      }
      if (!foundDuration) result.putString("reason", task.failureReason != null ? task.failureReason : "metadata_unavailable");
    } catch (Exception error) {
      result.putString("reason", task.reason(error, "metadata_error"));
    } finally {
      extractor.release();
      if (task.source != null) try { task.source.close(); } catch (IOException ignored) {}
    }
    return result;
  }

  @TargetApi(23)
  private static final class Api23 {
    static void configure(MediaExtractor extractor, Task task, String url, long length, byte[] head) throws IOException {
      RangeSource source = new RangeSource(task, url, length, head);
      task.source = source;
      task.check();
      extractor.setDataSource(source);
    }

    private static final class RangeSource extends MediaDataSource {
      final Task task;
      final String url;
      final long length;
      // Sniffers repeatedly read small, overlapping headers. Keep up to four aligned windows.
      final LinkedHashMap<Long, byte[]> blocks = new LinkedHashMap<>(4, 0.75f, true);
      volatile boolean closed;

      RangeSource(Task task, String url, long length, byte[] head) {
        this.task = task;
        this.url = url;
        this.length = length;
        blocks.put(0L, head);
      }

      @Override public long getSize() { return length; }

      @Override public synchronized int readAt(long position, byte[] buffer, int offset, int size) throws IOException {
        task.check();
        if (closed) throw task.fail("cancelled");
        if (position < 0) throw task.fail("invalid_range");
        if (size == 0) return 0;
        int total = 0;
        while (total < size) {
          task.check();
          long cursor = position + total;
          if (length >= 0 && cursor >= length) break;
          long start = cursor - cursor % BLOCK_SIZE;
          byte[] block = blocks.get(start);
          if (block == null) {
            block = loadBlock(start);
            blocks.put(start, block);
            if (blocks.size() > 4) blocks.remove(blocks.keySet().iterator().next());
          }
          int within = (int) (cursor - start);
          int count = Math.min(size - total, block.length - within);
          if (count <= 0) break;
          System.arraycopy(block, within, buffer, offset + total, count);
          total += count;
        }
        return total > 0 ? total : -1;
      }

      private byte[] loadBlock(long position) throws IOException {
        // Headers and occasional tail reads suffice. Count downloaded bytes, not cache hits.
        int count = Math.min(BLOCK_SIZE, BYTE_LIMIT - task.bytesRead);
        if (count <= 0) throw task.fail("byte_limit");
        if (length >= 0) count = (int) Math.min(count, length - position);
        HttpURLConnection connection = null;
        try {
          connection = open(task, url, position, count);
          int status = connection.getResponseCode();
          task.httpStatus = status;
          if (status < 200 || status >= 300) throw task.fail("http_error");
          if (status != 206 && !(status == 200 && position == 0)) throw task.fail("range_unsupported");
          if (status == 206) checkRange(task, connection, position);
          return readBlock(task, connection, count);
        } catch (IOException error) {
          task.failureReason = task.reason(error, "network_error");
          throw error;
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
