package cn.toside.music.mobile.utils;

import java.io.IOException;

/** Verify the end sample of a native FLAC stream, without walking frames or fetching artwork. */
final class FlacFrameBounds {
  interface Source { int readAt(long position, byte[] data, int offset, int size) throws IOException; }
  private static final int LIMIT = 256 * 1024;

  private static int u24(byte[] data, int p) {
    return ((data[p] & 255) << 16) | ((data[p + 1] & 255) << 8) | (data[p + 2] & 255);
  }

  private static int crc(byte[] data, int start, int end, int width, int polynomial) {
    int value = 0;
    for (int p = start; p < end; p++) {
      value ^= (data[p] & 255) << (width - 8);
      for (int i = 0; i < 8; i++) value = (value << 1) ^ ((value & (1 << (width - 1))) != 0 ? polynomial : 0);
    }
    return value & ((1 << width) - 1);
  }

  // RFC 9639: CRC-8 header, UTF-8-coded frame/sample number, variable block-size suffix.
  // Return the first sample following this frame. The first frame establishes fixed block size.
  private static long endSample(byte[] data, int start, int end, int fixedSize) {
    if (end - start < 9 || (data[start] & 255) != 255 || (data[start + 1] & 254) != 248) return -1;
    int code = (data[start + 2] & 255) >>> 4, rate = data[start + 2] & 15;
    if (code == 0 || rate == 15 || (data[start + 3] & 1) != 0 || ((data[start + 3] & 255) >>> 4) > 10) return -1;
    int p = start + 4, first = data[p++] & 255;
    int count = Integer.numberOfLeadingZeros((~first & 255) << 24);
    if (count == 1 || count > 7 || p + count + 4 > end) return -1;
    long number = count == 0 ? first : first & (127 >> count);
    for (int i = 1; i < count; i++) {
      int b = data[p++] & 255;
      if ((b & 192) != 128) return -1;
      number = (number << 6) | (b & 63);
    }
    int size;
    if (code == 1) size = 192;
    else if (code <= 5) size = 576 << (code - 2);
    else if (code == 6) size = (data[p++] & 255) + 1;
    else if (code == 7) { size = ((data[p] & 255) << 8) + (data[p + 1] & 255) + 1; p += 2; }
    else size = 256 << (code - 8);
    p += rate == 12 ? 1 : rate == 13 || rate == 14 ? 2 : 0;
    if (p + 3 >= end || crc(data, start, p, 8, 7) != (data[p] & 255)) return -1;
    if (fixedSize == 0 && number != 0) return -1;
    return ((data[start + 1] & 1) == 0 ? number * fixedSize : number) + size;
  }

  static void verify(Source source, byte[] header, long length, long samples) throws IOException {
    if (length < 0) throw new IOException("metadata_unavailable");
    long start = 42;
    int flags = header[4] & 255;
    byte[] block = new byte[4];
    for (int i = 0; (flags & 128) == 0; i++) {
      if (i == 128) throw new IOException("metadata_limit");
      if (start > length - 4 || source.readAt(start, block, 0, 4) != 4) throw new IOException("incomplete_audio");
      flags = block[0] & 255;
      start += 4L + u24(block, 1);
    }
    if (length - start < 9) throw new IOException("incomplete_audio");
    byte[] first = new byte[(int) Math.min(24, length - start)];
    if (source.readAt(start, first, 0, first.length) != first.length) throw new IOException("incomplete_audio");
    int fixedSize = (int) endSample(first, 0, first.length, 0);
    if (fixedSize <= 0) throw new IOException("invalid_metadata");
    int maxFrame = u24(header, 15);
    int window = maxFrame > 0 ? Math.min(maxFrame, LIMIT) : LIMIT;
    // Include a possible trailing ID3v1 tag. The network source still enforces its shared byte/time budget.
    int size = (int) Math.min(length - start, window + 128L);
    byte[] tail = new byte[size];
    if (source.readAt(length - size, tail, 0, size) != size) throw new IOException("incomplete_audio");
    int end = size;
    if (end >= 128 && tail[end - 128] == 'T' && tail[end - 127] == 'A' && tail[end - 126] == 'G') end -= 128;
    int checks = 0;
    for (int p = end - 9; p >= 0; p--) {
      if (tail[p] != (byte) 255 || tail[p + 1] != first[1] || endSample(tail, p, end, fixedSize) != samples) continue;
      if (++checks > 4) throw new IOException("metadata_limit");
      if (crc(tail, p, end, 16, 0x8005) == 0) return;
    }
    throw new IOException(length - start > size && (maxFrame == 0 || maxFrame > LIMIT) ? "metadata_limit" : "incomplete_audio");
  }
}
