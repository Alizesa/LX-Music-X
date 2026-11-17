package cn.toside.music.mobile.utils;

import java.io.IOException;

/** Reads only MP4 directory boxes; media payloads and artwork are never scanned. */
final class Mp4AudioMetadata {
  interface Source {
    int readAt(long position, byte[] buffer, int offset, int size) throws IOException;
  }

  static final class Info {
    final String mime;
    final double durationMs;
    final boolean hasVideo;
    final double bitRate;

    Info(String mime, double durationMs, boolean hasVideo, double bitRate) {
      this.mime = mime;
      this.durationMs = durationMs;
      this.hasVideo = hasVideo;
      this.bitRate = bitRate;
    }
  }

  static final class InvalidMetadata extends IOException {
    InvalidMetadata(String reason) { super(reason); }
  }

  private static final class Box {
    final int type;
    final long data;
    final long end;

    Box(int type, long data, long end) { this.type = type; this.data = data; this.end = end; }
  }

  private static final class Track {
    int handler;
    String mime;
    long scale;
    long duration;
    long sampleDuration;
    long sampleBytes;
    long sampleCount;
    long sizeCount;
  }

  private final Source source;
  private int boxes;
  private boolean hasVideo;
  private boolean fragmented;
  private Track audio;

  private Mp4AudioMetadata(Source source) { this.source = source; }

  static Info read(Source source, long length) throws IOException {
    // Unknown-length and fragmented files remain the platform extractor's responsibility.
    if (length < 8) return null;
    Mp4AudioMetadata parser = new Mp4AudioMetadata(source);
    boolean movie = false;
    long mediaBytes = 0;
    for (long position = 0; position < length;) {
      Box box = parser.box(position, length);
      if (box.type == type("moov")) {
        if (movie) throw invalid();
        movie = true;
        parser.movie(box);
      } else if (box.type == type("mdat")) {
        mediaBytes += box.end - box.data;
      } else if (box.type == type("moof")) {
        parser.fragmented = true;
      }
      position = box.end;
    }
    Track track = parser.audio;
    if (!movie || mediaBytes <= 0 || parser.fragmented || track == null || track.mime == null ||
        track.scale <= 0 || track.duration <= 0 || track.sampleDuration <= 0 || track.sampleBytes <= 0) return null;
    if (track.sampleBytes > mediaBytes || track.sampleCount != track.sizeCount) throw invalid();
    // Use the samples' duration as well as mdhd: a full-length movie header alone is insufficient.
    double durationMs = Math.min(track.duration, track.sampleDuration) * 1000.0 / track.scale;
    return new Info(track.mime, durationMs, parser.hasVideo, track.sampleBytes * 8000.0 / durationMs);
  }

  private void movie(Box parent) throws IOException {
    for (long position = parent.data; position < parent.end;) {
      Box box = box(position, parent.end);
      if (box.type == type("trak")) {
        Track track = new Track();
        children(box, track, 0);
        if (track.handler == type("vide")) hasVideo = true;
        // Match MediaExtractor's first audio track rather than choosing a longer alternate track.
        if (track.handler == type("soun") && audio == null) audio = track;
      } else if (box.type == type("mvex")) fragmented = true;
      position = box.end;
    }
  }

  private void children(Box parent, Track track, int level) throws IOException {
    for (long position = parent.data; position < parent.end;) {
      Box box = box(position, parent.end);
      if ((level == 0 && box.type == type("mdia")) ||
          (level == 1 && box.type == type("minf")) ||
          (level == 2 && box.type == type("stbl"))) {
        children(box, track, level + 1);
      } else if (level == 1 && box.type == type("hdlr")) {
        track.handler = integer(bytes(box.data, 12, box.end), 8);
      } else if (level == 1 && box.type == type("mdhd")) {
        byte[] version = bytes(box.data, 1, box.end);
        if (version[0] == 0) {
          byte[] data = bytes(box.data, 20, box.end);
          track.scale = unsigned(data, 12);
          long duration = unsigned(data, 16);
          track.duration = duration == 0xffffffffL ? 0 : duration;
        } else if (version[0] == 1) {
          byte[] data = bytes(box.data, 32, box.end);
          track.scale = unsigned(data, 20);
          // All-ones and values beyond signed long cannot represent a usable duration.
          track.duration = (data[24] & 128) != 0 ? 0 : longValue(data, 24);
        } else throw invalid();
      } else if (level == 3 && box.type == type("stsd")) {
        descriptions(box, track);
      } else if (level == 3 && box.type == type("stts")) {
        timing(box, track);
      } else if (level == 3 && box.type == type("stsz")) {
        sampleSizes(box, track);
      }
      position = box.end;
    }
  }

  private void descriptions(Box parent, Track track) throws IOException {
    byte[] header = bytes(parent.data, 8, parent.end);
    long count = unsigned(header, 4);
    if (count > 16) throw new InvalidMetadata("metadata_limit");
    long position = parent.data + 8;
    String mime = null;
    boolean supported = count > 0;
    for (int index = 0; index < count; index++) {
      Box entry = box(position, parent.end);
      String next = entry.type == type("mp4a") ? mp4a(entry)
          : entry.type == type("alac") ? "audio/alac"
          : entry.type == type("fLaC") ? "audio/flac"
          : entry.type == type("Opus") ? "audio/opus"
          : entry.type == type("ac-3") ? "audio/ac3"
          : entry.type == type("ec-3") ? "audio/eac3" : null;
      if (entry.end - entry.data < 28 || next == null || (mime != null && !mime.equals(next))) supported = false;
      mime = next;
      position = entry.end;
    }
    if (position != parent.end) throw invalid();
    track.mime = supported ? mime : null;
  }

