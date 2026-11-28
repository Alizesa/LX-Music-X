package cn.toside.music.mobile.utils;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/** Standalone fixtures, compiled and executed by the Node test runner in CI only. */
public final class Mp4AudioMetadataTest {
  private static final int BLOCK = 65536;
  private static final long MEDIA_SIZE = 32L * 1024 * 1024;

  private static final class Source implements Mp4AudioMetadata.Source {
    final LinkedHashMap<Long, byte[]> parts = new LinkedHashMap<>();
    final LinkedHashMap<Long, Boolean> blocks = new LinkedHashMap<>();
    long length;
    int transferred;
    boolean cancelled;

    Source add(byte[] data) { parts.put(length, data); length += data.length; return this; }
    Source gap(long size) { length += size; return this; }

    @Override public int readAt(long position, byte[] buffer, int offset, int size) throws IOException {
      if (cancelled) throw new IOException("cancelled");
      if (position < 0 || position >= length) return -1;
      int count = (int) Math.min(size, length - position);
      for (long block = position / BLOCK * BLOCK; block < position + count; block += BLOCK) {
        if (!blocks.containsKey(block)) {
          blocks.put(block, true);
          transferred += (int) Math.min(BLOCK, length - block);
          if (transferred > 1024 * 1024) throw new IOException("byte_limit");
          if (blocks.size() > 4) blocks.remove(blocks.keySet().iterator().next());
        }
      }
      for (Map.Entry<Long, byte[]> part : parts.entrySet()) {
        long start = Math.max(position, part.getKey());
        long end = Math.min(position + count, part.getKey() + part.getValue().length);
        if (end > start) System.arraycopy(part.getValue(), (int) (start - part.getKey()),
            buffer, offset + (int) (start - position), (int) (end - start));
      }
      return count;
    }
  }

  private static byte[] ints(int... values) throws IOException {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    DataOutputStream data = new DataOutputStream(out);
    for (int value : values) data.writeInt(value);
    return out.toByteArray();
  }

  private static byte[] join(byte[]... parts) throws IOException {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    for (byte[] part : parts) out.write(part);
    return out.toByteArray();
  }

  private static int type(String value) {
    return (value.charAt(0) << 24) | (value.charAt(1) << 16) | (value.charAt(2) << 8) | value.charAt(3);
  }

  private static byte[] box(String name, byte[]... parts) throws IOException {
    byte[] data = join(parts);
    return join(ints(data.length + 8, type(name)), data);
  }

  private static byte[] track(String codec, boolean version1, int seconds, int sampleSeconds) throws IOException {
    return track(codec, version1, seconds, sampleSeconds, false);
  }

  private static byte[] track(String codec, boolean version1, int seconds, int sampleSeconds, boolean variable) throws IOException {
    byte[] timing = sampleSeconds == 0 ? ints(0, 0) : ints(0, 1, sampleSeconds, 48000);
    return track(codec, version1, seconds, sampleSeconds, variable, timing);
  }

  private static byte[] track(String codec, boolean version1, int seconds, int sampleSeconds, boolean variable, byte[] timing) throws IOException {
    long duration = seconds < 0 ? -1L : seconds * 48000L;
    byte[] mdhd = version1 ? ints(0x01000000, 0, 0, 0, 0, 48000, (int) (duration >>> 32), (int) duration, 0)
        : ints(0, 0, 0, 48000, (int) duration, 0);
    byte[] esds = box("esds", ints(0), new byte[] {3, 18, 0, 1, 0, 4, 13, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0});
    int[] sizes = new int[variable ? 3 + sampleSeconds : 3];
    sizes[1] = variable ? 0 : 16000;
    sizes[2] = sampleSeconds;
    for (int index = 3; index < sizes.length; index++) sizes[index] = 16000;
    byte[] entry = box(codec, new byte[28], codec.equals("mp4a") ? esds : new byte[0]);
    return box("trak", box("mdia", box("mdhd", mdhd),
        box("hdlr", ints(0, 0, type(codec.equals("avc1") ? "vide" : "soun"))),
        box("minf", box("stbl", box("stsd", ints(0, 1), entry),
            box("stts", timing), box("stsz", ints(sizes))))));
  }

