package cn.toside.music.mobile.utils;

import com.facebook.react.uimanager.ThemedReactContext;
import com.facebook.react.uimanager.ViewGroupManager;

public final class HorizontalScrollHostManager extends ViewGroupManager<HorizontalScrollHostView> {
    @Override
    public String getName() {
        return "LXHorizontalScrollHost";
    }

    @Override
    protected HorizontalScrollHostView createViewInstance(ThemedReactContext reactContext) {
        return new HorizontalScrollHostView(reactContext);
    }
}