  private String mp4a(Box entry) throws IOException {
    byte[] header = bytes(entry.data, 28, entry.end);
    int version = ((header[8] & 255) << 8) | (header[9] & 255);
    if (version > 1) return null;
    return codec(entry.data + (version == 1 ? 44 : 28), entry.end, true);
  }

  private String codec(long start, long end, boolean allowWave) throws IOException {
    for (long position = start; position < end;) {
      Box box = box(position, end);
      if (box.type == type("esds")) {
        long[] es = descriptor(box.data + 4, box.end, 3);
        byte[] header = bytes(es[0], 3, es[1]);
        long cursor = es[0] + 3;
        int flags = header[2] & 255;
        if ((flags & 128) != 0) cursor += 2;
        if ((flags & 64) != 0) cursor += 1 + (bytes(cursor, 1, es[1])[0] & 255);
        if ((flags & 32) != 0) cursor += 2;
        long[] decoder = descriptor(cursor, es[1], 4);
        byte[] config = bytes(decoder[0], 13, decoder[1]);
        if (((config[1] & 255) >>> 2) != 5) return null;
        int object = config[0] & 255;
        if (object == 0x40 || object == 0x66 || object == 0x67 || object == 0x68) return "audio/mp4a-latm";
        if (object == 0x69 || object == 0x6b) return "audio/mpeg";
        return null;
      }
      if (allowWave && box.type == type("wave")) {
        String mime = codec(box.data, box.end, false);
        if (mime != null) return mime;
      }
      position = box.end;
    }
    return null;
  }

  private long[] descriptor(long position, long end, int expectedTag) throws IOException {
    if ((bytes(position++, 1, end)[0] & 255) != expectedTag) throw invalid();
    long size = 0;
    for (int index = 0; index < 4; index++) {
      int value = bytes(position++, 1, end)[0] & 255;
      size = (size << 7) | (value & 127);
      if ((value & 128) == 0) {
        if (size > end - position) throw invalid();
        return new long[] {position, position + size};
      }
    }
    throw invalid();
  }

  private void timing(Box box, Track track) throws IOException {
    byte[] header = bytes(box.data, 8, box.end);
    long count = unsigned(header, 4);
    if (count > 8192) throw new InvalidMetadata("metadata_limit");
    if (box.end - box.data - 8 != count * 8) throw invalid();
    long total = 0;
    for (int first = 0; first < count; first += 128) {
      int entries = (int) Math.min(128, count - first);
      byte[] data = bytes(box.data + 8 + first * 8L, entries * 8, box.end);
      for (int index = 0; index < entries; index++) {
        long samples = unsigned(data, index * 8);
        long delta = unsigned(data, index * 8 + 4);
        if (samples == 0 || delta == 0 || samples > (Long.MAX_VALUE - total) / delta) throw invalid();
        total += samples * delta;
        track.sampleCount += samples;
      }
    }
    track.sampleDuration = total;
  }

  private void sampleSizes(Box box, Track track) throws IOException {
    byte[] header = bytes(box.data, 12, box.end);
    long size = unsigned(header, 4);
    long count = unsigned(header, 8);
    track.sizeCount = count;
    if (size != 0) {
      if (count > Long.MAX_VALUE / size || box.end - box.data != 12) throw invalid();
      track.sampleBytes = size * count;
      return;
    }
    if (count > 131072) throw new InvalidMetadata("metadata_limit");
    if (box.end - box.data - 12 != count * 4) throw invalid();
    long total = 0;
    for (int first = 0; first < count; first += 256) {
      int entries = (int) Math.min(256, count - first);
      byte[] data = bytes(box.data + 12 + first * 4L, entries * 4, box.end);
      for (int index = 0; index < entries; index++) total += unsigned(data, index * 4);
    }
    track.sampleBytes = total;
  }

  private Box box(long position, long end) throws IOException {
    if (++boxes > 512) throw new InvalidMetadata("metadata_limit");
    byte[] header = bytes(position, 8, end);
    long size = unsigned(header, 0);
    int headerSize = 8;
    if (size == 1) {
      byte[] extended = bytes(position + 8, 8, end);
      if ((extended[0] & 128) != 0) throw invalid();
      size = longValue(extended, 0);
      headerSize = 16;
    } else if (size == 0) size = end - position;
    if (size < headerSize || size > end - position) throw invalid();
    return new Box(integer(header, 4), position + headerSize, position + size);
  }

  private byte[] bytes(long position, int size, long end) throws IOException {
    if (position < 0 || position > end || size > end - position) throw invalid();
    byte[] data = new byte[size];
    if (source.readAt(position, data, 0, size) != size) throw invalid();
    return data;
  }

  private static InvalidMetadata invalid() { return new InvalidMetadata("invalid_metadata"); }

  private static int integer(byte[] data, int offset) {
    return ((data[offset] & 255) << 24) | ((data[offset + 1] & 255) << 16) |
        ((data[offset + 2] & 255) << 8) | (data[offset + 3] & 255);
  }

  private static long unsigned(byte[] data, int offset) { return integer(data, offset) & 0xffffffffL; }

  private static long longValue(byte[] data, int offset) {
    return (unsigned(data, offset) << 32) | unsigned(data, offset + 4);
  }

  private static int type(String value) {
    return (value.charAt(0) << 24) | (value.charAt(1) << 16) | (value.charAt(2) << 8) | value.charAt(3);
  }
}
