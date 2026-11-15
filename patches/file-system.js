// Keep both Android selectors single-flight and settle pending directory results.
module.exports = [
  [
    'android/src/main/java/com/filesystem/FileSystemModule.java',
    '  ActivityEventListener activityEventListener;',
    `  private PickerListener activityEventListener;

  private abstract class PickerListener implements ActivityEventListener {
    private final Promise pendingPromise;
    PickerListener(Promise promise) { pendingPromise = promise; }
    protected abstract void onPickerResult(Activity activity, int requestCode, int resultCode, Intent data);

    @Override
    public final void onActivityResult(Activity activity, int requestCode, int resultCode, Intent data) {
      synchronized (FileSystemModule.this) {
        if (requestCode != REQUEST_CODE || activityEventListener != this) return;
        try {
          onPickerResult(activity, requestCode, resultCode, data);
        } catch (Exception error) {
          pendingPromise.reject("ERROR", error.getMessage());
        } finally {
          clearPicker();
        }
      }
    }

    void cancel() { pendingPromise.reject("E_PICKER_CANCELLED", "File selector was destroyed"); }
    @Override
    public void onNewIntent(Intent intent) {}
  }

  private void clearPicker() {
    if (activityEventListener == null) return;
    reactContext.removeActivityEventListener(activityEventListener);
    activityEventListener = null;
  }

  @Override
  public synchronized void invalidate() {
    try {
      if (activityEventListener != null) activityEventListener.cancel();
    } finally {
      clearPicker();
      super.invalidate();
    }
  }`,
  ],
  [
    'android/src/main/java/com/filesystem/FileSystemModule.java',
    `public void openDocumentTree(final boolean persist, final Promise promise) {
    // https://github.com/ammarahm-ed/react-native-scoped-storage/blob/a33b2078379e250eb18428fcb69ba8e477adfece/android/src/main/java/com/ammarahmed/scopedstorage/RNScopedStorageModule.java#L196
    try {
      Intent intent = new Intent();
      intent.setAction(Intent.ACTION_OPEN_DOCUMENT_TREE);

      if (activityEventListener != null) reactContext.removeActivityEventListener(activityEventListener);
      activityEventListener = new ActivityEventListener() {
        @SuppressLint("WrongConstant")
        @Override
        public void onActivityResult(Activity activity, int requestCode, int resultCode, Intent data) {
          if (requestCode != REQUEST_CODE) promise.reject("-1", "open document failed, code: " + requestCode);
          else if (resultCode == Activity.RESULT_CANCELED) promise.resolve(null);
          else if (resultCode != Activity.RESULT_OK) promise.reject("-1", "open document result failed: " + resultCode);
          else {
            if (data == null) promise.reject("-1", "data is null.");
            else {
              Uri uri = data.getData();
              if (uri == null) promise.reject("-1", "uri is null.");
              else {
                if (persist) {
                  final int takeFlags = data.getFlags()
                    & (Intent.FLAG_GRANT_READ_URI_PERMISSION
                    | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);

                  reactContext.getContentResolver().takePersistableUriPermission(uri, takeFlags);
                }
                DocumentFile dir = DocumentFile.fromTreeUri(reactContext, uri);
                if (dir == null) promise.reject("-1", "dir uri is null.");
                else promise.resolve(Utils.buildDocumentFile(dir));
              }
            }
          }
          reactContext.removeActivityEventListener(activityEventListener);
          activityEventListener = null;
        }

        @Override
        public void onNewIntent(Intent intent) {

        }
      };

      reactContext.addActivityEventListener(activityEventListener);
      Objects.requireNonNull(reactContext.getCurrentActivity()).startActivityForResult(intent, REQUEST_CODE);

    } catch (Exception e) {
      promise.reject("ERROR", e.getMessage());
    }
  }`,
    `public synchronized void openDocumentTree(final boolean persist, final Promise promise) {
    if (activityEventListener != null) {
      promise.reject("E_PICKER_IN_PROGRESS", "A file selector is already open");
      return;
    }
    // https://github.com/ammarahm-ed/react-native-scoped-storage/blob/a33b2078379e250eb18428fcb69ba8e477adfece/android/src/main/java/com/ammarahmed/scopedstorage/RNScopedStorageModule.java#L196
    try {
      Intent intent = new Intent();
      intent.setAction(Intent.ACTION_OPEN_DOCUMENT_TREE);

      
      activityEventListener = new PickerListener(promise) {
        @SuppressLint("WrongConstant")
        @Override
        protected void onPickerResult(Activity activity, int requestCode, int resultCode, Intent data) {
          if (resultCode == Activity.RESULT_CANCELED) promise.resolve(null);
          else if (resultCode != Activity.RESULT_OK) promise.reject("-1", "open document result failed: " + resultCode);
          else {
            if (data == null) promise.reject("-1", "data is null.");
            else {
              Uri uri = data.getData();
              if (uri == null) promise.reject("-1", "uri is null.");
              else {
                if (persist) {
                  final int takeFlags = data.getFlags()
                    & (Intent.FLAG_GRANT_READ_URI_PERMISSION
                    | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);

                  reactContext.getContentResolver().takePersistableUriPermission(uri, takeFlags);
                }
                DocumentFile dir = DocumentFile.fromTreeUri(reactContext, uri);
                if (dir == null) promise.reject("-1", "dir uri is null.");
                else promise.resolve(Utils.buildDocumentFile(dir));
              }
            }
          }
        }

        @Override
        public void onNewIntent(Intent intent) {

        }
      };

      reactContext.addActivityEventListener(activityEventListener);
      Objects.requireNonNull(reactContext.getCurrentActivity()).startActivityForResult(intent, REQUEST_CODE);

    } catch (Exception e) {
      clearPicker();
      promise.reject("ERROR", e.getMessage());
    }
  }`,
  ],
  [
    'android/src/main/java/com/filesystem/FileSystemModule.java',
    `public void openDocument(ReadableMap options, final Promise promise) {
    Bundle bundle = Arguments.toBundle(options);
    if (bundle == null) {
      promise.reject("-1", "options is null");
      return;
    }
    ReadableArray mimeTypesArr = options.getArray("mimeTypes");
    String[] mimeTypes;
    if (mimeTypesArr == null) {
      ReadableArray extTypesArr = options.getArray("extTypes");
      if (extTypesArr == null || extTypesArr.size() < 1) mimeTypes = new String[]{"*/*"};
      else {
        ArrayList<Object> extTypes = extTypesArr.toArrayList();
        ArrayList<String> mt = new ArrayList<>();
        for (Object e: extTypes) {
          String mime = Utils.getMimeTypeFromExt((String) e);
          if (mime != null) mt.add(mime);
        }
        mimeTypes = mt.size() > 0 ? mt.toArray(new String[0]) : new String[]{"*/*"};
      }
    } else mimeTypes = mimeTypesArr.toArrayList().toArray(new String[0]);

    boolean isMultiSelect = bundle.getBoolean("multi", false);
    String toPath = bundle.getString("toPath", null);
    String encoding = bundle.getString("encoding", "utf8");
    Log.d("FileSystem", "openDocument mimeTypes: " + Arrays.toString(mimeTypes));
    // https://github.com/ammarahm-ed/react-native-scoped-storage/blob/a33b2078379e250eb18428fcb69ba8e477adfece/android/src/main/java/com/ammarahmed/scopedstorage/RNScopedStorageModule.java#L312
    try {
      Intent intent = new Intent();
      intent.setAction(Intent.ACTION_OPEN_DOCUMENT);
      intent.addCategory(Intent.CATEGORY_OPENABLE);
      if (mimeTypes.length == 1) {
        intent.setType(mimeTypes[0]);
      } else {
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes);
      }
      if (isMultiSelect) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);


      if (activityEventListener != null) reactContext.removeActivityEventListener(activityEventListener);
      activityEventListener = new ActivityEventListener() {
        @Override
        public void onActivityResult(Activity activity, int requestCode, int resultCode, Intent data) {
          // Log.d("FileSystem", "openDocument requestCode: " + requestCode + " resultCode: " + resultCode);
          if (requestCode != REQUEST_CODE) promise.reject("-1", "open document failed, code: " + requestCode);
          else if (resultCode == Activity.RESULT_CANCELED) promise.resolve(null);
          else if (resultCode != Activity.RESULT_OK) promise.reject("-1", "open document result failed: " + resultCode);
          else {
            if (data == null) promise.reject("-1", "data is null.");
            else {
              Uri uri = data.getData();
              if (uri == null) promise.reject("-1", "uri is null.");
              else {
                DocumentFile fileUri = DocumentFile.fromSingleUri(reactContext, uri);
                if (fileUri == null) promise.reject("-1", "file uri is null.");
                else {
                  WritableMap params = Utils.buildDocumentFile(fileUri);
                  Callable<Object> callable;
                  if (toPath == null) callable = new Callables.ReadFile(reactContext, fileUri.getUri().toString(), encoding);
                  else {
                    String path = toPath + "/" + fileUri.getName();
                    Log.d("FileSystem", "openDocument toPath: " + path);
                    callable = new Callables.Cp(reactContext, fileUri.getUri().toString(), path);
                    params.putString("data", path);
                  }
                  AsyncTask.TaskRunner taskRunner = new AsyncTask.TaskRunner();
                  try {
                    taskRunner.executeAsync(callable, (Object result) -> {
                      taskRunner.shutdown();
                      if (result instanceof Exception) {
                        promise.reject("-1", ((Exception) result).getMessage());
                      } else {
                        if (toPath == null) params.putString("data", (String) result);
                        promise.resolve(params);
                      }
                    });
                  } catch (Exception err) {
                    promise.reject("-1", err.getMessage());
                  }
                }
              }
            }
          }
          reactContext.removeActivityEventListener(activityEventListener);
          activityEventListener = null;
        }

        @Override
        public void onNewIntent(Intent intent) {

        }
      };
      reactContext.addActivityEventListener(activityEventListener);
      Objects.requireNonNull(reactContext.getCurrentActivity()).startActivityForResult(intent, REQUEST_CODE);

    } catch (Exception e) {
      promise.reject("ERROR", e.getMessage());
    }
  }`,
    `public synchronized void openDocument(ReadableMap options, final Promise promise) {
    if (activityEventListener != null) {
      promise.reject("E_PICKER_IN_PROGRESS", "A file selector is already open");
      return;
    }
    Bundle bundle = Arguments.toBundle(options);
    if (bundle == null) {
      promise.reject("-1", "options is null");
      return;
    }
    ReadableArray mimeTypesArr = options.getArray("mimeTypes");
    String[] mimeTypes;
    if (mimeTypesArr == null) {
      ReadableArray extTypesArr = options.getArray("extTypes");
      if (extTypesArr == null || extTypesArr.size() < 1) mimeTypes = new String[]{"*/*"};
      else {
        ArrayList<Object> extTypes = extTypesArr.toArrayList();
        ArrayList<String> mt = new ArrayList<>();
        for (Object e: extTypes) {
          String mime = Utils.getMimeTypeFromExt((String) e);
          if (mime != null) mt.add(mime);
        }
        mimeTypes = mt.size() > 0 ? mt.toArray(new String[0]) : new String[]{"*/*"};
      }
    } else mimeTypes = mimeTypesArr.toArrayList().toArray(new String[0]);

    boolean isMultiSelect = bundle.getBoolean("multi", false);
    String toPath = bundle.getString("toPath", null);
    String encoding = bundle.getString("encoding", "utf8");
    Log.d("FileSystem", "openDocument mimeTypes: " + Arrays.toString(mimeTypes));
    // https://github.com/ammarahm-ed/react-native-scoped-storage/blob/a33b2078379e250eb18428fcb69ba8e477adfece/android/src/main/java/com/ammarahmed/scopedstorage/RNScopedStorageModule.java#L312
    try {
      Intent intent = new Intent();
      intent.setAction(Intent.ACTION_OPEN_DOCUMENT);
      intent.addCategory(Intent.CATEGORY_OPENABLE);
      if (mimeTypes.length == 1) {
        intent.setType(mimeTypes[0]);
      } else {
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes);
      }
      if (isMultiSelect) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);


      
      activityEventListener = new PickerListener(promise) {
        @Override
        protected void onPickerResult(Activity activity, int requestCode, int resultCode, Intent data) {
          // Log.d("FileSystem", "openDocument requestCode: " + requestCode + " resultCode: " + resultCode);
          if (resultCode == Activity.RESULT_CANCELED) promise.resolve(null);
          else if (resultCode != Activity.RESULT_OK) promise.reject("-1", "open document result failed: " + resultCode);
          else {
            if (data == null) promise.reject("-1", "data is null.");
            else {
              Uri uri = data.getData();
              if (uri == null) promise.reject("-1", "uri is null.");
              else {
                DocumentFile fileUri = DocumentFile.fromSingleUri(reactContext, uri);
                if (fileUri == null) promise.reject("-1", "file uri is null.");
                else {
                  WritableMap params = Utils.buildDocumentFile(fileUri);
                  Callable<Object> callable;
                  if (toPath == null) callable = new Callables.ReadFile(reactContext, fileUri.getUri().toString(), encoding);
                  else {
                    String path = toPath + "/" + fileUri.getName();
                    Log.d("FileSystem", "openDocument toPath: " + path);
                    callable = new Callables.Cp(reactContext, fileUri.getUri().toString(), path);
                    params.putString("data", path);
                  }
                  AsyncTask.TaskRunner taskRunner = new AsyncTask.TaskRunner();
                  try {
                    taskRunner.executeAsync(callable, (Object result) -> {
                      taskRunner.shutdown();
                      if (result instanceof Exception) {
                        promise.reject("-1", ((Exception) result).getMessage());
                      } else {
                        if (toPath == null) params.putString("data", (String) result);
                        promise.resolve(params);
                      }
                    });
                  } catch (Exception err) {
                    promise.reject("-1", err.getMessage());
                  }
                }
              }
            }
          }
        }

        @Override
        public void onNewIntent(Intent intent) {

        }
      };
      reactContext.addActivityEventListener(activityEventListener);
      Objects.requireNonNull(reactContext.getCurrentActivity()).startActivityForResult(intent, REQUEST_CODE);

    } catch (Exception e) {
      clearPicker();
      promise.reject("ERROR", e.getMessage());
    }
  }`,
  ],
]
