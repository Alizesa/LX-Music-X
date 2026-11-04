package cn.toside.music.mobile.utils;

import android.media.MediaExtractor;
import android.media.MediaFormat;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.WritableMap;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Collections;

/** Read signed playback media without saving a whole audio file or logging its URL. */
final class RemoteAudioProbe {
  private RemoteAudioProbe() {}

  static WritableMap read(String url, boolean inspectDuration) {
    WritableMap result = Arguments.createMap();
    result.putBoolean("readable", false);
    HttpURLConnection connection = null;
    String resolvedUrl;
    try {
      URL address = new URL(url);
      if (!"https".equals(address.getProtocol()) && !"http".equals(address.getProtocol())) return result;
      connection = (HttpURLConnection) address.openConnection();
      connection.setConnectTimeout(3000);
      connection.setReadTimeout(3000);
      connection.setInstanceFollowRedirects(true);
      connection.setRequestProperty("Range", "bytes=0-0");
      connection.setRequestProperty("Accept-Encoding", "identity");
      connection.setRequestProperty("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
      int status = connection.getResponseCode();
      if (status < 200 || status >= 300) return result;
      // Close after the first byte even if the server ignores Range.
      try (InputStream stream = connection.getInputStream()) {
        if (stream.read() < 0) return result;
      }
      resolvedUrl = connection.getURL().toString();
      result.putBoolean("readable", true);
    } catch (Exception ignored) {
      return result;
    } finally {
      if (connection != null) connection.disconnect();
    }
    if (!inspectDuration) return result;

    // Like MusicOne, a redirect parameter alone is not proof of a trial.
    MediaExtractor extractor = new MediaExtractor();
    try {
      extractor.setDataSource(resolvedUrl, Collections.emptyMap());
      for (int index = 0; index < extractor.getTrackCount(); index++) {
        MediaFormat format = extractor.getTrackFormat(index);
        String mime = format.getString(MediaFormat.KEY_MIME);
        if (mime == null || !mime.startsWith("audio/") || !format.containsKey(MediaFormat.KEY_DURATION)) continue;
        result.putString("mime", mime);
        result.putDouble("durationMs", format.getLong(MediaFormat.KEY_DURATION) / 1000.0);
        break;
      }
    } catch (Exception ignored) {
      // Unknown duration cannot establish that the track is complete.
    } finally {
      extractor.release();
    }
    return result;
  }
}
