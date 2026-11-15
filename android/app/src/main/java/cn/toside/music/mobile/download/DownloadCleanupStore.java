package cn.toside.music.mobile.download;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.AtomicFile;
import android.util.Log;

import androidx.work.Data;

import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.FutureCallback;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.common.util.concurrent.MoreExecutors;
import com.google.common.util.concurrent.SettableFuture;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** Durable ownership of SAF destinations, including creation before an URI is returned. */
public final class DownloadCleanupStore {
  static final String CREATING = "creating";
  static final String DIRECT_CREATING = "direct-creating";
  static final String CREATED = "created";
  static final String RENAMING = "renaming";
  static final String WRITING = "writing";
  static final String DELETING = "deleting";
  static final String DELETED = "deleted";
  private static final String PREFIX = "lx-download-tmp-";
  private static final ExecutorService CLEANUPS = new ThreadPoolExecutor(2, 2, 0L, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(16));
  private static final ExecutorService SWEEPER = Executors.newSingleThreadExecutor();
  private static final Map<String, SettableFuture<Boolean>> IN_FLIGHT = new HashMap<>();
  private static SettableFuture<Void> sweep;

  static final class Record {
    final String workId;
    final String taskId;
    final String treeUri;
    final String finalName;
    final String prefix;
    String uri = "";
    String actualName = "";
    String phase = CREATING;

    Record(String workId, String taskId, String treeUri, String finalName, String prefix) {
      this.workId = workId;
      this.taskId = taskId;
      this.treeUri = treeUri;
      this.finalName = finalName;
      this.prefix = prefix;
    }

    String temporaryName() {
      int dot = finalName.lastIndexOf('.');
      return prefix + (dot > 0 ? finalName.substring(dot) : ".tmp");
    }
  }

  static final class Document {
    final String uri;
    final String name;
    Document(String uri, String name) { this.uri = uri; this.name = name; }
  }

  interface WorkGuard { boolean isActive(String workId); }

  interface Recovery {
    String completion(String workId) throws IOException;
    boolean completedFile(String uri) throws IOException;
    Document document(Record record, String uri) throws IOException;
    List<Document> find(Record record) throws IOException;
    boolean delete(Record record, String uri) throws IOException;
    void persist(Record record) throws IOException;
    void remove(Record record) throws IOException;
  }

  private DownloadCleanupStore() {}

  public static void recoverPending(Context context) {
    Futures.addCallback(cleanupAll(context.getApplicationContext(), MusicDownloadWorker::isRunning), new FutureCallback<Void>() {
      @Override public void onSuccess(Void ignored) {}
      @Override public void onFailure(Throwable error) { Log.w("LXDownload", "Pending destination cleanup will be retried", error); }
    }, MoreExecutors.directExecutor());
  }

  static synchronized Record begin(Context context, String workId, String taskId, String treeUri, String finalName) throws IOException {
    if (read(context, workId) != null) throw new IOException("A previous download destination still needs cleanup");
    Record record = new Record(workId, taskId, treeUri, finalName, PREFIX + UUID.randomUUID());
    save(context, record);
    return record;
  }

  static synchronized Record beginDirect(Context context, String workId, String taskId, String treeUri, String finalName) throws IOException {
    if (read(context, workId) != null) throw new IOException("A previous download destination still needs cleanup");
    Record record = new Record(workId, taskId, treeUri, finalName, PREFIX + UUID.randomUUID());
    record.phase = DIRECT_CREATING;
    save(context, record);
    return record;
  }

  static synchronized void prepareRename(Context context, Record record, String uri) throws IOException {
    record.uri = uri;
    record.actualName = record.temporaryName();
    record.phase = RENAMING;
    save(context, record);
  }

  static synchronized void prepareWrite(Context context, Record record, String uri, String name) throws IOException {
    record.uri = uri;
    record.actualName = name;
    record.phase = WRITING;
    save(context, record);
  }

  static synchronized void finishCompleted(Context context, String workId) throws IOException {
    Record record = read(context, workId);
    if (record == null) return;
    Data completion = DownloadCompletionStore.read(context, workId);
    if (completion == null) throw new IOException("Destination completion has not been committed");
    remove(context, workId);
  }

