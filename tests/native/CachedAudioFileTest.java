package com.guichaguri.trackplayer.service.player;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.util.Arrays;

public final class CachedAudioFileTest {
  public static void run() throws Exception {
    AudioCacheProofsTest.run();
    File a = File.createTempFile("lx-cache-a", ".span");
    File b = File.createTempFile("lx-cache-b", ".span");
    try {
      Files.write(a.toPath(), new byte[] {1, 2, 3}); Files.write(b.toPath(), new byte[] {4, 5});
      CachedAudioFile.Span first = new CachedAudioFile.Span(a, 0, 3);
      CachedAudioFile.Span last = new CachedAudioFile.Span(b, 3, 2);
      CachedAudioFile.Span[] full = { first, last };
      if (CachedAudioFile.open("cdn", -1, full) != null || CachedAudioFile.open("cdn", 6, full) != null ||
          CachedAudioFile.open("cdn", 5, new CachedAudioFile.Span[] {last}) != null ||
          CachedAudioFile.open("cdn", 5, new CachedAudioFile.Span[] {first}) != null) throw new AssertionError("accepted holes/unknown length");
      CachedAudioFile source = CachedAudioFile.open("cdn", 5, full);
      byte[] slice = new byte[3];
      if (source == null || source.readAt(2, slice, 3) != 3 || !Arrays.equals(slice, new byte[] {3, 4, 5})) throw new AssertionError("cross-span read");
      Files.write(b.toPath(), new byte[] {4});
      if (CachedAudioFile.open("cdn", 5, full) != null) throw new AssertionError("trusted stale span index");
      try { source.readAt(2, slice, 3); throw new AssertionError("accepted evicted/truncated bytes"); } catch (IOException expected) {}
    } finally { Files.deleteIfExists(a.toPath()); Files.deleteIfExists(b.toPath()); }
  }
}
