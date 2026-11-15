package com.whl.quickjs.wrapper;

/** Keep the published 2.4.0 Java ABI while replacing its function ownership guard. */
public final class SafeQuickJSContext {
    private SafeQuickJSContext() {}

    public static QuickJSContext create() {
        return QuickJSContext.create(new JSObjectCreator() {
            @Override
            public JSObject newObject(QuickJSContext context, long pointer) {
                return new QuickJSObject(context, pointer);
            }

            @Override
            public JSArray newArray(QuickJSContext context, long pointer) {
                return new QuickJSArray(context, pointer);
            }

            @Override
            public JSFunction newFunction(QuickJSContext context, long pointer, long thisPointer) {
                return new SafeJSFunction(context, pointer, thisPointer);
            }
        });
    }
}
