package cn.toside.music.mobile.download;

import android.content.Context;
import android.util.AtomicFile;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/** A task may be resumed by a new WorkManager ID; its partial file follows that owner. */
final class DownloadPartialStore {
  private static final Map<String, String> WRITERS = new HashMap<>();

  private DownloadPartialStore() {}

  private static AtomicFile file(Context context, String taskId) {
    return new AtomicFile(new File(MusicDownloadWorker.getPartialFile(context, taskId).getPath() + ".owner"));
  }

  private static String owner(Context context, String taskId) throws IOException {
    AtomicFile file = file(context, taskId);
    File base = file.getBaseFile();
    if (!base.exists() && !new File(base.getPath() + ".bak").exists()) return null;
    try (FileInputStream input = file.openRead()) {
      long length = input.getChannel().size();
      if (length != 36) throw new IOException("Invalid partial download owner");
      byte[] bytes = new byte[36];
      int offset = 0;
      while (offset < bytes.length) {
        int count = input.read(bytes, offset, bytes.length - offset);
        if (count < 0) throw new IOException("Incomplete partial download owner");
        offset += count;
      }
      String workId = new String(bytes, StandardCharsets.UTF_8);
      if (!UUID.fromString(workId).toString().equals(workId)) throw new IOException("Invalid partial download identity");
      return workId;
    } catch (RuntimeException error) {
      throw new IOException("Unable to read partial download owner", error);
    }
  }

  static synchronized void begin(Context context, String taskId, String workId) throws IOException {
    if (WRITERS.containsKey(taskId) || MusicDownloadWorker.otherTaskRunning(taskId, workId)) throw new IOException("A previous partial download is still active");
    AtomicFile file = file(context, taskId);
    FileOutputStream output = null;
    try {
      output = file.startWrite();
      output.write(UUID.fromString(workId).toString().getBytes(StandardCharsets.UTF_8));
      output.getFD().sync();
      file.finishWrite(output);
      if (!workId.equals(owner(context, taskId))) throw new IOException("Partial ownership commit failed");
      WRITERS.put(taskId, workId);
    } catch (Exception error) {
      if (output != null) file.failWrite(output);
      throw new IOException("Unable to record partial download ownership", error);
    }
  }

  static synchronized void end(String taskId, String workId) {
    if (workId.equals(WRITERS.get(taskId))) WRITERS.remove(taskId);
  }

  static synchronized boolean clear(Context context, String taskId, String workId) throws IOException {
    String owner = owner(context, taskId);
    if (workId != null && !workId.isEmpty() && owner != null && !workId.equals(owner)) return true;
    if (WRITERS.containsKey(taskId) || MusicDownloadWorker.otherTaskRunning(taskId, workId)) return false;
    File partial = MusicDownloadWorker.getPartialFile(context, taskId);
    if (partial.exists() && !partial.delete()) return false;
    AtomicFile ownership = file(context, taskId);
    ownership.delete();
    File base = ownership.getBaseFile();
    return !base.exists() && !new File(base.getPath() + ".bak").exists();
  }
}