  private static Source file(boolean tail, boolean version1, boolean video, String codec) throws IOException {
    byte[] movie = box("moov", track(codec, version1, 280, 280),
        video ? track("avc1", false, 280, 280) : new byte[0]);
    Source source = new Source().add(box("ftyp", ints(type("M4A "), 0, type("isom"))));
    if (!tail) source.add(movie);
    source.add(ints((int) MEDIA_SIZE, type("mdat"))).gap(MEDIA_SIZE - 8);
    if (tail) source.add(movie);
    return source;
  }

  private static Mp4AudioMetadata.Info read(Source source) throws IOException {
    return Mp4AudioMetadata.read(source, source.length);
  }

  private static void check(boolean value, String message) {
    if (!value) throw new AssertionError(message);
  }

  private static void invalid(Source source, String reason) throws IOException {
    try { read(source); throw new AssertionError("accepted invalid metadata: " + reason); }
    catch (Mp4AudioMetadata.InvalidMetadata error) { check(reason.equals(error.getMessage()), error.toString()); }
  }

  public static void main(String[] args) throws Exception {
    for (boolean tail : new boolean[] {false, true}) {
      for (boolean version1 : new boolean[] {false, true}) {
        Source source = file(tail, version1, false, "mp4a");
        Mp4AudioMetadata.Info info = read(source);
        check(info != null && info.mime.equals("audio/mp4a-latm") && info.durationMs == 280000 && info.bitRate == 128000 && !info.hasVideo,
            "AAC duration, front/tail moov, mdhd v0/v1");
        check(source.transferred <= 3 * BLOCK, "media payload scanned");
      }
    }
    check(read(file(true, false, true, "mp4a")).hasVideo, "video track after audio was missed");
    check(read(file(true, false, false, "alac")).mime.equals("audio/alac"), "ALAC mislabeled as AAC");
    check(read(file(true, false, false, "fLaC")).mime.equals("audio/flac"), "MP4 FLAC mislabeled");
    check(read(file(true, false, false, "enca")) == null, "encrypted audio accepted");
    Source shortAudio = new Source().add(box("ftyp", ints(0, 0))).add(box("moov", track("mp4a", false, 280, 30)))
        .add(ints(480008, type("mdat"))).gap(480000);
    check(read(shortAudio).durationMs == 30000, "full-length mdhd hid a short sample table");
    for (boolean version1 : new boolean[] {false, true}) {
      for (boolean variable : new boolean[] {false, true}) {
        for (int seconds : new int[] {-1, 280}) {
          Source empty = new Source().add(box("moov", track("mp4a", version1, seconds, 0, variable)))
              .add(box("mdat", new byte[8]));
          check(read(empty) == null, "empty sample tables accepted, mdhd v" + (version1 ? 1 : 0) + ", variable sizes " + variable);
        }
      }
      for (int seconds : new int[] {0, -1}) {
        Source noDuration = new Source().add(box("moov", track("mp4a", version1, seconds, 280)))
            .add(ints((int) MEDIA_SIZE, type("mdat"))).gap(MEDIA_SIZE - 8);
        check(read(noDuration) == null, "zero/unknown mdhd duration accepted, version " + (version1 ? 1 : 0));
      }
    }
    for (byte[] timing : new byte[][] {ints(0, 1, 0, 48000), ints(0, 1, 280, 0)}) {
      Source invalidTiming = new Source().add(box("moov", track("mp4a", false, 280, 280, false, timing)))
          .add(ints((int) MEDIA_SIZE, type("mdat"))).gap(MEDIA_SIZE - 8);
      invalid(invalidTiming, "invalid_metadata");
    }
    Source fragment = new Source().add(box("moov", track("mp4a", false, 280, 280), box("mvex")))
        .add(box("mdat", new byte[8]));
    check(read(fragment) == null, "fragmented MP4 used incomplete sample table");
    check(Mp4AudioMetadata.read(file(true, false, false, "mp4a"), -1) == null, "unknown length accepted");
    invalid(new Source().add(ints(7, type("moov"))), "invalid_metadata");
    invalid(new Source().add(ints(100, type("moov"))), "invalid_metadata");
    invalid(new Source().add(ints(1, type("mdat"), -1, -1)), "invalid_metadata");
    Source excessive = new Source();
    for (int i = 0; i < 513; i++) excessive.add(box("free"));
    invalid(excessive, "metadata_limit");
    Source huge = new Source().add(box("ftyp", ints(0, 0)))
        .add(ints(1, type("mdat"), 1, 0)).gap(0x100000000L - 16)
        .add(box("moov", track("mp4a", true, 280, 280)));
    check(read(huge).durationMs == 280000 && huge.transferred <= 3 * BLOCK, "64-bit box offsets");
    Source artwork = new Source().add(box("ftyp", ints(0, 0)));
    byte[] audio = track("mp4a", false, 280, 280);
    artwork.add(ints((int) MEDIA_SIZE + audio.length + 8, type("moov")))
        .add(ints((int) MEDIA_SIZE, type("udta"))).gap(MEDIA_SIZE - 8).add(audio).add(ints(4480008, type("mdat"))).gap(4480000);
    check(read(artwork).durationMs == 280000 && artwork.transferred <= 3 * BLOCK, "cover art scanned");
    Source zero = new Source().add(box("moov", track("mp4a", false, 280, 280)))
        .add(ints(0, type("mdat"))).gap(MEDIA_SIZE);
    check(read(zero).durationMs == 280000, "zero-sized final mdat");
    Source variable = new Source().add(box("moov", track("mp4a", false, 280, 280, true)))
        .add(ints((int) MEDIA_SIZE, type("mdat"))).gap(MEDIA_SIZE - 8);
    check(read(variable).bitRate == 128000 && variable.transferred <= 3 * BLOCK, "variable sample sizes");
    invalid(new Source().add(box("moov", track("mp4a", false, 280, 280))).add(box("mdat", new byte[8])), "invalid_metadata");
    byte[] mismatch = track("mp4a", false, 280, 280);
    mismatch[mismatch.length - 1] = 0x17;
    invalid(new Source().add(box("moov", mismatch)).add(ints((int) MEDIA_SIZE, type("mdat"))).gap(MEDIA_SIZE - 8), "invalid_metadata");
    Source cancelled = file(true, false, false, "mp4a");
    cancelled.cancelled = true;
    try { read(cancelled); throw new AssertionError("cancellation swallowed"); }
    catch (IOException error) { check(error.getMessage().equals("cancelled"), error.toString()); }
    Source tagged = new Source().add(box("moov", track("mp4a", false, 97, 97),
        box("udta", box("meta", ints(0), box("ilst",
          box("\u00a9nam", box("data", ints(1, 0), "Song (OP ver.1.2)".getBytes(StandardCharsets.UTF_8))),
          box("\u00a9ART", box("data", ints(2, 0), "Artist".getBytes(StandardCharsets.UTF_16BE))),
          box("\u00a9alb", box("data", ints(1, 0), "Album".getBytes(StandardCharsets.UTF_8))),
          box("covr", box("data", ints(13, 0), new byte[262144])))))))
        .add(ints((int) MEDIA_SIZE, type("mdat"))).gap(MEDIA_SIZE - 8);
    Mp4AudioMetadata.Info tags = read(tagged);
    check(tags.durationMs == 97000 && "Song (OP ver.1.2)".equals(tags.title) &&
        "Artist".equals(tags.artist) && "Album".equals(tags.album), "text metadata");
    check(tagged.transferred <= 3 * BLOCK, "embedded artwork scanned while reading text tags");
    Mp4AudioMetadata.Info unavailableTags = Mp4AudioMetadata.read(tagged, tagged.length, (position, buffer, offset, size) -> {
      throw new IOException("metadata_not_cached");
    });
    check(unavailableTags.durationMs == 97000 && unavailableTags.title == null,
        "uncached diagnostic tags invalidated valid audio");
    Source brokenTags = new Source().add(box("moov", track("mp4a", false, 97, 97), box("udta", new byte[4])))
        .add(ints((int) MEDIA_SIZE, type("mdat"))).gap(MEDIA_SIZE - 8);
    check(read(brokenTags).durationMs == 97000, "malformed diagnostic tags invalidated valid audio");
    FlacFrameBoundsTest.run();
    System.out.println("Audio fixtures passed");
  }
}