  static ListenableFuture<Boolean> cleanupWork(Context context, String workId, WorkGuard guard) throws IOException {
    if (read(context, workId) == null) return Futures.immediateFuture(true);
    SettableFuture<Boolean> pending;
    synchronized (IN_FLIGHT) {
      pending = IN_FLIGHT.get(workId);
      if (pending != null) return pending;
      pending = SettableFuture.create();
      IN_FLIGHT.put(workId, pending);
    }
    final SettableFuture<Boolean> future = pending;
    try {
      CLEANUPS.execute(() -> {
        boolean result = false;
        Exception failure = null;
        try {
          Record record = read(context, workId);
          if (record == null) result = true;
          else if (!guard.isActive(workId)) {
            cleanupRecord(record, recovery(context));
            result = true;
          }
        } catch (Exception error) {
          failure = error;
        } finally {
          synchronized (IN_FLIGHT) {
            if (IN_FLIGHT.get(workId) == future) IN_FLIGHT.remove(workId);
          }
        }
        if (failure == null) future.set(result);
        else future.setException(failure);
      });
    } catch (RuntimeException error) {
      synchronized (IN_FLIGHT) {
        if (IN_FLIGHT.get(workId) == future) IN_FLIGHT.remove(workId);
      }
      future.setException(error);
    }
    return future;
  }

  static ListenableFuture<Void> cleanupTask(Context context, String taskId, WorkGuard guard) throws IOException {
    List<ListenableFuture<Boolean>> pending = new ArrayList<>();
    for (String workId : ids(context)) {
      Record record = read(context, workId);
      if (record == null || !record.taskId.equals(taskId)) continue;
      pending.add(cleanupWork(context, workId, guard));
    }
    return Futures.transform(Futures.allAsList(pending), results -> {
      if (results.contains(false)) throw new IllegalStateException("A previous destination is still being written");
      return null;
    }, MoreExecutors.directExecutor());
  }

  static synchronized boolean hasPendingTask(Context context, String taskId) throws IOException {
    for (String workId : ids(context)) {
      Record record = read(context, workId);
      if (record != null && record.taskId.equals(taskId)) return true;
    }
    return false;
  }

  static ListenableFuture<Void> cleanupAll(Context context, WorkGuard guard) {
    SettableFuture<Void> pending;
    synchronized (IN_FLIGHT) {
      if (sweep != null) return sweep;
      sweep = pending = SettableFuture.create();
    }
    final SettableFuture<Void> future = pending;
    try { SWEEPER.execute(() -> {
      Exception failure = null;
      try {
        for (String workId : ids(context)) {
          if (guard.isActive(workId)) continue;
          try { cleanupWork(context, workId, guard).get(); }
          catch (ExecutionException error) { failure = error; }
          catch (IOException error) { failure = error; }
        }
      } catch (InterruptedException error) {
        Thread.currentThread().interrupt();
        failure = error;
      } catch (Exception error) {
        failure = error;
      } finally {
        synchronized (IN_FLIGHT) { if (sweep == future) sweep = null; }
      }
      if (failure == null) future.set(null);
      else future.setException(failure);
    }); } catch (RuntimeException error) {
      synchronized (IN_FLIGHT) { if (sweep == future) sweep = null; }
      future.setException(error);
    }
    return future;
  }

  static synchronized Set<String> reservedNames(Context context, String treeUri) throws IOException {
    Set<String> names = new HashSet<>();
    for (String workId : ids(context)) {
      Record record = read(context, workId);
      if (record == null || !record.treeUri.equals(treeUri) || DELETED.equals(record.phase)) continue;
      names.add(record.finalName);
      if (!record.actualName.isEmpty()) names.add(record.actualName);
    }
    return names;
  }

  // Keep the policy separate from I/O so terminal and restart paths are reviewable.
  static void cleanupRecord(Record record, Recovery recovery) throws IOException {
    if (DELETED.equals(record.phase) || recovery.completion(record.workId) != null) {
      recovery.remove(record);
      return;
    }
    Document document;
    if (record.uri.isEmpty()) {
      if (DIRECT_CREATING.equals(record.phase)) throw new IOException("Unconfirmed destination creation needs recovery");
      List<Document> candidates = recovery.find(record);
      if (candidates.size() > 1) throw new IOException("Ambiguous temporary download destination");
      document = candidates.isEmpty() ? null : candidates.get(0);
      if (document != null) {
        record.uri = document.uri;
        record.actualName = document.name;
        record.phase = CREATED;
        recovery.persist(record);
      }
    } else {
      document = recovery.document(record, record.uri);
    }
    if (document == null) {
      // A rename may change document IDs. Never guess that an ordinary same-name
      // document is ours when the provider's new URI was not durably returned.
      if (RENAMING.equals(record.phase)) throw new IOException("Unconfirmed download rename needs recovery");
      retireDeleted(record, recovery);
      return;
    }
    if (recovery.completedFile(document.uri)) {
      retireDeleted(record, recovery);
      return;
    }
    boolean temporary = document.name.startsWith(record.prefix);
    if (DELETING.equals(record.phase) && !temporary) throw new IOException("Unconfirmed destination deletion needs recovery");
    boolean confirmedRename = RENAMING.equals(record.phase) && document.uri.equals(record.uri) && document.name.equals(record.finalName);
    if (WRITING.equals(record.phase) ? !document.name.equals(record.actualName) : !temporary && !confirmedRename) {
      throw new IOException("Download destination identity changed");
    }
    String previous = record.phase;
    record.phase = DELETING;
    recovery.persist(record);
    if (!recovery.delete(record, document.uri)) {
      record.phase = previous;
      recovery.persist(record);
      throw new IOException("Unable to delete pending download destination");
    }
    retireDeleted(record, recovery);
  }

