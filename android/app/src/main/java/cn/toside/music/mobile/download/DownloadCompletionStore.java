package cn.toside.music.mobile.download;

import android.content.Context;
import android.util.AtomicFile;

import androidx.work.Data;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

// WorkManager 可以自动清理终态；文件归属凭据必须保留到 JS 已持久归档。
final class DownloadCompletionStore {
  private DownloadCompletionStore() {}

  private static File directory(Context context) {
    return new File(new File(context.getFilesDir(), "downloads"), "completions");
  }

  private static AtomicFile file(Context context, String workId) {
    String identity = UUID.fromString(workId).toString();
    return new AtomicFile(new File(directory(context), identity + ".json"));
  }

  static synchronized void save(Context context, String workId, String taskId, String path, String name, long downloaded, long total) throws IOException {
    File directory = directory(context);
    if (!directory.exists() && !directory.mkdirs()) throw new IOException("Unable to create completion directory");
    AtomicFile file = file(context, workId);
    FileOutputStream output = null;
    try {
      JSONObject value = new JSONObject();
      value.put("nativeId", workId);
      value.put(MusicDownloadWorker.KEY_TASK_ID, taskId);
      value.put(MusicDownloadWorker.KEY_FILE_URI, path);
      value.put(MusicDownloadWorker.KEY_FILE_NAME, name);
      value.put(MusicDownloadWorker.KEY_DOWNLOADED, downloaded);
      value.put(MusicDownloadWorker.KEY_TOTAL, total);
      output = file.startWrite();
      output.write(value.toString().getBytes(StandardCharsets.UTF_8));
      output.getFD().sync();
      file.finishWrite(output);
      if (!path.equals(read(context, workId).getString(MusicDownloadWorker.KEY_FILE_URI))) throw new IOException("Download completion commit failed");
    } catch (Exception error) {
      if (output != null) file.failWrite(output);
      throw new IOException("Unable to save download completion", error);
    }
  }

  static synchronized Data read(Context context, String workId) throws IOException {
    AtomicFile file = file(context, workId);
    File base = file.getBaseFile();
    if (!base.exists() && !new File(base.getPath() + ".bak").exists()) return null;
    try (FileInputStream input = file.openRead()) {
      long size = input.getChannel().size();
      if (size <= 0 || size > 64 * 1024) throw new IOException("Invalid download completion size");
      byte[] bytes = new byte[(int) size];
      int offset = 0;
      while (offset < bytes.length) {
        int count = input.read(bytes, offset, bytes.length - offset);
        if (count < 0) throw new IOException("Incomplete download completion");
        offset += count;
      }
      JSONObject value = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
      if (!workId.equals(value.getString("nativeId"))) throw new IOException("Mismatched download completion");
      return new Data.Builder()
        .putString(MusicDownloadWorker.KEY_TASK_ID, value.getString(MusicDownloadWorker.KEY_TASK_ID))
        .putString(MusicDownloadWorker.KEY_FILE_URI, value.getString(MusicDownloadWorker.KEY_FILE_URI))
        .putString(MusicDownloadWorker.KEY_FILE_NAME, value.getString(MusicDownloadWorker.KEY_FILE_NAME))
        .putLong(MusicDownloadWorker.KEY_DOWNLOADED, value.getLong(MusicDownloadWorker.KEY_DOWNLOADED))
        .putLong(MusicDownloadWorker.KEY_TOTAL, value.getLong(MusicDownloadWorker.KEY_TOTAL))
        .build();
    } catch (Exception error) {
      throw new IOException("Unable to read download completion", error);
    }
  }

  static synchronized void acknowledge(Context context, String workId) throws IOException {
    AtomicFile file = file(context, workId);
    file.delete();
    File base = file.getBaseFile();
    if (base.exists() || new File(base.getPath() + ".bak").exists()) throw new IOException("Unable to remove download completion");
  }

  static synchronized List<String> ids(Context context) throws IOException {
    File directory = directory(context);
    List<String> ids = new ArrayList<>();
    if (!directory.exists()) return ids;
    File[] files = directory.listFiles();
    if (files == null) throw new IOException("Unable to list download completions");
    for (File file : files) {
      String name = file.getName();
      if (name.endsWith(".json")) ids.add(name.substring(0, name.length() - 5));
      // AtomicFile 遗留的 .bak 仍是有效凭据，openRead 会恢复它。
      else if (name.endsWith(".json.bak")) ids.add(name.substring(0, name.length() - 9));
    }
    return ids;
  }
}
