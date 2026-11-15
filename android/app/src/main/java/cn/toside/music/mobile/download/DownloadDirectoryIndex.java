package cn.toside.music.mobile.download;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/** Short-lived name snapshots for consecutive downloads into the same SAF tree. */
final class DownloadDirectoryIndex {
  private static final long TTL_MS = 60_000;
  private static final int MAX_DIRECTORIES = 3;
  private static final int MAX_NAMES = 50_000;
  private static final long MAX_CHARACTERS = 1_000_000;
  private static final LinkedHashMap<String, Snapshot> snapshots = new LinkedHashMap<>(4, 0.75f, true);
  private static long characters;

  private static final class Snapshot {
    final Set<String> names;
    final long expiresAt;
    long characters;
    Snapshot(Set<String> names, long expiresAt, long characters) {
      this.names = names;
      this.expiresAt = expiresAt;
      this.characters = characters;
    }
  }

  private DownloadDirectoryIndex() {}

  static synchronized Set<String> get(String treeUri, long now) {
    Snapshot entry = snapshots.get(treeUri);
    if (entry == null) return null;
    if (entry.expiresAt <= now) {
      invalidate(treeUri);
      return null;
    }
    return entry.names;
  }

  static synchronized void put(String treeUri, Set<String> names, long now) {
    invalidate(treeUri);
    if (names.size() > MAX_NAMES) return;
    long size = 0;
    for (String name : names) if (name != null) size += name.length();
    if (size > MAX_CHARACTERS) return;
    snapshots.put(treeUri, new Snapshot(names, now + TTL_MS, size));
    characters += size;
    trim();
  }

  static synchronized void created(String treeUri, String name) {
    Snapshot entry = snapshots.get(treeUri);
    if (entry == null || name == null || !entry.names.add(name)) return;
    entry.characters += name.length();
    characters += name.length();
    if (entry.names.size() > MAX_NAMES) invalidate(treeUri);
    trim();
  }

  static synchronized void invalidate(String treeUri) {
    Snapshot removed = snapshots.remove(treeUri);
    if (removed != null) characters -= removed.characters;
  }

  private static void trim() {
    while (snapshots.size() > MAX_DIRECTORIES || characters > MAX_CHARACTERS) {
      Map.Entry<String, Snapshot> eldest = snapshots.entrySet().iterator().next();
      invalidate(eldest.getKey());
    }
  }
}
