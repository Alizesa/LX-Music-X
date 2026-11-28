package com.guichaguri.trackplayer.service.player;

import java.io.File;
import java.nio.file.Files;
import java.util.HashSet;
import java.util.Set;

final class AudioCacheProofsTest {
  static void run() throws Exception {
    Set<String> watched = new HashSet<>();
    AudioCacheProofs book = new AudioCacheProofs((key, add) -> {
      if (!(add ? watched.add(key) : watched.remove(key))) throw new AssertionError("unbalanced watch: " + key);
    });
    File a = File.createTempFile("lx-receipt", ".span");
    try {
      Files.write(a.toPath(), new byte[] {1, 2, 3});
      CachedAudioFile file = CachedAudioFile.open("cdn", 3, new CachedAudioFile.Span[]{new CachedAudioFile.Span(a, 0, 3)});
      AudioCacheProofs.Stamp proof = book.begin("proxy", "hash", "cdn", 3);
      if (book.ready("proxy", proof.token) != null || book.finish(proof, null) != null) throw new AssertionError("unverified/hole");
      if (!proof.token.equals(book.finish(proof, file)) || book.ready("proxy", proof.token) != proof) throw new AssertionError("no verified hit");
      book.changed("cdn");
      if (book.finish(proof, file) != null || proof.files != null) throw new AssertionError("resurrected stale spans");
      AudioCacheProofs.Stamp miss = book.begin("proxy", "hash", "proxy", -1);
      book.finish(miss, null); book.redirect("hash", "other");
      if (book.ready("proxy", miss.token) != null) throw new AssertionError("stale alias");
      AudioCacheProofs.Stamp newer = book.begin("proxy", "hash", "other", -1);
      book.finish(newer, null); book.changed("proxy");
      if (book.ready("proxy", newer.token) != null) throw new AssertionError("miss survived new spans");
      for (int i = 0; i < 300; i++) {
        AudioCacheProofs.Stamp s = book.begin("p" + i, "h" + i, "shared", -1); book.finish(s, null);
      }
      if (watched.size() != 33 || !watched.contains("shared")) throw new AssertionError("unbounded/lost shared watches");
      book.clear(); if (!watched.isEmpty()) throw new AssertionError("clear leaked listeners");
      AudioCacheProofs.Stamp fresh = book.begin("proxy", "hash", "cdn", 3); book.finish(fresh, file);
      if (book.ready("proxy", proof.token) != null) throw new AssertionError("reused stale token");
      long before = a.lastModified();
      Files.setLastModifiedTime(a.toPath(), java.nio.file.attribute.FileTime.fromMillis(before + 10000));
      if (file.unchanged()) throw new AssertionError("ignored physical file modification");
      Files.write(a.toPath(), new byte[] {1}); if (file.unchanged()) throw new AssertionError("trusted truncated files");
      CachedAudioFile.Span[] many = new CachedAudioFile.Span[129];
      for (int i = 0; i < many.length; i++) many[i] = new CachedAudioFile.Span(a, i, 1);
      CachedAudioFile fragmented = CachedAudioFile.open("many", many.length, many);
      AudioCacheProofs.Stamp large = book.begin("many", "m", "many", many.length);
      if (!"".equals(book.finish(large, fragmented)) || large.files != null || book.ready("many", large.token) != null)
        throw new AssertionError("retained an oversized span snapshot");
      book.clear();
    } finally { Files.deleteIfExists(a.toPath()); }
  }
}
