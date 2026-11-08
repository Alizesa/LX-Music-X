package com.guichaguri.trackplayer.service.player;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;
import java.lang.ref.WeakReference;

/** Only fixed diagnostic fields cross the bridge. URLs, headers and credentials never enter this logger. */
public final class PlaybackDebugLogger {
    private static volatile boolean enabled;
    private static volatile WeakReference<ReactApplicationContext> contextRef = new WeakReference<>(null);

    private PlaybackDebugLogger() {}

    public static void setEnabled(ReactApplicationContext context, boolean value) {
        contextRef = new WeakReference<>(context);
        enabled = value;
        event("", "logging_enabled", "", 0, 0, 0);
    }

    public static boolean isEnabled() { return enabled; }

    public static void event(String requestId, String stage, String reason, long bytes, long budget, long elapsedMs) {
        if (!enabled) return;
        try {
            ReactApplicationContext context = contextRef.get();
            if (context == null || !context.hasActiveCatalystInstance()) return;
            WritableMap data = Arguments.createMap();
            data.putString("audioId", requestId);
            data.putString("stage", stage);
            data.putString("reason", reason);
            data.putDouble("bytes", bytes);
            data.putDouble("budgetBytes", budget);
            data.putDouble("elapsedMs", elapsedMs);
            context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit("playback-preload-debug", data);
        } catch (Exception ignored) {
            // Diagnostics must not interfere with the audio worker or its cleanup.
        }
    }
}
