package cn.toside.music.mobile.cache;

import java.io.File;

// https://github.com/midas-gufei/react-native-clear-app-cache/tree/master/android/src/main/java/com/learnta/clear
public class Utils {
  /**
   * 获取目录文件大小
   *
   * @param dir
   * @return
   */
  static public long getDirSize(File dir) {
    if (dir == null || !dir.isDirectory()) return 0;
    long dirSize = 0;
    File[] files = dir.listFiles();
    if (files == null) return dirSize;
    for (File file : files) {
      if (file.isFile()) {
        dirSize += file.length();
      } else if (file.isDirectory()) {
        dirSize += file.length();
        dirSize += getDirSize(file); // 递归调用继续统计
      }
    }
    return dirSize;
  }

  /**
   * 清除缓存目录
   * 目录
   * 当前系统时间
   */
  static public int clearCacheFolder(File dir, long curTime) {
    int deletedFiles = 0;
    if (dir == null || !dir.isDirectory()) return deletedFiles;
    File[] files = dir.listFiles();
    if (files == null) return deletedFiles;
    try {
      for (File child : files) {
        if (child.isDirectory()) {
          deletedFiles += clearCacheFolder(child, curTime);
        }
        if (child.lastModified() < curTime) {
          if (child.delete()) {
            deletedFiles++;
          }
        }
      }
    } catch (Exception e) {
      e.printStackTrace();
    }
    return deletedFiles;
  }
}
