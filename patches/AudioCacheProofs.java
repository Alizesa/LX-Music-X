package com.guichaguri.trackplayer.service.player;

import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.concurrent.atomic.AtomicLong;

/** All calls are under the owning SimpleCache lock. Tokens are not valid across cache instances. */
final class AudioCacheProofs {
    interface Watches { void set(String key, boolean watch); }
    static final class Stamp {
        final String source, hash, target, token;
        final long length; // -1: no complete resource, not an IO or parsing failure
        boolean valid = true, ready;
        CachedAudioFile files;
        Stamp(String source, String hash, String target, long length) {
            this.source = source; this.hash = hash; this.target = target; this.length = length;
            token = Long.toString(sequence.incrementAndGet());
        }
    }
    private static final AtomicLong sequence = new AtomicLong();
    private final LinkedHashMap<String, Stamp> entries = new LinkedHashMap<>(32, 0.75f, true);
    private final HashMap<String, Integer> refs = new HashMap<>();
    private final Watches watches;
    AudioCacheProofs(Watches watches) { this.watches = watches; }

    private void reference(String key, int change) {
        Integer previous = refs.get(key);
        int count = (previous == null ? 0 : previous) + change;
        if (count == 0) { refs.remove(key); watches.set(key, false); }
        else { refs.put(key, count); if (previous == null) watches.set(key, true); }
    }
    private void reference(Stamp s, int change) {
        reference(s.source, change);
        if (!s.target.equals(s.source)) reference(s.target, change);
    }
    private void discard(Stamp s) { s.valid = false; s.files = null; }
    private void remove(String key) {
        Stamp s = entries.remove(key);
        if (s != null) { discard(s); reference(s, -1); }
    }
    Stamp begin(String source, String hash, String target, long length) {
        remove(source);
        if (entries.size() == 32) remove(entries.keySet().iterator().next());
        Stamp s = new Stamp(source, hash, target, length);
        entries.put(source, s); reference(s, 1);
        return s;
    }
    void changed(String key) {
        for (Stamp s : entries.values()) if (s.target.equals(key) || s.source.equals(key)) discard(s);
    }
    void redirect(String hash, String target) {
        for (Stamp s : entries.values()) if (s.hash.equals(hash) && !s.target.equals(target)) discard(s);
    }
    void clear() { while (!entries.isEmpty()) remove(entries.keySet().iterator().next()); }
    boolean live(Stamp s) { return s.valid && entries.get(s.source) == s; }
    // null: stale/inconsistent; empty: usable now but too many span records to memoize.
    String finish(Stamp s, CachedAudioFile files) {
        if (!live(s) || (s.length > 0) != (files != null)) return null;
        if (files != null && files.spanCount() > 128) return "";
        s.files = files; s.ready = true;
        return s.token;
    }
    Stamp ready(String source, String token) {
        Stamp s = entries.get(source);
        return s != null && s.ready && s.valid && s.token.equals(token) ? s : null;
    }
}