  private static void retireDeleted(Record record, Recovery recovery) throws IOException {
    record.phase = DELETED;
    recovery.persist(record);
    recovery.remove(record);
  }

  private static Recovery recovery(Context context) {
    return new Recovery() {
      @Override public String completion(String workId) throws IOException {
        Data data = DownloadCompletionStore.read(context, workId);
        return data == null ? null : data.getString(MusicDownloadWorker.KEY_FILE_URI);
      }
      @Override public boolean completedFile(String uri) throws IOException {
        for (String id : DownloadCompletionStore.ids(context)) {
          Data data = DownloadCompletionStore.read(context, id);
          if (data != null && uri.equals(data.getString(MusicDownloadWorker.KEY_FILE_URI))) return true;
        }
        return false;
      }
      @Override public Document document(Record record, String uri) throws IOException { return readDocument(context, record, uri); }
      @Override public List<Document> find(Record record) throws IOException { return findDocuments(context, record); }
      @Override public boolean delete(Record record, String uri) throws IOException {
        try { return DocumentsContract.deleteDocument(context.getContentResolver(), scopedUri(record, uri)); }
        catch (Exception error) { throw new IOException("Unable to delete download destination", error); }
      }
      @Override public void persist(Record record) throws IOException { save(context, record); }
      @Override public void remove(Record record) throws IOException { DownloadCleanupStore.remove(context, record.workId); }
    };
  }

  private static Uri scopedUri(Record record, String path) throws IOException {
    try {
      Uri tree = Uri.parse(record.treeUri);
      Uri document = Uri.parse(path);
      if (!"content".equals(document.getScheme()) || !tree.getAuthority().equals(document.getAuthority())) throw new IOException("Unexpected destination authority");
      String id = DocumentsContract.getDocumentId(document);
      if (id.equals(DocumentsContract.getTreeDocumentId(tree))) throw new IOException("Refusing to delete a download directory");
      return DocumentsContract.buildDocumentUriUsingTree(tree, id);
    } catch (Exception error) {
      throw new IOException("Invalid download destination URI", error);
    }
  }

  private static Document readDocument(Context context, Record record, String path) throws IOException {
    Uri uri = scopedUri(record, path);
    try (Cursor cursor = context.getContentResolver().query(uri,
      new String[] { DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE }, null, null, null)) {
      if (cursor == null) {
        List<Document> found = scanDocuments(context, record, DocumentsContract.getDocumentId(uri));
        if (found.size() > 1) throw new IOException("Ambiguous destination ID");
        return found.isEmpty() ? null : found.get(0);
      }
      if (!cursor.moveToFirst()) return null;
      if (DocumentsContract.Document.MIME_TYPE_DIR.equals(cursor.getString(1))) throw new IOException("Refusing to clean a directory");
      String name = cursor.getString(0);
      if (name == null) throw new IOException("Unable to verify destination name");
      return new Document(path, name);
    } catch (Exception error) {
      throw new IOException("Unable to read download destination", error);
    }
  }

  private static List<Document> findDocuments(Context context, Record record) throws IOException {
    return scanDocuments(context, record, null);
  }

  private static List<Document> scanDocuments(Context context, Record record, String targetId) throws IOException {
    List<Document> found = new ArrayList<>();
    try {
      Uri tree = Uri.parse(record.treeUri);
      Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
      try (Cursor cursor = context.getContentResolver().query(children,
        new String[] { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE }, null, null, null)) {
        if (cursor == null) throw new IOException("Unable to recover destination creation");
        while (cursor.moveToNext()) {
          String name = cursor.getString(1);
          String id = cursor.getString(0);
          boolean matched = targetId == null ? name != null && name.startsWith(record.prefix) : targetId.equals(id);
          if (matched && DocumentsContract.Document.MIME_TYPE_DIR.equals(cursor.getString(2))) {
            if (targetId != null) throw new IOException("Refusing to clean a directory");
          } else if (matched) {
            if (name == null) throw new IOException("Unable to verify destination name");
            found.add(new Document(DocumentsContract.buildDocumentUriUsingTree(tree, cursor.getString(0)).toString(), name));
          }
        }
      }
    } catch (Exception error) {
      throw new IOException("Unable to locate temporary download destination", error);
    }
    return found;
  }

