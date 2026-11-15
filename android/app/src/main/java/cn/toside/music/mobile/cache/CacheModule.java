package cn.toside.music.mobile.cache;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import static cn.toside.music.mobile.cache.Utils.clearCacheFolder;
import static cn.toside.music.mobile.cache.Utils.getDirSize;

// https://github.com/midas-gufei/react-native-clear-app-cache/tree/master/android/src/main/java/com/learnta/clear
public class CacheModule extends ReactContextBaseJavaModule {
  private final CacheModule cacheModule;
  private static final ExecutorService STATISTICS = Executors.newSingleThreadExecutor();
  private final Object statisticsLock = new Object();
  private List<Promise> statisticsWaiters = new ArrayList<>();
  private boolean statisticsPending;

  CacheModule(ReactApplicationContext reactContext) {
    super(reactContext);
    this.cacheModule = this;
    ActiveCachePaths.configure(reactContext.getCacheDir(), reactContext.getExternalCacheDir());
  }

  @Override
  public String getName() {
    return "CacheModule";
  }

  @ReactMethod(isBlockingSynchronousMethod = true)
  public boolean protectCachePath(String path) {
    return ActiveCachePaths.retain(path);
  }

  @ReactMethod(isBlockingSynchronousMethod = true)
  public boolean unprotectCachePath(String path) {
    return ActiveCachePaths.release(path);
  }


  @ReactMethod
  public void getAppCacheSize(Promise promise) {
    synchronized (statisticsLock) {
      statisticsWaiters.add(promise);
      if (statisticsPending) return;
      statisticsPending = true;
    }
    STATISTICS.execute(this::readCacheSize);
  }

  private void readCacheSize() {
    String size = null;
    Exception failure = null;
    try {
      long fileSize = getDirSize(getReactApplicationContext().getCacheDir())
        + getDirSize(getReactApplicationContext().getExternalCacheDir());
      size = String.valueOf(fileSize);
    } catch (Exception error) {
      failure = error;
    }
    List<Promise> waiters;
    synchronized (statisticsLock) {
      waiters = statisticsWaiters;
      statisticsWaiters = new ArrayList<>();
      statisticsPending = false;
    }
    for (Promise waiter : waiters) {
      if (failure == null) waiter.resolve(size);
      else waiter.reject("cache_size_failed", failure);
    }
  }

  //清除缓存
  @ReactMethod
  public void clearAppCache(Promise promise) {
    CacheClearAsyncTask asyncTask = new CacheClearAsyncTask(cacheModule, promise);
    asyncTask.execute(10);
  }

  /**
   * 清除app缓存
   */
  public void clearCache() {

    getReactApplicationContext().deleteDatabase("webview.db");
    getReactApplicationContext().deleteDatabase("webview.db-shm");
    getReactApplicationContext().deleteDatabase("webview.db-wal");
    getReactApplicationContext().deleteDatabase("webviewCache.db");
    getReactApplicationContext().deleteDatabase("webviewCache.db-shm");
    getReactApplicationContext().deleteDatabase("webviewCache.db-wal");
    //清除数据缓存
    // clearCacheFolder(getReactApplicationContext().getFilesDir(), System.currentTimeMillis());
    clearCacheFolder(getReactApplicationContext().getCacheDir(), System.currentTimeMillis());
    clearCacheFolder(getReactApplicationContext().getExternalCacheDir(), System.currentTimeMillis());

  }

}
