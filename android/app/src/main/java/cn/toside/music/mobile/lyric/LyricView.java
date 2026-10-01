package cn.toside.music.mobile.lyric;

import android.app.Activity;
import android.content.Context;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Point;
import android.graphics.drawable.GradientDrawable;
import android.hardware.SensorManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.text.Layout;
import android.text.StaticLayout;
import android.text.TextPaint;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.Display;
import android.view.GestureDetector;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.OrientationEventListener;
import android.view.View;
import android.view.WindowManager;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.WritableMap;

import java.util.ArrayList;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class LyricView extends Activity implements View.OnTouchListener {
  // 背景框的三种模式：贴合文字 / 铺满窗口 / 不显示
  private static final String BACKGROUND_TEXT = "text";
  private static final String BACKGROUND_WINDOW = "window";
  private static final String BACKGROUND_NONE = "none";
  // 贴合模式下框比文字多出来的内边距
  private static final int BOX_PADDING_H_DP = 8;
  private static final int BOX_PADDING_V_DP = 4;
  // 没有歌词（纯音乐）时也要留一个能看见、能拖动的框
  private static final int MIN_BOX_WIDTH_DP = 32;
  private static final int CORNER_RADIUS_TEXT_DP = 8;
  private static final int CORNER_RADIUS_WINDOW_DP = 2;

  LyricSwitchView textView = null;
  WindowManager windowManager = null;
  WindowManager.LayoutParams layoutParams = null;
  final private ReactApplicationContext reactContext;
  final private LyricEvent lyricEvent;

  // private int winWidth = 0;

  private float lastX; //上一次位置的X.Y坐标
  private float lastY;
  private float nowX;  //当前移动位置的X.Y坐标
  private float nowY;
  private float tranX; //悬浮窗移动位置的相对值
  private float tranY;
  private float prevViewPercentageX = 0;
  private float prevViewPercentageY = 0;
  private float widthPercentage = 1f;
  private String backgroundMode = BACKGROUND_TEXT;
  private float backgroundOpacity = 0.35f;
  private GestureDetector gestureDetector = null;

  private float preY = 0;
  // private static boolean isVibrated = false;

  private boolean isLock = false;
  private boolean isSingleLine = false;
  // 竖向显示：每个字占一行，窗口变成窄而高的一条
  private boolean isVertical = false;
  private boolean isShowToggleAnima = false;
  private String unplayColor = "rgba(255, 255, 255, 1)";
  private String playedColor = "rgba(7, 197, 86, 1)";
  private String shadowColor = "rgba(0, 0, 0, 0.15)";
  // private String lastText = "LX Music ^-^";
  private String textX = "LEFT";
  private String textY = "TOP";
  private float alpha = 1f;
  private float textSize = 18f;
  private int maxWidth = 0;
  private int maxHeight = 0;

  private int maxLineNum = 5;
  // private float lineHeight = 1;
  private String currentLyric = "LX Music ^-^";
  private ArrayList<String> currentExtendedLyrics = new ArrayList<>();

  private int mLastRotation;
  private OrientationEventListener orientationEventListener = null;

  final Handler fixViewPositionHandler;
  final Runnable fixViewPositionRunnable = this::updateViewPosition;

  LyricView(ReactApplicationContext reactContext, LyricEvent lyricEvent) {
    this.reactContext = reactContext;
    this.lyricEvent = lyricEvent;
    fixViewPositionHandler = new Handler();
    gestureDetector = new GestureDetector(reactContext, new GestureDetector.SimpleOnGestureListener() {
      @Override
      public boolean onLongPress(MotionEvent e) {
        // 窗口内长按 = 请求锁定。这里只把动作报给 JS，锁不锁由 JS 侧的设置决定
        // （锁定后窗口是 FLAG_NOT_TOUCHABLE，收不到触摸，也就不会再触发）
        if (LyricView.this.lyricEvent != null) {
          LyricView.this.lyricEvent.sendEvent(LyricView.this.lyricEvent.VIEW_LONG_PRESS, null);
        }
        return true;
      }
    });
  }

  private void listenOrientationEvent() {
    if (orientationEventListener == null) {
      orientationEventListener = new OrientationEventListener(reactContext, SensorManager.SENSOR_DELAY_NORMAL) {
        @Override
        public void onOrientationChanged(int orientation) {
          Display display = windowManager.getDefaultDisplay();
          int rotation = display.getRotation();
          if(rotation != mLastRotation){
            //rotation changed
            // if (rotation == Surface.ROTATION_90){} // check rotations here
            // if (rotation == Surface.ROTATION_270){} //
            // Log.d("Lyric", "rotation: " + rotation);
            fixViewPositionHandler.postDelayed(fixViewPositionRunnable, 300);
          }
          mLastRotation = rotation;
        }
      };
    }
    // Log.d("Lyric", "orientationEventListener: " + orientationEventListener.canDetectOrientation());
    if (orientationEventListener.canDetectOrientation()) {
      orientationEventListener.enable();
    }
  }
  private void removeOrientationEvent() {
    if (orientationEventListener == null) return;
    orientationEventListener.disable();
    // orientationEventListener = null;
  }

  private int getLayoutParamsFlags() {
    int flag = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE |
      WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL |
      WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN |
      WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS;

    if (isLock) {
      flag = flag | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
    }

    return flag;
  }

  /**
   * update screen width and height
   * @return has updated
   */
  private boolean updateWH() {
    Display display = windowManager.getDefaultDisplay();
    Point size = new Point();
    display.getRealSize(size);
    if (maxWidth == size.x && maxHeight == size.y) return false;
    maxWidth = size.x;
    maxHeight = size.y;
    return true;
  }

  private int dp2px(float dp) {
    return (int)(reactContext.getResources().getDisplayMetrics().density * dp + 0.5f);
  }

  /**
   * 竖向显示：在每个字之间插一个换行，让文字从上往下一个一个排（配合「窗口只有一个字宽」，
   * 就得到竖排的效果）。原文/翻译/罗马音之间原有的换行保留，所以翻译会接在原文下面继续竖排。
   * 按码点遍历，避免把 emoji 之类的代理对拆坏。
   */
  private String formatVerticalText(String text) {
    if (!isVertical || text == null || text.isEmpty()) return text;
    StringBuilder builder = new StringBuilder(text.length() * 2);
    String[] lines = text.split("\n", -1);
    for (int i = 0; i < lines.length; i++) {
      if (i > 0) builder.append('\n');
      String line = lines[i];
      for (int j = 0; j < line.length(); ) {
        int codePoint = line.codePointAt(j);
        if (j > 0) builder.append('\n');
        builder.appendCodePoint(codePoint);
        j += Character.charCount(codePoint);
      }
    }
    return builder.toString();
  }

  private void clampPosition() {
    int maxX = Math.max(0, maxWidth - layoutParams.width);
    if (layoutParams.x < 0) layoutParams.x = 0;
    else if (layoutParams.x > maxX) layoutParams.x = maxX;

    int maxY = Math.max(0, maxHeight - layoutParams.height);
    if (layoutParams.y < 0) layoutParams.y = 0;
    else if (layoutParams.y > maxY) layoutParams.y = maxY;
  }

  /**
   * 把窗口矩形算成「刚好包住当前歌词」的大小。
   *
   * 背景是贴在窗口根 View 上的，而窗口原来的尺寸是「屏幕宽 × width%」×「行高 × maxLineNum」，
   * 于是一句歌词也横跨整屏、还占着 maxLineNum 行的高度（默认 5 行）；这块矩形还会吞掉下面
   * App 的点击，宽度 100% 时 maxX 恒为 0（横向拖不动）。这里改成按实际文字算框的大小：
   * 宽度取最长一行的宽度（上限仍是 width%），高度按换行后的真实行数（上限 maxLineNum），
   * 尺寸变化时按 textX/textY 让对应的那条边保持不动，最后夹回屏幕内。
   * backgroundMode 为 window（铺满窗口）时保持老行为，方便想回到老样子的情况。
   */
  private void applyBoxSize() {
    if (textView == null || layoutParams == null || maxWidth <= 0) return;
    TextPaint paint = textView.getPaint();
    if (paint == null) return;

    int maxBoxWidth = (int)(maxWidth * widthPercentage);
    if (maxBoxWidth <= 0 || maxBoxWidth > maxWidth) maxBoxWidth = maxWidth;
    int lineHeight = paint.getFontMetricsInt(null);

    int width;
    int height;
    if (BACKGROUND_WINDOW.equals(backgroundMode)) {
      width = maxBoxWidth;
      height = Math.min(lineHeight * maxLineNum, maxHeight - 100);
    } else if (isVertical) {
      // 竖向显示：文本已经是一个字一行，所以宽度只留「最宽的那个字」，高度按字数往下堆，
      // 上限是整个屏幕（竖排一列本来就该能排满屏高）。
      // 这里刻意不吃「窗口百分比宽度」和「最大行数」两个设置：一个字宽是竖排的底线，
      // 而最大行数最多只能设到 8，套到竖排上就是只能显示 8 个字。
      int padH = dp2px(BOX_PADDING_H_DP);
      int padV = dp2px(BOX_PADDING_V_DP);
      String text = textView.getText().toString();
      float maxCharWidth = 0;
      for (String line : text.split("\n", -1)) {
        for (int i = 0; i < line.length(); ) {
          int codePoint = line.codePointAt(i);
          int charCount = Character.charCount(codePoint);
          maxCharWidth = Math.max(maxCharWidth, paint.measureText(line, i, i + charCount));
          i += charCount;
        }
      }
      width = Math.max((int)Math.ceil(maxCharWidth) + padH * 2, dp2px(MIN_BOX_WIDTH_DP));
      height = Math.max(new StaticLayout(
        text, paint, Math.max(1, width - padH * 2), Layout.Alignment.ALIGN_NORMAL, 1F, 0F, true
      ).getHeight() + padV * 2, lineHeight);
    } else {
      String text = textView.getText().toString();
      // 单行模式是 LyricTextView 自绘滚动，不吃 padding，靠宽度余量留白
      int padH = isSingleLine ? 0 : dp2px(BOX_PADDING_H_DP);
      int padV = isSingleLine ? 0 : dp2px(BOX_PADDING_V_DP);
      float maxLineWidth = 0;
      for (String line : text.split("\n", -1)) {
        maxLineWidth = Math.max(maxLineWidth, paint.measureText(line));
      }
      // 单行模式多留 2dp：LyricTextView 靠 textLength < viewWidth 判断要不要滚动，
      // 框宽正好等于文字宽度时会被判成溢出而一直滚动
      width = Math.min(maxBoxWidth, (int)Math.ceil(maxLineWidth) + padH * 2 + (isSingleLine ? dp2px(2) : 0));
      if (isSingleLine) {
        height = lineHeight;
      } else {
        // 超出框宽会换行，用 StaticLayout 量出换行之后的真实高度（带 padding 口径与 TextView 一致）
        height = new StaticLayout(
          text, paint, Math.max(1, width - padH * 2), Layout.Alignment.ALIGN_NORMAL, 1F, 0F, true
        ).getHeight() + padV * 2;
        if (height > lineHeight * maxLineNum + padV * 2) height = lineHeight * maxLineNum + padV * 2;
      }
      // 空歌词（纯音乐）时也要留一个能看见、能拖动的框，别塌成 0 宽
      width = Math.max(width, dp2px(MIN_BOX_WIDTH_DP));
      height = Math.max(height, lineHeight);
    }
    if (height > maxHeight - 100) height = maxHeight - 100;

    int oldWidth = layoutParams.width;
    int oldHeight = layoutParams.height;
    int dx = 0;
    int dy = 0;
    if (oldWidth > 0 && oldHeight > 0) {
      // 尺寸变了：让对齐方式指定的那条边不动，这样「对齐」设置在框会变大的模式下仍然有意义
      switch (textX) {
        case "CENTER": dx = (oldWidth - width) / 2; break;
        case "RIGHT": dx = oldWidth - width; break;
      }
      switch (textY) {
        case "CENTER": dy = (oldHeight - height) / 2; break;
        case "BOTTOM": dy = oldHeight - height; break;
      }
    }

    layoutParams.width = width;
    layoutParams.height = height;
    textView.setWidth(width);
    textView.setHeight(height);
    if (dx != 0) layoutParams.x += dx;
    if (dy != 0) layoutParams.y += dy;
    clampPosition();
    // 还没挂到 WindowManager 上时不能调 updateViewLayout（首次显示时尺寸要在 addView 之前算好）
    if (windowManager != null && textView.isAttachedToWindow()) windowManager.updateViewLayout(textView, layoutParams);
  }

  /** 贴合模式下给文字留一圈内边距，框看起来才不贴着字 */
  private void applyTextPadding() {
    if (textView == null) return;
    // 竖向显示用的是普通 TextView（不是自绘滚动的 LyricTextView），内边距照常生效
    if ((isSingleLine && !isVertical) || BACKGROUND_WINDOW.equals(backgroundMode)) {
      textView.setTextPadding(0, 0, 0, 0);
    } else {
      textView.setTextPadding(dp2px(BOX_PADDING_H_DP), dp2px(BOX_PADDING_V_DP),
        dp2px(BOX_PADDING_H_DP), dp2px(BOX_PADDING_V_DP));
    }
  }

  /** 背景框：贴合/铺满画黑色半透明圆角矩形，不显示则留空 */
  private void applyBackground() {
    if (textView == null) return;
    if (BACKGROUND_NONE.equals(backgroundMode)) {
      textView.setBackground(null);
      return;
    }
    float opacity = Math.max(0F, Math.min(1F, backgroundOpacity));
    GradientDrawable background = new GradientDrawable();
    background.setShape(GradientDrawable.RECTANGLE);
    background.setCornerRadius(dp2px(BACKGROUND_WINDOW.equals(backgroundMode) ? CORNER_RADIUS_WINDOW_DP : CORNER_RADIUS_TEXT_DP));
    background.setColor(Color.argb((int)(opacity * 255), 0, 0, 0));
    textView.setBackground(background);
  }

  private void updateViewPosition() {
    if (textView == null || windowManager == null) return;
    if (!updateWH()) return;

    applyBoxSize();

    layoutParams.x = (int)(maxWidth * prevViewPercentageX);
    layoutParams.y = (int)(maxHeight * prevViewPercentageY);
    clampPosition();

    windowManager.updateViewLayout(textView, layoutParams);
  }

  public void sendPositionEvent(float x, float y) {
    WritableMap params = Arguments.createMap();
    params.putDouble("x", x);
    params.putDouble("y", y);
    lyricEvent.sendEvent(lyricEvent.SET_VIEW_POSITION, params);
  }

//  public void permission(){
//    if (Build.VERSION.SDK_INT >= 23) {
//      if(!Settings.canDrawOverlays(this)) {
//        Intent intent = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION);
//        startActivity(intent);
//        return;
//      } else {
//        //Android6.0以上
//        if (mFloatView!=null && mFloatView.isShow()==false) {
//          mFloatView.show();
//        }
//      }
//    } else {
//      //Android6.0以下，不用动态声明权限
//      if (mFloatView!=null && mFloatView.isShow()==false) {
//        mFloatView.show();
//      }
//    }
//  }
// boolean isLock, String themeColor, float alpha, int lyricViewX, int lyricViewY, String textX, String textY
  public void showLyricView(Bundle options) {
    isLock = options.getBoolean("isLock", isLock);
    isSingleLine = options.getBoolean("isSingleLine", isSingleLine);
    isVertical = options.getBoolean("vertical", isVertical);
    isShowToggleAnima = options.getBoolean("isShowToggleAnima", isShowToggleAnima);
    unplayColor = options.getString("unplayColor", unplayColor);
    playedColor = options.getString("playedColor", playedColor);
    shadowColor = options.getString("shadowColor", shadowColor);
    prevViewPercentageX = (float) options.getDouble("lyricViewX", 0f) / 100f;
    prevViewPercentageY = (float) options.getDouble("lyricViewY", 0f) / 100f;
    textX = options.getString("textX", textX);
    textY = options.getString("textY", textY);
    alpha = (float) options.getDouble("alpha", alpha);
    textSize = (float) options.getDouble("textSize", textSize);
    widthPercentage = (float) options.getDouble("width", 100) / 100f;
    maxLineNum = (int) options.getDouble("maxLineNum", maxLineNum);
    backgroundMode = options.getString("background", backgroundMode);
    backgroundOpacity = (float) options.getDouble("backgroundOpacity", backgroundOpacity);
    handleShowLyric();
    listenOrientationEvent();
  }
  public void showLyricView() {
    try {
      handleShowLyric();
    } catch (Exception e) {
      Log.e("Lyric", e.getMessage());
      return;
    }
    listenOrientationEvent();
  }
  public static int parseColor(String input) {
    if (input.startsWith("#")) return Color.parseColor(input);
    Pattern c = Pattern.compile("rgba? *\\( *(\\d+), *(\\d+), *(\\d+)(?:, *([\\d.]+))? *\\)");
    Matcher m = c.matcher(input);
    if (m.matches()) {
      int red = Integer.parseInt(m.group(1));
      int green = Integer.parseInt(m.group(2));
      int blue = Integer.parseInt(m.group(3));
      float a = 1;
      if (m.group(4) != null) a = Float.parseFloat(m.group(4));
      return Color.argb((int) (a * 255), red, green, blue);
    }
    return Color.parseColor("#000000");
  }

  private void createTextView() {
    // 竖向显示要的是「一个字一行」的普通 TextView；单行模式的 LyricTextView 是自绘横向滚动的，
    // 窗口只剩一个字宽时它会把每个字都当成溢出而疯狂滚动，所以竖排时强制不用它
    textView = new LyricSwitchView(reactContext, isSingleLine && !isVertical, isShowToggleAnima);
    textView.setText("");
    textView.setText(formatVerticalText(currentLyric));

    textView.setTextColor(parseColor(playedColor));
    textView.setShadowColor(parseColor(shadowColor));
    textView.setAlpha(alpha);
    textView.setTextSize(textSize);
    // Log.d("Lyric", "alpha: " + alpha + " text size: " + textSize);

    //监听 OnTouch 事件 为了实现"移动歌词"功能
    textView.setOnTouchListener(this);

    int textPositionX;
    int textPositionY;
    switch (textX) {
      case "CENTER":
        textPositionX = Gravity.CENTER;
        break;
      case "RIGHT":
        textPositionX = Gravity.END;
        break;
      case "Left":
      default:
        textPositionX = Gravity.START;
        break;
    }
    switch (textY) {
      case "CENTER":
        textPositionY = Gravity.CENTER;
        break;
      case "BOTTOM":
        textPositionY = Gravity.BOTTOM;
        break;
      case "TOP":
      default:
        textPositionY = Gravity.TOP;
        break;
    }
    textView.setGravity(textPositionX | textPositionY);

    // 竖排时不用 maxLines 截断：框高已经由屏幕高度兜住了，再按「行数」截就只能显示几个字
    if (!isSingleLine && !isVertical) {
      textView.setMaxLines(maxLineNum);
    }

    applyTextPadding();
    applyBackground();
  }
  private void handleShowLyric() {
    if (windowManager == null) {
      windowManager = (WindowManager) reactContext.getSystemService(Context.WINDOW_SERVICE);
      //设置TextView的属性
      layoutParams = new WindowManager.LayoutParams();

      DisplayMetrics outMetrics = new DisplayMetrics();
      windowManager.getDefaultDisplay().getMetrics(outMetrics);
      // winWidth = (int)(outMetrics.widthPixels * 0.92);
    }

    // 注意，悬浮窗只有一个，而当打开应用的时候才会产生悬浮窗，所以要判断悬浮窗是否已经存在，
    if (textView != null) {
      windowManager.removeView(textView);
    }

    // 使用Application context
    // 创建UI控件，避免Activity销毁导致上下文出现问题,因为现在的悬浮窗是系统级别的，不依赖与Activity存在
    //创建自定义的TextView
    createTextView();

    // layoutParams.type = WindowManager.LayoutParams.TYPE_SYSTEM_ALERT | WindowManager.LayoutParams.TYPE_SYSTEM_OVERLAY;
    // layoutParams.type = WindowManager.LayoutParams.TYPE_SYSTEM_OVERLAY;
    layoutParams.type = Build.VERSION.SDK_INT < Build.VERSION_CODES.O ?
      WindowManager.LayoutParams.TYPE_SYSTEM_ALERT :
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY;

    // layoutParams.flags = isLock
    //  ? WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
    //  : WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL;
    layoutParams.flags = getLayoutParamsFlags();
    // 背景只由 background 设置决定，锁定时不再把背景抹掉（以前锁定会让黑框消失，看着像没锁上）
    if (Build.VERSION.SDK_INT > Build.VERSION_CODES.R) {
      // 修复 Android 12 的穿透点击问题
      layoutParams.alpha = isLock ? 0.8f : 1.0f;
    }

    // TYPE_SYSTEM_ALERT  系统提示,它总是出现在应用程序窗口之上
    // TYPE_SYSTEM_OVERLAY   系统顶层窗口。显示在其他一切内容之上。此窗口不能获得输入焦点，否则影响锁屏
    // FLAG_NOT_FOCUSABLE 悬浮窗口较小时，后面的应用图标由不可长按变为可长按,不设置这个flag的话，home页的划屏会有问题
    // FLAG_NOT_TOUCH_MODAL不阻塞事件传递到后面的窗口
    layoutParams.gravity = Gravity.TOP | Gravity.START;  //显示在屏幕上中部

    updateWH();

    //悬浮窗的宽高：贴合歌词（backgroundMode 为 window 时保持老的「整屏宽 × maxLineNum 行」）
    // layoutParams.width = WindowManager.LayoutParams.WRAP_CONTENT;
    // layoutParams.height = WindowManager.LayoutParams.WRAP_CONTENT;
    applyBoxSize();

    //显示位置与指定位置的相对位置差
    layoutParams.x = (int)(maxWidth * prevViewPercentageX);
    layoutParams.y = (int)(maxHeight * prevViewPercentageY);
    clampPosition();

    //设置透明
    layoutParams.format = PixelFormat.TRANSPARENT;

    //添加到window中
    windowManager.addView(textView, layoutParams);
  }

  public void setLyric(String text, ArrayList<String> extendedLyrics) {
    if (text.equals("") && text.equals(currentLyric) && extendedLyrics.size() == 0) return;
    currentLyric = text;
    currentExtendedLyrics = extendedLyrics;
    if (textView == null) return;
    if (extendedLyrics.size() > 0 && (isVertical || (maxLineNum > 1 && !isSingleLine))) {
      // 竖排一列能放下的字有限，翻译/罗马音只带一行，不然整条会拖得很长
      int num = isVertical ? 1 : maxLineNum - 1;
      StringBuilder textBuilder = new StringBuilder(text);
      for (String lrc : extendedLyrics) {
        textBuilder.append("\n").append(lrc);
        if (--num < 1) break;
      }
      text = textBuilder.toString();
    }
    if (textView == null) return;
    textView.setText(formatVerticalText(text));
    // 歌词换了，框的大小也要跟着重算
    applyBoxSize();
  }

  public void setMaxLineNum(int maxLineNum) {
    this.maxLineNum = maxLineNum;
    if (textView == null || windowManager == null) return;
    if (!isSingleLine && !isVertical) textView.setMaxLines(maxLineNum);
    applyBoxSize();
  }

  public void setWidth(int width) {
    if (textView == null || windowManager == null) return;
    widthPercentage = width / 100f;
    applyBoxSize();
  }

  @Override
  public boolean onTouch(View v, MotionEvent event) {
    // 长按 = 请求锁定（手指一移动长按判定就取消，不影响拖动）
    if (gestureDetector != null) gestureDetector.onTouchEvent(event);
    int maxX = Math.max(0, maxWidth - layoutParams.width);
    int maxY = Math.max(0, maxHeight - layoutParams.height);

    switch (event.getAction()){
      case MotionEvent.ACTION_DOWN:
        // 获取按下时的X，Y坐标
        lastX = event.getRawX();
        lastY = event.getRawY();

        preY = lastY;
        break;
      case MotionEvent.ACTION_MOVE:
        // 获取移动时的X，Y坐标
        nowX = event.getRawX();
        nowY = event.getRawY();
        if (preY == 0){
          preY = nowY;
        }
        // 计算XY坐标偏移量
        tranX = nowX - lastX;
        tranY = nowY - lastY;

        int x = layoutParams.x + (int)tranX;
        if (x < 0) x = 0;
        else if (x > maxX) x = maxX;
        int y = layoutParams.y + (int)tranY;
        if (y < 0) y = 0;
        else if (y > maxY) y = maxY;

        // 移动悬浮窗
        layoutParams.x = x;
        layoutParams.y = y;
        //更新悬浮窗位置
        windowManager.updateViewLayout(textView, layoutParams);
        //记录当前坐标作为下一次计算的上一次移动的位置坐标
        lastX = nowX;
        lastY = nowY;
        break;
      case MotionEvent.ACTION_UP:
        // float dy = nowY - preY;
        // Log.d("Lyric","dy: " + dy);
        // if (isVibrated){
        //   if (dy > 10){
        //     //down
        //     actions(AppHolder.actions[3]);
        //   }else if (dy<-10){
        //     //up
        //     actions(AppHolder.actions[4]);
        //   }else {
        //     //longClick
        //     actions(AppHolder.actions[2]);
        //   }
        //   isVibrated =false;
        // }
        //根据移动的位置来判断
        // dy = 0;
        tranY = 0;
        float percentageX = (float)layoutParams.x / (float) maxWidth * 100f;
        float percentageY = (float)layoutParams.y / (float) maxHeight * 100f;
        if (percentageX != prevViewPercentageX || percentageY != prevViewPercentageY) {
          prevViewPercentageX = percentageX / 100f;
          prevViewPercentageY = percentageY / 100f;
          sendPositionEvent(percentageX, percentageY);
        }
        break;
    }
    return true;
  }

  /**
   * 锁定：整个窗口加上 FLAG_NOT_TOUCHABLE，收不到任何触摸（拖不动，也不会挡住下面 App 的点击）。
   * 背景/外观不跟着变，免得看起来像「一锁定就出问题了」。解锁要从 App 里来
   * （设置页的锁定开关、或播放页长按歌词按钮）。
   */
  public void lockView() {
    isLock = true;
    if (windowManager == null || textView == null) return;
    layoutParams.flags = getLayoutParamsFlags();

    if (Build.VERSION.SDK_INT > Build.VERSION_CODES.R) {
      layoutParams.alpha = 0.8f;
    }
    windowManager.updateViewLayout(textView, layoutParams);
  }

  public void unlockView() {
    isLock = false;
    if (windowManager == null || textView == null) return;
    layoutParams.flags = getLayoutParamsFlags();

    if (Build.VERSION.SDK_INT > Build.VERSION_CODES.R) {
      layoutParams.alpha = 1.0f;
    }
    windowManager.updateViewLayout(textView, layoutParams);
  }

  /**
   * 设置背景框：text 贴合文字、window 铺满窗口、none 不显示；透明度 0~1。
   */
  public void setLyricBackground(String mode, float opacity) {
    if (mode != null) backgroundMode = mode;
    backgroundOpacity = opacity;
    if (windowManager == null || textView == null) return;
    applyTextPadding();
    applyBackground();
    // 贴合/铺满之间切换会改变窗口尺寸
    applyBoxSize();
  }

  public void setColor(String unplayColor, String playedColor, String shadowColor) {
    this.unplayColor = unplayColor;
    this.playedColor = playedColor;
    this.shadowColor = shadowColor;
    if (textView == null) return;
    textView.setTextColor(parseColor(playedColor));
    textView.setShadowColor(parseColor(shadowColor));
    // windowManager.updateViewLayout(textView, layoutParams);
  }

  public void setLyricTextPosition(String textX, String textY) {
    this.textX = textX;
    this.textY = textY;
    if (windowManager == null || textView == null) return;
    int textPositionX;
    int textPositionY;
    // Log.d("Lyric", "textX: " + textX + "  textY: " + textY);
    switch (textX) {
      case "CENTER":
        textPositionX = Gravity.CENTER_HORIZONTAL;
        break;
      case "RIGHT":
        textPositionX = Gravity.END;
        break;
      case "LEFT":
      default:
        textPositionX = Gravity.START;
        break;
    }
    switch (textY) {
      case "CENTER":
        textPositionY = Gravity.CENTER_VERTICAL;
        break;
      case "BOTTOM":
        textPositionY = Gravity.BOTTOM;
        break;
      case "TOP":
      default:
        textPositionY = Gravity.TOP;
        break;
    }
    textView.setGravity(textPositionX | textPositionY);
    // 对齐方式变了：位置/尺寸按新对齐重算一次（尺寸没变时等于只做一次夹取）
    applyBoxSize();
  }

  public void setAlpha(float alpha) {
    this.alpha = alpha;
    if (textView == null) return;
    textView.setAlpha(alpha);
  }

  public void setSingleLine(boolean isSingleLine) {
    this.isSingleLine = isSingleLine;
    if (textView == null) return;
    windowManager.removeView(textView);
    createTextView();
    applyBoxSize();
    windowManager.addView(textView, layoutParams);

    if (isLock) lockView();
    else unlockView();

    setLyric(currentLyric, currentExtendedLyrics);
  }

  /** 切换竖向显示：文字布局方式变了，重建 TextView 再按当前歌词重算窗口大小与位置 */
  public void setVertical(boolean vertical) {
    this.isVertical = vertical;
    if (windowManager == null || textView == null) return;
    windowManager.removeView(textView);
    createTextView();
    applyBoxSize();
    windowManager.addView(textView, layoutParams);

    if (isLock) lockView();
    else unlockView();

    setLyric(currentLyric, currentExtendedLyrics);
  }

  public void setShowToggleAnima(boolean showToggleAnima) {
    isShowToggleAnima = showToggleAnima;
    if (textView == null) return;
    textView.setShowAnima(showToggleAnima);
  }

  public void setTextSize(float size) {
    this.textSize = size;
    if (windowManager == null || textView == null) return;
    textView.setTextSize(size);
    applyBoxSize();
  }

  public void destroyView() {
    if (textView == null || windowManager == null) return;
    windowManager.removeView(textView);
    textView = null;
    removeOrientationEvent();
  }

  public void destroy() {
    destroyView();
    windowManager = null;
    layoutParams = null;
  }
}
