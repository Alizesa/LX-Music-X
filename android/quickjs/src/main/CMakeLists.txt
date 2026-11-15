cmake_minimum_required(VERSION 3.10.2)
project(quickjs-android-wrapper)

set(QUICKJS_PATH "${CMAKE_CURRENT_SOURCE_DIR}/native/quickjs")
file(STRINGS "${QUICKJS_PATH}/VERSION" CONFIG_VERSION)
add_definitions(-DCONFIG_VERSION=\"${CONFIG_VERSION}\")
add_definitions(-DCONFIG_BIGNUM)

add_library(quickjs-android-wrapper SHARED
    native/cpp/quickjs_context_jni.cpp
    native/cpp/quickjs_wrapper.cpp
    native/cpp/quickjs_android.cpp
    native/quickjs/cutils.c
    native/quickjs/libbf.c
    native/quickjs/libregexp.c
    native/quickjs/libunicode.c
    native/quickjs/quickjs.c
)

find_library(log-lib log)
target_link_libraries(quickjs-android-wrapper ${log-lib})
