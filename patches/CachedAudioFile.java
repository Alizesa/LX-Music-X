package com.guichaguri.trackplayer.service.player;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;

/** Immutable file-span snapshot. No HTTP fallback; eviction while reading is a cache miss. */
public final class CachedAudioFile {
    public final String url;
    public final long length;
    private final Span[] spans;
    private final long[] modified;
    static final class Span {
        final File file;
        final long start, length;
        Span(File file, long start, long length) { this.file = file; this.start = start; this.length = length; }
    }
    private CachedAudioFile(String url, long length, Span[] spans, long[] modified) {
        this.url = url; this.length = length; this.spans = spans; this.modified = modified;
    }
    int spanCount() { return spans.length; }
    boolean unchanged() {
        for (int i = 0; i < spans.length; i++) {
            Span s = spans[i];
            if (s.file.length() != s.length || s.file.lastModified() != modified[i]) return false;
        }
        return true;
    }
    static CachedAudioFile open(String url, long length, Span[] spans) {
        if (length <= 0) return null;
        long next = 0;
        long[] modified = new long[spans.length];
        int i = 0;
        for (Span span : spans) {
            if (span.start != next || span.length <= 0 || span.length > length - next || span.file == null || span.file.length() != span.length) return null;
            modified[i++] = span.file.lastModified();
            next += span.length;
        }
        return next == length ? new CachedAudioFile(url, length, spans, modified) : null;
    }
    public int readAt(long position, byte[] bytes, int count) throws IOException {
        if (position < 0 || count < 0 || count > bytes.length || position > length - count) throw new IOException("cache_miss");
        int lo = 0, hi = spans.length;
        while (lo < hi) {
            int mid = (lo + hi) >>> 1;
            if (spans[mid].start + spans[mid].length <= position) lo = mid + 1; else hi = mid;
        }
        int copied = 0;
        for (int i = lo; i < spans.length && copied < count; i++) {
            Span span = spans[i];
            long offset = position - span.start;
            if (offset < 0 || copied == count) break;
            if (offset >= span.length) continue;
            int n = (int) Math.min(count - copied, span.length - offset);
            try (RandomAccessFile file = new RandomAccessFile(span.file, "r")) {
                file.seek(offset); file.readFully(bytes, copied, n);
            }
            copied += n; position += n;
        }
        if (copied != count) throw new IOException("cache_miss");
        return copied;
    }
}
