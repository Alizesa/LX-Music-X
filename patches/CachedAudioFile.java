package com.guichaguri.trackplayer.service.player;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;

/** Immutable file-span snapshot. No HTTP fallback; eviction while reading is a cache miss. */
public final class CachedAudioFile {
    public final String url;
    public final long length;
    private final Span[] spans;
    static final class Span {
        final File file;
        final long start, length;
        Span(File file, long start, long length) { this.file = file; this.start = start; this.length = length; }
    }
    private CachedAudioFile(String url, long length, Span[] spans) { this.url = url; this.length = length; this.spans = spans; }
    static CachedAudioFile open(String url, long length, Span[] spans) {
        if (length <= 0) return null;
        long next = 0;
        for (Span span : spans) {
            if (span.start != next || span.length <= 0 || span.length > length - next || span.file == null || span.file.length() != span.length) return null;
            next += span.length;
        }
        return next == length ? new CachedAudioFile(url, length, spans) : null;
    }
    public int readAt(long position, byte[] bytes, int count) throws IOException {
        if (position < 0 || count < 0 || count > bytes.length || position > length - count) throw new IOException("cache_miss");
        int copied = 0;
        for (Span span : spans) {
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
