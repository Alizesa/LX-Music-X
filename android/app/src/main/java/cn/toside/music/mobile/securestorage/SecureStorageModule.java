package cn.toside.music.mobile.securestorage;

import android.content.SharedPreferences;

import androidx.annotation.NonNull;
import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

public class SecureStorageModule extends ReactContextBaseJavaModule {
  private final SharedPreferences preferences;

  SecureStorageModule(ReactApplicationContext reactContext) {
    super(reactContext);
    try {
      MasterKey masterKey = new MasterKey.Builder(reactContext)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build();
      preferences = EncryptedSharedPreferences.create(
        reactContext,
        "lx_music_x_secure_storage",
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
      );
    } catch (Exception error) {
      throw new IllegalStateException("Unable to initialize encrypted storage", error);
    }
  }

  @NonNull
  @Override
  public String getName() {
    return "SecureStorageModule";
  }

  @ReactMethod
  public void getItem(String key, Promise promise) {
    try {
      promise.resolve(preferences.getString(key, null));
    } catch (Exception error) {
      promise.reject("secure_storage_read_failed", error);
    }
  }

  @ReactMethod
  public void setItem(String key, String value, Promise promise) {
    try {
      if (!preferences.edit().putString(key, value).commit()) throw new IllegalStateException("Unable to save secure value");
      promise.resolve(null);
    } catch (Exception error) {
      promise.reject("secure_storage_write_failed", error);
    }
  }

  @ReactMethod
  public void removeItem(String key, Promise promise) {
    try {
      if (!preferences.edit().remove(key).commit()) throw new IllegalStateException("Unable to remove secure value");
      promise.resolve(null);
    } catch (Exception error) {
      promise.reject("secure_storage_remove_failed", error);
    }
  }
}
