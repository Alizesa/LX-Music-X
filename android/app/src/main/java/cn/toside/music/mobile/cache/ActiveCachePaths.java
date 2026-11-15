package cn.toside.music.mobile.cache;

import java.io.File;
import java.io.IOException;
import java.util.HashMap;
import java.util.Map;

/** Shared ownership of cache paths, serialized with cache-file deletion. */
final class ActiveCachePaths {
  private static final Map<String, Integer> references = new HashMap<>();
  private static File internalRoot;
  private static File externalRoot;

  private ActiveCachePaths() {}

  static synchronized void configure(File internal, File external) {
    try {
      internalRoot = internal.getCanonicalFile();
      externalRoot = external == null ? null : external.getCanonicalFile();
    } catch (IOException ignored) {
      internalRoot = externalRoot = null;
    }
  }

  private static boolean isCachePath(String path) {
    return (internalRoot != null && path.startsWith(internalRoot.getPath() + File.separator))
      || (externalRoot != null && path.startsWith(externalRoot.getPath() + File.separator));
  }

  static synchronized boolean canTraverse(File directory) {
    try {
      File canonical = directory.getCanonicalFile();
      return canonical.equals(internalRoot) || canonical.equals(externalRoot) || isCachePath(canonical.getPath());
    } catch (IOException ignored) {
      return false;
    }
  }

  static synchronized boolean retain(String path) {
    try {
      String canonical = new File(path).getCanonicalPath();
      if (!isCachePath(canonical)) return false;
      Integer count = references.get(canonical);
      references.put(canonical, count == null ? 1 : count + 1);
      return true;
    } catch (IOException ignored) {
      return false;
    }
  }

  static synchronized boolean release(String path) {
    try {
      String canonical = new File(path).getCanonicalPath();
      Integer count = references.get(canonical);
      if (count == null) return false;
      if (count == 1) references.remove(canonical);
      else references.put(canonical, count - 1);
      return true;
    } catch (IOException ignored) {
      return false;
    }
  }

  static synchronized boolean delete(File file, long cutoff) {
    try {
      String canonical = file.getCanonicalPath();
      if (!isCachePath(canonical)) return false;
      for (String active : references.keySet()) {
        if (canonical.equals(active) || canonical.startsWith(active + File.separator)
            || active.startsWith(canonical + File.separator)) return false;
      }
      return file.lastModified() < cutoff && file.delete();
    } catch (IOException ignored) {
      return false;
    }
  }
}
