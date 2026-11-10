package cn.toside.music.mobile.utils;

import android.content.Context;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewParent;

import com.facebook.react.uimanager.events.NativeGestureUtil;
import com.facebook.react.views.view.ReactViewGroup;

/**
 * Keeps a touch that starts inside a horizontal list away from horizontal ancestors.
 * Ownership is decided on the UI thread, before PagerView or a vertical ScrollView
 * can intercept the first move; it does not depend on a JS scrollEnabled command.
 */
public final class HorizontalScrollHostView extends ReactViewGroup {
    private static final int IDLE = 0;
    private static final int UNDECIDED = 1;
    private static final int HORIZONTAL = 2;
    private static final int VERTICAL = 3;

    private final int touchSlop;
    private int direction = IDLE;
    private int pointerId = -1;
    private float startX;
    private float startY;
    private boolean nativeGestureStarted;

    public HorizontalScrollHostView(Context context) {
        super(context);
        touchSlop = ViewConfiguration.get(context).getScaledTouchSlop();
    }

    @Override
    public boolean dispatchTouchEvent(MotionEvent event) {
        int action = event.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN) {
            direction = UNDECIDED;
            pointerId = event.getPointerId(0);
            startX = event.getX(0);
            startY = event.getY(0);
            nativeGestureStarted = false;
            disallowParents(true);
        } else if (action == MotionEvent.ACTION_MOVE && direction != IDLE) {
            int index = event.findPointerIndex(pointerId);
            if (direction == UNDECIDED && index >= 0) {
                float dx = Math.abs(event.getX(index) - startX);
                float dy = Math.abs(event.getY(index) - startY);
                if (Math.max(dx, dy) > touchSlop) {
                    direction = dx >= dy ? HORIZONTAL : VERTICAL;
                }
            }
            applyInterceptionPolicy();
        } else if (action == MotionEvent.ACTION_POINTER_UP
                && event.getPointerId(event.getActionIndex()) == pointerId) {
            int next = event.getActionIndex() == 0 ? 1 : 0;
            if (next < event.getPointerCount()) {
                pointerId = event.getPointerId(next);
                if (direction == UNDECIDED) {
                    startX = event.getX(next);
                    startY = event.getY(next);
                }
            } else {
                pointerId = -1;
            }
        }

        try {
            return super.dispatchTouchEvent(event);
        } finally {
            if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
                if (action == MotionEvent.ACTION_UP && nativeGestureStarted) {
                    NativeGestureUtil.notifyNativeGestureEnded(this, event);
                }
                // A vertical ancestor sends CANCEL when taking ownership. Do not clear
                // its interception lock or end its native gesture. Android clears touch
                // interception flags on UP/CANCEL and before each new DOWN.
                clearGesture();
            }
        }
    }

    @Override
    public boolean onInterceptTouchEvent(MotionEvent event) {
        if (direction == VERTICAL && event.getActionMasked() == MotionEvent.ACTION_MOVE) {
            // Cancel the child's horizontal tracking on this move, then let the vertical
            // ancestor take the following move. A large diagonal move must not start
            // both scrolling directions or turn the canceled card touch into a press.
            if (!nativeGestureStarted) {
                NativeGestureUtil.notifyNativeGestureStarted(this, event);
                nativeGestureStarted = true;
            }
            return true;
        }
        return super.onInterceptTouchEvent(event);
    }

    @Override
    public void requestDisallowInterceptTouchEvent(boolean disallowIntercept) {
        if (direction == IDLE) {
            super.requestDisallowInterceptTouchEvent(disallowIntercept);
        } else {
            // A child may release interception at a list edge or on cancellation.
            // Keep the whole gesture in this row, including at either horizontal edge.
            applyInterceptionPolicy();
        }
    }

    private void applyInterceptionPolicy() {
        if (direction == VERTICAL) {
            super.requestDisallowInterceptTouchEvent(false);
            // Our own flag may already be false, in which case ViewGroup returns early.
            // Still release the ancestors that were protected directly on DOWN.
            disallowParents(false);
            ViewParent ancestor = getParent();
            while (ancestor instanceof View) {
                View view = (View) ancestor;
                if (view.canScrollHorizontally(-1) || view.canScrollHorizontally(1)) {
                    view.requestDisallowInterceptTouchEvent(true);
                }
                ancestor = view.getParent();
            }
        } else {
            disallowParents(true);
        }
    }

    private void disallowParents(boolean disallow) {
        ViewParent parent = getParent();
        if (parent != null) parent.requestDisallowInterceptTouchEvent(disallow);
    }

    private void clearGesture() {
        direction = IDLE;
        pointerId = -1;
        nativeGestureStarted = false;
    }

    @Override
    protected void onDetachedFromWindow() {
        clearGesture();
        super.onDetachedFromWindow();
    }
}