  private static File directory(Context context) { return new File(new File(context.getFilesDir(), "downloads"), "pending-targets"); }

  private static AtomicFile file(Context context, String workId) {
    return new AtomicFile(new File(directory(context), UUID.fromString(workId).toString() + ".json"));
  }

  private static synchronized void save(Context context, Record record) throws IOException {
    File directory = directory(context);
    if (!directory.exists() && !directory.mkdirs()) throw new IOException("Unable to create destination journal");
    AtomicFile file = file(context, record.workId);
    FileOutputStream output = null;
    try {
      JSONObject value = new JSONObject();
      value.put("workId", record.workId);
      value.put("taskId", record.taskId);
      value.put("treeUri", record.treeUri);
      value.put("finalName", record.finalName);
      value.put("prefix", record.prefix);
      value.put("uri", record.uri);
      value.put("actualName", record.actualName);
      value.put("phase", record.phase);
      byte[] bytes = value.toString().getBytes(StandardCharsets.UTF_8);
      if (bytes.length > 64 * 1024) throw new IOException("Destination journal exceeds its byte budget");
      output = file.startWrite();
      output.write(bytes);
      output.getFD().sync();
      file.finishWrite(output);
      Record committed = read(context, record.workId);
      if (committed == null || !committed.phase.equals(record.phase) || !committed.uri.equals(record.uri)) throw new IOException("Destination journal commit failed");
    } catch (Exception error) {
      if (output != null) file.failWrite(output);
      throw new IOException("Unable to commit destination ownership", error);
    }
  }

  private static synchronized Record read(Context context, String workId) throws IOException {
    AtomicFile file = file(context, workId);
    File base = file.getBaseFile();
    if (!base.exists() && !new File(base.getPath() + ".bak").exists()) return null;
    try (FileInputStream input = file.openRead()) {
      long size = input.getChannel().size();
      if (size <= 0 || size > 64 * 1024) throw new IOException("Invalid destination journal size");
      byte[] bytes = new byte[(int) size];
      int offset = 0;
      while (offset < bytes.length) {
        int count = input.read(bytes, offset, bytes.length - offset);
        if (count < 0) throw new IOException("Incomplete destination journal");
        offset += count;
      }
      JSONObject value = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
      if (!workId.equals(value.getString("workId"))) throw new IOException("Mismatched destination journal");
      String prefix = value.getString("prefix");
      if (!prefix.startsWith(PREFIX) || !UUID.fromString(prefix.substring(PREFIX.length())).toString().equals(prefix.substring(PREFIX.length()))) throw new IOException("Invalid destination marker");
      Record record = new Record(workId, value.getString("taskId"), value.getString("treeUri"), value.getString("finalName"), prefix);
      record.uri = value.getString("uri");
      record.actualName = value.getString("actualName");
      record.phase = value.getString("phase");
      if (!CREATING.equals(record.phase) && !DIRECT_CREATING.equals(record.phase) && !CREATED.equals(record.phase) && !RENAMING.equals(record.phase) && !WRITING.equals(record.phase) && !DELETING.equals(record.phase) && !DELETED.equals(record.phase)) throw new IOException("Invalid destination phase");
      return record;
    } catch (Exception error) {
      throw new IOException("Unable to read destination ownership", error);
    }
  }

  private static synchronized void remove(Context context, String workId) throws IOException {
    AtomicFile file = file(context, workId);
    file.delete();
    File base = file.getBaseFile();
    if (base.exists() || new File(base.getPath() + ".bak").exists()) throw new IOException("Unable to retire destination journal");
  }

  private static synchronized List<String> ids(Context context) throws IOException {
    Set<String> ids = new HashSet<>();
    File directory = directory(context);
    if (!directory.exists()) return new ArrayList<>();
    File[] files = directory.listFiles();
    if (files == null) throw new IOException("Unable to list pending destinations");
    for (File file : files) {
      String name = file.getName();
      if (name.endsWith(".json")) ids.add(name.substring(0, name.length() - 5));
      else if (name.endsWith(".json.bak")) ids.add(name.substring(0, name.length() - 9));
    }
    return new ArrayList<>(ids);
  }
}
