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
    volatile long contentLength = -1;
    volatile long audioOffset;
    volatile int largestRead;
    volatile String headerKind;
    volatile String method;
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
      if (contentLength >= 0) result.putDouble("contentLength", contentLength);
      result.putDouble("audioOffset", audioOffset);
      result.putInt("largestRead", largestRead);
      if (headerKind != null) result.putString("headerKind", headerKind);
      if (method != null) result.putString("method", method);
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

  private static String headerKind(byte[] header, int size) {
    if (size >= 4 && header[0] == 'f' && header[1] == 'L' && header[2] == 'a' && header[3] == 'C') return "flac";
    if (size >= 2 && (header[0] & 255) == 255 && (header[1] & 0xe0) == 0xe0 && (header[1] & 6) != 0) return "mp3";
    if (size >= 8 && header[4] == 'f' && header[5] == 't' && header[6] == 'y' && header[7] == 'p') return "mp4";
    if (size >= 4 && header[0] == 'O' && header[1] == 'g' && header[2] == 'g' && header[3] == 'S') return "ogg";
    return "unknown";
  }

  // STREAMINFO contains the sample count. As in MusicOne, no picture/comment blocks are needed.
  private static boolean readFlacHeader(byte[] header, int size, WritableMap result) {
    if (size < 42 || !"flac".equals(headerKind(header, size)) || (header[4] & 127) != 0 ||
        header[5] != 0 || header[6] != 0 || header[7] != 34) return false;
    long packed = 0;
    for (int index = 18; index <= 25; index++) packed = (packed << 8) | (header[index] & 255L);
    long sampleRate = (packed >>> 44) & 0xfffffL;
    long samples = packed & 0xfffffffffL;
    if (sampleRate == 0 || samples == 0) return false;
    result.putString("mime", "audio/flac");
    result.putDouble("durationMs", samples * 1000.0 / sampleRate);
    result.putInt("sampleRate", (int) sampleRate);
    result.putInt("bitDepth", (int) ((packed >>> 36) & 31) + 1);
    return true;
  }

  private static WritableMap read(Task task, String url, boolean inspectDuration) {
    WritableMap result = Arguments.createMap();
    HttpURLConnection connection = null;
    String resolvedUrl;
    byte[] head;
    long length = -1;
    try {
      // Seed the extractor's range cache with this same read; do not request the head twice.
      int count = inspectDuration ? (Build.VERSION.SDK_INT >= 23 ? BLOCK_SIZE : 42) : 1;
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
      task.contentLength = length;
      result.putBoolean("readable", true);
      task.check();
    } catch (Exception error) {
      return unavailable(task.reason(error, "network_error"));
    } finally {
      if (connection != null) connection.disconnect();
      task.connection = null;
    }
    if (!inspectDuration) return result;
    task.headerKind = headerKind(head, head.length);
    if (readFlacHeader(head, head.length, result)) {
      task.method = "flac_header";
      return result;
    }

    MediaExtractor extractor = new MediaExtractor();
    try {
      task.check();
      if (Build.VERSION.SDK_INT >= 23) {
        // Own the HTTP reads so cancellation/deadline also covers MediaExtractor.
        if (Api23.configure(extractor, task, resolvedUrl, length, head, result)) return result;
      } else {
        // API 21/22 has no MediaDataSource; the task watchdog still bounds the wait.
        task.method = "media_extractor";
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
    static boolean configure(MediaExtractor extractor, Task task, String url, long length, byte[] head, WritableMap result) throws IOException {
      RangeSource source = new RangeSource(task, url, length, head);
      task.source = source;
      task.check();
      // MediaExtractor also parses ID3 pictures/comments while initializing an MP3.
      // Present an audio-only view so large tags cannot exhaust the network budget.
      source.skipId3();
      byte[] audioHeader = new byte[42];
      int size = source.readAt(0, audioHeader, 0, audioHeader.length);
      task.headerKind = headerKind(audioHeader, size);
      if (readFlacHeader(audioHeader, size, result)) {
        task.method = "flac_header";
        return true;
      }
      if ("mp3".equals(task.headerKind) && readMp3Duration(source, task, result)) return true;
      task.method = "media_extractor";
      extractor.setDataSource(source);
      return false;
    }

    private static int readInt(byte[] bytes, int offset) {
      return ((bytes[offset] & 255) << 24) | ((bytes[offset + 1] & 255) << 16) |
          ((bytes[offset + 2] & 255) << 8) | (bytes[offset + 3] & 255);
    }

    private static final int[] MPEG1_RATES = {0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320};
    private static final int[] MPEG2_RATES = {0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160};
    private static final int[] SAMPLE_RATES = {44100, 48000, 32000};

    private static final class Mp3Frame {
      final int header;
      final int sampleRate;
      final int size;
      final int samples;
      final int xingOffset;

      Mp3Frame(int header, int version, int rateIndex, int sampleIndex) {
        this.header = header;
        sampleRate = SAMPLE_RATES[sampleIndex] / (version == 3 ? 1 : version == 2 ? 2 : 4);
        int bitRate = (version == 3 ? MPEG1_RATES : MPEG2_RATES)[rateIndex];
        samples = version == 3 ? 1152 : 576;
        size = (version == 3 ? 144000 : 72000) * bitRate / sampleRate + ((header >>> 9) & 1);
        boolean mono = ((header >>> 6) & 3) == 3;
        xingOffset = 4 + (version == 3 ? (mono ? 17 : 32) : (mono ? 9 : 17));
      }

      static Mp3Frame parse(byte[] bytes) {
        int header = readInt(bytes, 0);
        int version = (header >>> 19) & 3;
        int rateIndex = (header >>> 12) & 15;
        int sampleIndex = (header >>> 10) & 3;
        if ((header & 0xffe00000) != 0xffe00000 || version == 1 || ((header >>> 17) & 3) != 1 ||
            rateIndex == 0 || rateIndex == 15 || sampleIndex == 3) return null;
        return new Mp3Frame(header, version, rateIndex, sampleIndex);
      }
    }

    // Use the same Xing/VBRI frame-count calculation as Android's MP3 extractor, without
    // parsing artwork or building a seek table. Files without a frame count use MediaExtractor.
    private static boolean readMp3Duration(RangeSource source, Task task, WritableMap result) throws IOException {
      byte[] header = new byte[4];
      if (source.readAt(0, header, 0, header.length) != header.length) return false;
      Mp3Frame first = Mp3Frame.parse(header);
      if (first == null) return false;
      byte[] frame = new byte[first.size];
      if (source.readAt(0, frame, 0, frame.length) != frame.length) return false;
      long frames = 0;
      String method = null;
      int offset = first.xingOffset;
      if (frame.length >= offset + 12) {
        int signature = readInt(frame, offset);
        if ((signature == 0x58696e67 || signature == 0x496e666f) && (readInt(frame, offset + 4) & 1) != 0) {
          frames = readInt(frame, offset + 8) & 0xffffffffL;
          method = "mp3_xing";
        }
      }
      if (frames == 0 && frame.length >= 54 && readInt(frame, 36) == 0x56425249) {
        frames = readInt(frame, 50) & 0xffffffffL;
        method = "mp3_vbri";
      }
      if (frames < 4) return false;
      // A sync-looking prefix alone is insufficient. Require four consecutive MPEG frames.
      long position = first.size;
      for (int index = 0; index < 3; index++) {
        if (source.readAt(position, header, 0, header.length) != header.length) return false;
        Mp3Frame next = Mp3Frame.parse(header);
        if (next == null || (next.header & 0xfffe0c00) != (first.header & 0xfffe0c00)) return false;
        position += next.size;
      }
      task.method = method;
      result.putString("mime", "audio/mpeg");
      result.putDouble("durationMs", frames * first.samples * 1000.0 / first.sampleRate);
      result.putInt("sampleRate", first.sampleRate);
      return true;
    }

    private static final class RangeSource extends MediaDataSource {
      final Task task;
      final String url;
      final long length;
      // Sniffers repeatedly read small, overlapping headers. Keep up to four aligned windows.
      final LinkedHashMap<Long, byte[]> blocks = new LinkedHashMap<>(4, 0.75f, true);
      long audioStart;
      volatile boolean closed;

      RangeSource(Task task, String url, long length, byte[] head) {
        this.task = task;
        this.url = url;
        this.length = length;
        blocks.put(0L, head);
      }

      @Override public long getSize() { return length < 0 ? -1 : length - audioStart; }

      void skipId3() throws IOException {
        byte[] header = new byte[10];
        long position = 0;
        for (int tags = 0; tags <= 8; tags++) {
          int size = readOriginalAt(position, header, 0, header.length);
          if (size < header.length || header[0] != 'I' || header[1] != 'D' || header[2] != '3') {
            audioStart = position;
            task.audioOffset = position;
            return;
          }
          if (tags == 8) throw task.fail("metadata_limit");
          int version = header[3] & 255;
          if (version < 2 || version > 4 || (header[4] & 255) == 255) throw task.fail("invalid_metadata");
          long tagSize = 0;
          for (int index = 6; index < 10; index++) {
            if ((header[index] & 128) != 0) throw task.fail("invalid_metadata");
            tagSize = (tagSize << 7) | (header[index] & 127);
          }
          // ID3v2.4 size excludes its optional ten-byte footer as well as the header.
          position += 10 + tagSize + (version == 4 && (header[5] & 16) != 0 ? 10 : 0);
          if (length >= 0 && position >= length) throw task.fail("invalid_metadata");
        }
      }

      @Override public synchronized int readAt(long position, byte[] buffer, int offset, int size) throws IOException {
        if (position < 0 || position > Long.MAX_VALUE - audioStart) throw task.fail("invalid_range");
        task.largestRead = Math.max(task.largestRead, size);
        return readOriginalAt(audioStart + position, buffer, offset, size);
      }

      private int readOriginalAt(long position, byte[] buffer, int offset, int size) throws IOException {
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
