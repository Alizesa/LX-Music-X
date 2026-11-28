package com.ocetnik.timer;

import android.os.Handler;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

public final class BackgroundTimerModuleTest {
  private static final class Context extends ReactApplicationContext {
    final List<Object> fired = new ArrayList<>();
    boolean active = true;
    @Override public boolean hasActiveReactInstance() { return active; }
    @Override public <T> T getJSModule(Class<T> type) {
      return type.cast((RCTDeviceEventEmitter) (name, value) -> fired.add(value));
    }
  }
  public static void main(String[] args) {
    Context c = new Context(), other = new Context();
    BackgroundTimerModule timer = new BackgroundTimerModule(c), sibling = new BackgroundTimerModule(other);
    for (int i = 1; i <= 2000; i++) timer.setTimeout(i, 15000);
    if (Handler.pending() != 2000) throw new AssertionError("deadlines not queued");
    for (int i = 1; i <= 2000; i++) timer.clearTimeout(i);
    if (Handler.pending() != 0) throw new AssertionError("cancelled messages still queued");
    timer.setTimeout(7, 5000); sibling.setTimeout(7, 5000); timer.clearTimeout(7);
    Handler.dequeue().run();
    if (!c.fired.isEmpty() || !other.fired.equals(Arrays.asList(7))) throw new AssertionError("wrong owner");
    timer.setTimeout(1, 100); Runnable alreadyDequeued = Handler.dequeue();
    timer.start(0); timer.setTimeout(2, 5000); sibling.setTimeout(3, 100);
    timer.invalidate(); timer.invalidate(); timer.setTimeout(4, 100); timer.start(0);
    alreadyDequeued.run();
    if (!c.fired.isEmpty() || Handler.pending() != 1) throw new AssertionError("invalidated owner leaked");
    Handler.dequeue().run(); other.active = false; sibling.setTimeout(5, 100); Handler.dequeue().run();
    if (!other.fired.equals(Arrays.asList(7, 3))) throw new AssertionError("lost sibling timer or emitted into inactive context");
  }
}
