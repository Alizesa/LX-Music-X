package com.guichaguri.trackplayer.service.player;

import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.cache.Cache;
import androidx.media3.datasource.cache.CacheSpan;
import androidx.media3.datasource.cache.ContentMetadata;
import androidx.media3.datasource.cache.ContentMetadataMutations;
import androidx.media3.datasource.cache.SimpleCache;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.LinkedHashMap;

/** Read-only view for the app's media inspector. Never instantiate a second cache or open an upstream. */
@UnstableApi
public final class CompleteAudioCache {
    private static final String ALIAS = "lx.redirectSourceHash";
    private static volatile CompleteAudioCache current;
    private final SimpleCache cache;
    private final LinkedHashMap<String, String> pending = new LinkedHashMap<>();
    private final LinkedHashMap<String, String> aliases = new LinkedHashMap<>();
    private boolean indexed;

    private CompleteAudioCache(SimpleCache cache) { this.cache = cache; }
    static void attach(SimpleCache cache) { current = new CompleteAudioCache(cache); }
    static void reset(SimpleCache cache, boolean release) {
        synchronized (cache) {
            CompleteAudioCache view = current;
            if (view == null || view.cache != cache) return;
            for (String key : view.pending.keySet()) cache.removeListener(key, view.listener);
            view.pending.clear(); view.aliases.clear(); view.indexed = false;
            if (release) current = null;
        }
    }
    private static String fingerprint(String source) {
        try { return android.util.Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(source.getBytes(StandardCharsets.UTF_8)), android.util.Base64.NO_WRAP); }
        catch (NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }
    private void alias(String hash, String url) {
        aliases.remove(hash); aliases.put(hash, url);
        if (aliases.size() > 256) aliases.remove(aliases.keySet().iterator().next());
    }
    private void saveAlias(String hash, String url) {
        alias(hash, url);
        if (hash.equals(cache.getContentMetadata(url).get(ALIAS, ""))) return;
        try { cache.applyContentMetadataMutations(url, new ContentMetadataMutations().set(ALIAS, hash)); }
        catch (Cache.CacheException ignored) {} // A missing hint never certifies bytes or blocks playback.
    }
    public static void noteRedirect(String source, String url) {
        CompleteAudioCache view = current;
        if (view == null || url.equals(source)) return;
        synchronized (view.cache) {
            if (view != current) return;
            String hash = fingerprint(source);
            if (!view.cache.getCachedSpans(url).isEmpty()) { view.saveAlias(hash, url); return; }
            // Attach metadata only to resources that actually acquire a span. Cancelled plays leave no disk entry.
            if (view.pending.put(url, hash) == null) view.cache.addListener(url, view.listener);
            if (view.pending.size() > 32) {
                String old = view.pending.keySet().iterator().next();
                view.pending.remove(old); view.cache.removeListener(old, view.listener);
            }
        }
    }
    // Keep Media3 types out of the public bridge API; the player dependency owns the cache.
    private final Cache.Listener listener = new Cache.Listener() {
        @Override public void onSpanAdded(Cache cache, CacheSpan span) {
            String hash = pending.remove(span.key);
            cache.removeListener(span.key, this);
            if (hash != null && CompleteAudioCache.this == current) saveAlias(hash, span.key);
        }
        @Override public void onSpanRemoved(Cache cache, CacheSpan span) {}
        @Override public void onSpanTouched(Cache cache, CacheSpan oldSpan, CacheSpan newSpan) {}
    };

    private CachedAudioFile complete(String url) {
        long length = ContentMetadata.getContentLength(cache.getContentMetadata(url));
        if (length <= 0 || !cache.isCached(url, 0, length)) return null;
        java.util.NavigableSet<CacheSpan> cached = cache.getCachedSpans(url);
        CachedAudioFile.Span[] spans = new CachedAudioFile.Span[cached.size()];
        int i = 0;
        for (CacheSpan span : cached) spans[i++] = new CachedAudioFile.Span(span.file, span.position, span.length);
        return CachedAudioFile.open(url, length, spans);
    }
    public static CachedAudioFile open(String source) {
        CompleteAudioCache view = current;
        if (view == null) return null;
        synchronized (view.cache) {
            if (view != current) return null;
            CachedAudioFile direct = view.complete(source);
            if (direct != null) return direct;
            if (!view.indexed) {
                for (String key : view.cache.getKeys()) {
                    String hash = view.cache.getContentMetadata(key).get(ALIAS, "");
                    if (!hash.isEmpty()) view.alias(hash, key);
                }
                view.indexed = true;
            }
            String target = view.aliases.get(fingerprint(source));
            return target == null ? null : view.complete(target);
        }
    }
}
