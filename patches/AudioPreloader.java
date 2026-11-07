package com.guichaguri.trackplayer.service.player;

import androidx.media3.common.util.UnstableApi;
import androidx.media3.common.C;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.cache.CacheDataSource;
import androidx.media3.datasource.cache.Cache;
import androidx.media3.datasource.cache.ContentMetadata;
import androidx.media3.datasource.cache.SimpleCache;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.WritableMap;
import java.io.IOException;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/** 与播放器共用一个 SimpleCache；只保留一个后台任务，取消后缓存片段仍可供播放读取。 */
@UnstableApi
public final class AudioPreloader {
    private static volatile Future<?> pendingRelease;
    private final SimpleCache cache;
    private final long limit;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private Task active;
    private boolean closed;

    private static final class Task {
        final String id;
        volatile boolean cancelled;
        Thread worker;
        Task(String id) { this.id = id; }
        synchronized void cancel() {
            cancelled = true;
            if (worker != null) worker.interrupt();
        }
    }

    public AudioPreloader(SimpleCache cache, long maxCacheSize) {
        this.cache = cache;
        // 给当前播放保留空间；超大音频只预取可容纳的部分。
        this.limit = Math.min(64L * 1024 * 1024, maxCacheSize / 2);
    }

    public static void awaitRelease() {
        Future<?> release = pendingRelease;
        if (release == null) return;
        try { release.get(); } catch (Exception ignored) {}
        if (pendingRelease == release) pendingRelease = null;
    }

    public synchronized void preload(String id, String url, String userAgent, double maxBytes, Promise promise) {
        if (closed || limit <= 0) { promise.resolve(null); return; }
        if (active != null) active.cancel();
        Task task = new Task(id);
        active = task;
        long bytes = maxBytes > 0 ? Math.min(limit, (long) maxBytes) : limit;
        executor.execute(() -> run(task, url, userAgent, bytes, promise));
    }

    private void run(Task task, String url, String userAgent, long bytes, Promise promise) {
        synchronized (task) { task.worker = Thread.currentThread(); }
        try {
            if (task.cancelled) throw new IOException("cancelled");
            DefaultHttpDataSource.Factory upstream = new DefaultHttpDataSource.Factory()
                    .setUserAgent(userAgent)
                    .setAllowCrossProtocolRedirects(true)
                    .setConnectTimeoutMs(8000)
                    .setReadTimeoutMs(8000)
                    .setContentTypePredicate(type -> {
                        if (type == null) return true;
                        String value = type.toLowerCase(Locale.ROOT);
                        return !value.contains("text/html") && !value.contains("json") && !value.contains("mpegurl");
                    });
            CacheDataSource source = new CacheDataSource.Factory().setCache(cache)
                    .setUpstreamDataSourceFactory(upstream)
                    .setFlags(CacheDataSource.FLAG_BLOCK_ON_CACHE).createDataSource();
            long start = Math.max(0, cache.getCachedLength(url, 0, bytes));
            long knownLength = ContentMetadata.getContentLength(cache.getContentMetadata(url));
            if (start < bytes && !(knownLength >= 0 && start >= knownLength)) {
                // 显式限制读取量。CacheWriter 在有界请求失败时会重试无界请求，可能突破预取预算。
                DataSpec spec = new DataSpec.Builder().setUri(url).setPosition(start)
                        .setFlags(DataSpec.FLAG_ALLOW_CACHE_FRAGMENTATION).build();
                try {
                    if (task.cancelled) throw new IOException("cancelled");
                    source.open(spec);
                    byte[] buffer = new byte[32 * 1024];
                    long position = start;
                    while (position < bytes) {
                        if (task.cancelled) throw new IOException("cancelled");
                        int read = source.read(buffer, 0, (int) Math.min(buffer.length, bytes - position));
                        if (read == C.RESULT_END_OF_INPUT) break;
                        position += read;
                    }
                } finally { source.close(); }
            }
            if (task.cancelled) throw new IOException("cancelled");
            long cached = cache.getCachedBytes(url, 0, bytes);
            if (cached <= 0) throw new IOException("Empty audio resource");
            long length = ContentMetadata.getContentLength(cache.getContentMetadata(url));
            WritableMap result = Arguments.createMap();
            result.putDouble("cachedBytes", cached);
            result.putBoolean("complete", length > 0 && cache.isCached(url, 0, length));
            promise.resolve(result);
        } catch (Exception error) {
            if (!task.cancelled && error instanceof Cache.CacheException) {
                // 磁盘缓存不可写不代表音源失效，前台仍可以正常串流播放。
                promise.resolve(null);
            } else {
                promise.reject(task.cancelled ? "preload_cancelled" : "preload_failed", error.getMessage(), error);
            }
        } finally {
            synchronized (task) {
                task.worker = null;
                Thread.interrupted();
            }
            synchronized (this) { if (active == task) active = null; }
        }
    }

    public synchronized void cancel(String id) {
        if (active != null && active.id.equals(id)) active.cancel();
    }

    public synchronized void clear(Promise promise) {
        if (closed) { promise.resolve(null); return; }
        if (active != null) active.cancel();
        executor.execute(() -> {
            try {
                for (String key : cache.getKeys()) cache.removeResource(key);
                promise.resolve(null);
            } catch (Exception error) { promise.reject("cache_clear_failed", error); }
        });
    }

    public synchronized void release() {
        if (closed) return;
        closed = true;
        if (active != null) active.cancel();
        // 先关闭读写任务，再释放缓存目录的锁；快速重新初始化也要等待这一步。
        pendingRelease = executor.submit(() -> cache.release());
        executor.shutdown();
    }
}
