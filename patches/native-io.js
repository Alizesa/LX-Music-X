// SAF copy buffers and paired local lyric descriptor cleanup.
module.exports = [
  [
    'react-native-local-media-metadata/android/src/main/java/com/localmediametadata/MediaFile.java',
    `private File createTempFile() throws IOException {
    this.tempFile = new File(createPath(isDocFile() ? dFile.getName() : file.getName()));
    Log.d("MediaFile", "creating temp file: " + tempFile.getAbsolutePath());
    try (InputStream inputStream = isDocFile() ? Utils.createInputStream(context, dFile) : Utils.createInputStream(file);
         OutputStream outputStream = Utils.createOutputStream(tempFile)) {
      byte[] buffer = new byte[1024];
      int length;
      while ((length = inputStream.read(buffer)) > 0) {
        outputStream.write(buffer, 0, length);
      }
    }
    return tempFile;
  }`,
    `private File createTempFile() throws IOException {
    this.tempFile = new File(createPath(isDocFile() ? dFile.getName() : file.getName()));
    Log.d("MediaFile", "creating temp file: " + tempFile.getAbsolutePath());
    try (InputStream inputStream = isDocFile() ? Utils.createInputStream(context, dFile) : Utils.createInputStream(file);
         OutputStream outputStream = Utils.createOutputStream(tempFile)) {
      byte[] buffer = new byte[64 * 1024];
      int length;
      while ((length = inputStream.read(buffer)) > 0) {
        outputStream.write(buffer, 0, length);
      }
    }
    return tempFile;
  }`,
  ],
  [
    'react-native-local-media-metadata/android/src/main/java/com/localmediametadata/MediaFile.java',
    `public void closeFile() throws IOException {
    if (parcelFileDescriptor != null) {
      try {
        parcelFileDescriptor.close();
      } catch (Exception ignored) {}
      parcelFileDescriptor = null;
    }
    if (tempFile != null) {
      Log.d("MediaFile", "closeFile");
      if (isWrite) {
        try (InputStream inputStream = Utils.createInputStream(tempFile);
             OutputStream outputStream = isDocFile()
               ? Utils.createOutputStream(context, this.dFile.getUri())
               : Utils.createOutputStream(this.file)) {
          byte[] buffer = new byte[1024];
          int length;
          while ((length = inputStream.read(buffer)) > 0) {
            outputStream.write(buffer, 0, length);
          }
        }
      }
      try {
        tempFile.delete();
      } catch (Exception ignored) {}
      tempFile = null;
    }
  }`,
    `public void closeFile() throws IOException {
    if (parcelFileDescriptor != null) {
      try {
        parcelFileDescriptor.close();
      } catch (Exception ignored) {}
      parcelFileDescriptor = null;
    }
    if (tempFile != null) {
      Log.d("MediaFile", "closeFile");
      if (isWrite) {
        try (InputStream inputStream = Utils.createInputStream(tempFile);
             OutputStream outputStream = isDocFile()
               ? Utils.createOutputStream(context, this.dFile.getUri())
               : Utils.createOutputStream(this.file)) {
          byte[] buffer = new byte[64 * 1024];
          int length;
          while ((length = inputStream.read(buffer)) > 0) {
            outputStream.write(buffer, 0, length);
          }
        }
      }
      try {
        tempFile.delete();
      } catch (Exception ignored) {}
      tempFile = null;
    }
  }`,
  ],
  [
    'react-native-local-media-metadata/android/src/main/java/com/localmediametadata/Metadata.java',
    `public static String readLyricFile(File lrcFile) {
    try {
      FileInputStream fileInputStream = new FileInputStream(lrcFile);
      ByteArrayOutputStream byteArrayOutputStream = new ByteArrayOutputStream();
      byte[] buffer = new byte[1024];
      int bytesRead;
      while ((bytesRead = fileInputStream.read(buffer)) != -1) {
        byteArrayOutputStream.write(buffer, 0, bytesRead);
      }
      fileInputStream.close();
      return Utils.decodeString(byteArrayOutputStream.toByteArray());
    } catch (Exception e) {
      e.printStackTrace();
      return "";
    }
  }`,
    `public static String readLyricFile(File lrcFile) {
    try (FileInputStream fileInputStream = new FileInputStream(lrcFile);
         ByteArrayOutputStream byteArrayOutputStream = new ByteArrayOutputStream()) {
      byte[] buffer = new byte[8 * 1024];
      int bytesRead;
      while ((bytesRead = fileInputStream.read(buffer)) != -1) {
        byteArrayOutputStream.write(buffer, 0, bytesRead);
      }
      return Utils.decodeString(byteArrayOutputStream.toByteArray());
    } catch (Exception e) {
      e.printStackTrace();
      return "";
    }
  }`,
  ],
  [
    'react-native-local-media-metadata/android/src/main/java/com/localmediametadata/Metadata.java',
    `public static String readLyric(ReactApplicationContext context, String filePath, boolean isReadLrcFile) throws Exception {
    MediaFile mediaFile = new MediaFile(context, filePath);
    MediaFile lrcMediaFile = isReadLrcFile ? new MediaFile(context, filePath.substring(0, filePath.lastIndexOf(".")) + ".lrc") : null;
    try {
      File file = mediaFile.getFile(false);
      if (isReadLrcFile && lrcMediaFile.exists()) {
        String lrc = readLyricFile(lrcMediaFile.getFile(false));
        if (!"".equals(lrc)) return lrc;
      }

      org.jaudiotagger.audio.AudioFile audioFile = AudioFileIO.read(file);
      Tag tag = audioFile.getTagOrCreateDefault();
      return tag.getFirst(FieldKey.LYRICS);
    } finally {
      mediaFile.closeFile();
    }
  }`,
    `public static String readLyric(ReactApplicationContext context, String filePath, boolean isReadLrcFile) throws Exception {
    MediaFile mediaFile = new MediaFile(context, filePath);
    MediaFile lrcMediaFile = isReadLrcFile ? new MediaFile(context, filePath.substring(0, filePath.lastIndexOf(".")) + ".lrc") : null;
    try {
      File file = mediaFile.getFile(false);
      if (isReadLrcFile && lrcMediaFile.exists()) {
        String lrc = readLyricFile(lrcMediaFile.getFile(false));
        if (!"".equals(lrc)) return lrc;
      }

      org.jaudiotagger.audio.AudioFile audioFile = AudioFileIO.read(file);
      Tag tag = audioFile.getTagOrCreateDefault();
      return tag.getFirst(FieldKey.LYRICS);
    } finally {
      try {
        mediaFile.closeFile();
      } finally {
        if (lrcMediaFile != null) lrcMediaFile.closeFile();
      }
    }
  }`,
  ],
  [
    'react-native-file-system/android/src/main/java/com/filesystem/FileSystem.java',
    `public static void cp(ReactApplicationContext reactContext, String fromPath, String toPath) throws IOException {
    try (InputStream inputStream = Utils.createInputStream(reactContext, fromPath);
         OutputStream outputStream = Utils.createOutputStream(reactContext, toPath)) {
      byte[] buffer = new byte[1024];
      int length;
      while ((length = inputStream.read(buffer)) > 0) {
        outputStream.write(buffer, 0, length);
      }
    }
  }`,
    `public static void cp(ReactApplicationContext reactContext, String fromPath, String toPath) throws IOException {
    try (InputStream inputStream = Utils.createInputStream(reactContext, fromPath);
         OutputStream outputStream = Utils.createOutputStream(reactContext, toPath)) {
      byte[] buffer = new byte[64 * 1024];
      int length;
      while ((length = inputStream.read(buffer)) > 0) {
        outputStream.write(buffer, 0, length);
      }
    }
  }`,
  ],
]
