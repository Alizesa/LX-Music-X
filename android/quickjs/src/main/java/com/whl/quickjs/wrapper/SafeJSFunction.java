package com.whl.quickjs.wrapper;

import java.util.ArrayList;
import java.util.HashMap;

/** Function wrapper for QuickJS 2.4.0 with balanced releases after failed calls. */
public final class SafeJSFunction extends QuickJSObject implements JSFunction {
    private final long thisPointer;
    private int callDepth = 0;
    private int deferredReleases = 0;

    public SafeJSFunction(QuickJSContext context, long pointer, long thisPointer) {
        super(context, pointer);
        this.thisPointer = thisPointer;
    }

    @Override
    public void release() {
        if (callDepth > 0) {
            deferredReleases++;
            return;
        }
        super.release();
    }

    @Override
    public Object call(Object... args) {
        checkRefCountIsZero();
        callDepth++;
        try {
            return getContext().call(this, thisPointer, args);
        } finally {
            callDepth--;
            if (callDepth == 0) {
                int releases = deferredReleases;
                deferredReleases = 0;
                for (int i = 0; i < releases; i++) super.release();
            }
        }
    }

    @Override
    public void callVoid(Object... args) {
        Object result = call(args);
        if (result instanceof JSObject) ((JSObject) result).release();
    }

    @Override
    public HashMap<String, Object> toMap() {
        throw new UnsupportedOperationException("JSFunction types do not support conversion to map or array.");
    }

    @Override
    public ArrayList<Object> toArray() {
        throw new UnsupportedOperationException("JSFunction types do not support conversion to map or array.");
    }
}
