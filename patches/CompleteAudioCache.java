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

    private final AudioCacheProofs proofs;
    private CompleteAudioCache(SimpleCache cache) {
        this.cache = cache;
        proofs = new AudioCacheProofs((key, watch) -> {
            if (watch) cache.addListener(key, changes); else cache.removeListener(key, changes);
        });
    }
    private final Cache.Listener changes = new Cache.Listener() {
        @Override public void onSpanAdded(Cache c, CacheSpan span) { proofs.changed(span.key); }
        @Override public void onSpanRemoved(Cache c, CacheSpan span) { proofs.changed(span.key); }
        @Override public void onSpanTouched(Cache c, CacheSpan old, CacheSpan span) {
            if (old.position != span.position || old.length != span.length || old.file == null || !old.file.equals(span.file)) proofs.changed(span.key);
        }
    };
    static void attach(SimpleCache cache) { current = new CompleteAudioCache(cache); }
    static void reset(SimpleCache cache, boolean release) {
        synchronized (cache) {
            CompleteAudioCache view = current;
            if (view == null || view.cache != cache) return;
            for (String key : view.pending.keySet()) cache.removeListener(key, view.listener);
            view.proofs.clear();
            view.pending.clear(); view.aliases.clear(); view.indexed = false;
            if (release) current = null;
        }
    }
    private static String fingerprint(String source) {
        try { return android.util.Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(source.getBytes(StandardCharsets.UTF_8)), android.util.Base64.NO_WRAP); }
        catch (NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }
    private void alias(String hash, String url) {
        proofs.redirect(hash, url);
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

    private long completeLength(String key) {
        long length = ContentMetadata.getContentLength(cache.getContentMetadata(key));
        return length > 0 && cache.isCached(key, 0, length) ? length : -1;
    }
    private boolean same(AudioCacheProofs.Stamp s) {
        if (this != current || !proofs.live(s)) return false;
        if (!s.source.equals(s.target) && (!s.target.equals(aliases.get(s.hash)) || completeLength(s.source) > 0)) return false;
        // A metadata change need not emit a span event (e.g. a previously unknown length).
        return s.length > 0 ? ContentMetadata.getContentLength(cache.getContentMetadata(s.target)) == s.length : completeLength(s.target) < 0;
    }
    public static boolean confirmed(String source, String token) {
        CompleteAudioCache v = current;
        if (v == null || token == null || token.isEmpty()) return false;
        AudioCacheProofs.Stamp s;
        CachedAudioFile files;
        synchronized (v.cache) {
            s = v.proofs.ready(source, token);
            if (s == null || !v.same(s)) return false;
            files = s.files;
        }
        // Guard against out-of-band truncation/replacement without blocking the player cache lock on stat().
        if (files != null && !files.unchanged()) return false;
        synchronized (v.cache) { return v.same(s); }
    }
    public static final class Lookup {
        public final CachedAudioFile file;
        private final CompleteAudioCache view;
        private final AudioCacheProofs.Stamp stamp;
        private Lookup(CompleteAudioCache v, AudioCacheProofs.Stamp s, CachedAudioFile f) { view = v; stamp = s; file = f; }
        public String confirm() {
            if (file != null && !file.unchanged()) return null;
            synchronized (view.cache) { return view.same(stamp) ? view.proofs.finish(stamp, file) : null; }
        }
    }
    public static Lookup open(String source) {
        CompleteAudioCache v = current;
        if (v == null) return null;
        String hash = fingerprint(source), target = source;
        long length;
        AudioCacheProofs.Stamp stamp;
        CachedAudioFile.Span[] spans;
        synchronized (v.cache) {
            if (v != current) return null;
            length = v.completeLength(source);
            if (length < 0) {
                if (!v.indexed) {
                    for (String key : v.cache.getKeys()) {
                        String alias = v.cache.getContentMetadata(key).get(ALIAS, "");
                        if (!alias.isEmpty()) v.alias(alias, key);
                    }
                    v.indexed = true;
                }
                String alias = v.aliases.get(hash);
                if (alias != null) { target = alias; length = v.completeLength(target); }
            }
            stamp = v.proofs.begin(source, hash, target, length);
            if (length < 0) return new Lookup(v, stamp, null);
            java.util.NavigableSet<CacheSpan> cached = v.cache.getCachedSpans(target);
            spans = new CachedAudioFile.Span[cached.size()];
            int i = 0;
            for (CacheSpan span : cached) spans[i++] = new CachedAudioFile.Span(span.file, span.position, span.length);
        }
        return new Lookup(v, stamp, CachedAudioFile.open(target, length, spans));
    }
}
