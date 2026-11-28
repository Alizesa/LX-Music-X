package cn.toside.music.mobile.utils;

import java.io.IOException;
import java.util.Arrays;

final class FlacFrameBoundsTest {
  private static byte[] hex(String text) {
    byte[] bytes = new byte[text.length() / 2];
    for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) Integer.parseInt(text.substring(i * 2, i * 2 + 2), 16);
    return bytes;
  }

  private static void verify(byte[] bytes, boolean valid) throws Exception {
    try {
      FlacFrameBounds.verify((position, data, offset, count) -> {
        int n = Math.min(bytes.length - (int) position, count);
        if (n <= 0) return -1;
        System.arraycopy(bytes, (int) position, data, offset, n);
        return n;
      }, bytes, bytes.length, 32);
      if (!valid) throw new AssertionError("accepted truncated FLAC");
    } catch (IOException error) { if (valid) throw error; }
  }

  static void run() throws Exception {
    // Two complete 16-sample mono constant subframes, fixed-frame and variable-sample numbering.
    for (String encoded : new String[] {"fff86908000f300000004680fff86908010f25000000ba85", "fff96908000f5200000068f1fff96908100f05000000c4fb"}) {
      byte[] frames = hex(encoded);
      byte[] bytes = new byte[42 + frames.length];
      bytes[4] = (byte) 128;
      System.arraycopy(frames, 0, bytes, 42, frames.length);
      verify(bytes, true);
      verify(Arrays.copyOf(bytes, 42), false);
      verify(Arrays.copyOf(bytes, 42 + frames.length / 2), false);
      verify(Arrays.copyOf(bytes, bytes.length - 1), false);
      byte[] tagged = Arrays.copyOf(bytes, bytes.length + 128);
      tagged[bytes.length] = 'T'; tagged[bytes.length + 1] = 'A'; tagged[bytes.length + 2] = 'G';
      verify(tagged, true);
      bytes[bytes.length - 1] ^= 1;
      verify(bytes, false);
    }
    byte[] padded = new byte[65536]; padded[42] = (byte) 129;
    int padding = padded.length - 46;
    padded[44] = (byte) (padding >>> 8); padded[45] = (byte) padding;
    verify(padded, false);
  }
}
