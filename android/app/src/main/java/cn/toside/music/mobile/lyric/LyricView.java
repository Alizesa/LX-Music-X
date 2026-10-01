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
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.OrientationEventListener;
import android.view.View;
import android.view.ViewConfiguration;
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
  private String backgroundColor = "rgba(0, 0, 0, 1)";
  private float backgroundOpacity = 0.35f;
  // 长按 = 锁定：按下后没移动过、且按住超过 LONG_PRESS_MS 才认
  private static final long LONG_PRESS_MS = 500;
  private final int touchSlop;
  private float downX;
  private float downY;
  private long downTime;
  private boolean isMoved = false;
  // 手指正按在窗口上。拖的时候歌词换行不能把窗口拽回存下来的百分比位置，不然会跟手指打架
  private boolean isDragging = false;
  // 按下时窗口在哪。抬手时拿它判断窗口到底动没动过（见 onTouch 的 ACTION_UP）
  private int downLayoutX = 0;
  private int downLayoutY = 0;

  private float preY = 0;
  // private static boolean isVibrated = false;

  private boolean isLock = false;
  private boolean isSingleLine = false;
  // 竖向显示：每个字占一行，窗口变成窄而高的一条
  private boolean isVertical = false;
  // 竖排时把英文这类拉丁字母整串横倒 90° 显示（默认关，关着就是逐字正着堆叠）
  private boolean verticalRotateLatin = false;
  // textView 是不是正挂在窗口上（见 hasWindow()）
  private boolean windowAttached = false;
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
    // 长按判定不用 GestureDetector：它按下 500ms 就回调，手指停一下再拖也会被当成
    // 长按（然后窗口被锁住、拖动半路断掉）。这里改成「按下后一直没动、抬手时才认」，
    // 判定放在 onTouch 的 ACTION_UP 里。
    touchSlop = ViewConfiguration.get(reactContext).getScaledTouchSlop();
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
   * 竖向显示：把文字拆成一列列的字（每个字自己占一行，一行里的列并排）。
   *
   * - 「单行歌词」打开：所有文字挤在一列里往下接（原文、翻译依次往下），行数最少。
   * - 没打开：一行原文一列、一行翻译一列（也就是把各行的第 i 个字拼成同一行：
   *   "原译"、"文文"…）。列序按竖排习惯从右往左，原文在最右。
   *   某一行已经没字了就用全角空格占位，保证各列始终对齐。
   *
   * 按码点遍历，避免把 emoji 之类的代理对拆坏。
   */
  private String formatVerticalText(String text) {
    if (!isVertical || text == null || text.isEmpty()) return text;
    String[] lines = text.split("\n", -1);
    int rowsPerColumn = getVerticalRowsPerColumn();

    ArrayList<String> columns = new ArrayList<>();
    if (isSingleLine) {
      // 单行歌词：所有文字连成一条往下排，一列排满了拐到下一列
      StringBuilder joined = new StringBuilder();
      for (String line : lines) joined.append(line);
      splitIntoColumns(columns, joined.toString(), rowsPerColumn);
    } else {
      // 不开单行：原文一列、翻译一列（各自排不下时再往下拐列）
      for (String line : lines) splitIntoColumns(columns, line, rowsPerColumn);
    }
    if (columns.isEmpty()) return text;

    // 列序按竖排习惯从右往左，所以拼接时从最后一列开始（它落在最左边）
    StringBuilder builder = new StringBuilder(text.length() * 3);
    int rowCount = 0;
    for (String column : columns) rowCount = Math.max(rowCount, column.codePointCount(0, column.length()));
    int[] cursors = new int[columns.size()];
    for (int row = 0; row < rowCount; row++) {
      if (row > 0) builder.append('\n');
      for (int i = columns.size() - 1; i >= 0; i--) {
        String column = columns.get(i);
        int cursor = cursors[i];
        if (cursor < column.length()) {
          int codePoint = column.codePointAt(cursor);
          builder.appendCodePoint(codePoint);
          cursors[i] = cursor + Character.charCount(codePoint);
        } else {
          // 该列已经排完，用全角空格（U+3000）占位，宽度与汉字相同
          builder.append((char) 0x3000);
        }
      }
    }
    return builder.toString();
  }

  /**
   * 一列最多排多少行。竖排不滚动，一列排不下的部分必须拐到下一列，
   * 否则会被窗口直接裁掉（竖排一列本来就该铺满屏高，所以上限取屏幕高度）。
   */
  private int getVerticalRowsPerColumn() {
    if (!isVertical || maxHeight <= 0 || textView == null) return Integer.MAX_VALUE;
    TextPaint paint = textView.getPaint();
    if (paint == null) return Integer.MAX_VALUE;
    int lineHeight = paint.getFontMetricsInt(null);
    if (lineHeight <= 0) return Integer.MAX_VALUE;
    return Math.max(1, (maxHeight - 100 - dp2px(BOX_PADDING_V_DP) * 2) / lineHeight);
  }

  /** 把一行文字每 rowsPerColumn 个字符切成一段，一段就是一列（按码点切，不拆坏代理对） */
  private void splitIntoColumns(ArrayList<String> columns, String line, int rowsPerColumn) {
    if (line == null || line.isEmpty()) return;
    if (rowsPerColumn < 1) rowsPerColumn = 1;
    int start = 0;
    int count = 0;
    for (int i = 0; i < line.length(); ) {
      i += Character.charCount(line.codePointAt(i));
      if (++count == rowsPerColumn) {
        columns.add(line.substring(start, i));
        start = i;
        count = 0;
      }
    }
    if (start < line.length()) columns.add(line.substring(start));
  }

  /**
   * 窗口左上角该在哪。存下来的是屏幕百分比，宽度又跟着歌词文字变，所以每次都从百分比重算，
   * 不做「在旧位置上叠加位移」——那样一行一行攒下来，退出重进就会明显跑偏。
   * 拖动过程中位置归手指管，这里不插手（否则换行时会把窗口从手指底下拽走）。
   */
  private int targetX() {
    return isDragging ? layoutParams.x : (int)(maxWidth * prevViewPercentageX);
  }

  private int targetY() {
    return isDragging ? layoutParams.y : (int)(maxHeight * prevViewPercentageY);
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
   * 宽度取最长一行的宽度（上限仍是 width%），高度按换行后的真实行数（上限 maxLineNum）。
   * 位置不动：左上角钉在存下来的百分比上（拖动中由手指决定），框再按「从这个位置到屏幕边缘
   * 还剩多少」收一次——位置一动，每换一行歌词窗口就跟着滑，看着像在抖。
   * backgroundMode 为 window（铺满窗口）时保持老行为，方便想回到老样子的情况。
   */
  private void applyBoxSize() {
    if (textView == null || layoutParams == null || maxWidth <= 0) return;
    TextPaint paint = textView.getPaint();
    if (paint == null) return;

    // 位置先定下来，尺寸要围着它算（见下面的 usableWidth/usableHeight）
    int posX = targetX();
    int posY = targetY();
    int usableWidth = Math.max(0, maxWidth - posX);
    int usableHeight = Math.max(0, maxHeight - posY);

    int maxBoxWidth = (int)(maxWidth * widthPercentage);
    if (maxBoxWidth <= 0 || maxBoxWidth > maxWidth) maxBoxWidth = maxWidth;
    // 再按「从目标位置到屏幕右边缘还剩多宽」收一次。位置是钉死在百分比上的：要是让框按设置里的
    // 宽度撑到屏幕外、再被 clampPosition 拽回来，那每换一行歌词窗口就会左右滑一下。
    // 宁可让文字换行去适应，也别让位置动。竖向不吃宽度百分比（一列字是竖排的底线），就不收它。
    if (!isVertical && usableWidth < maxBoxWidth) maxBoxWidth = Math.max(usableWidth, dp2px(MIN_BOX_WIDTH_DP));
    int lineHeight = paint.getFontMetricsInt(null);

    int width;
    int height;
    if (isVertical) {
      // 竖向显示：文本已经拆成「一个字一行」，所以一行的宽度就是这一排所有列加起来的宽度
      // （单行模式一行一个字；不开单行时一行一个字 × 列数，原文一列翻译一列）。
      // 高度按行数往下堆，上限是整个屏幕。
      // 这里刻意不吃「窗口百分比宽度」和「最大行数」两个设置：一列字的宽度是竖排的底线，
      // 而最大行数最多只能设到 8，套到竖排上就是只能显示 8 个字。
      int padH = dp2px(BOX_PADDING_H_DP);
      int padV = dp2px(BOX_PADDING_V_DP);
      String text = textView.getText().toString();
      float maxRowWidth = 0;
      int maxColumns = 0;
      for (String line : text.split("\n", -1)) {
        maxRowWidth = Math.max(maxRowWidth, paint.measureText(line));
        maxColumns = Math.max(maxColumns, line.codePointCount(0, line.length()));
      }
      if (verticalRotateLatin) maxRowWidth = Math.max(maxRowWidth, (float) lineHeight * maxColumns);
      width = Math.max((int)Math.ceil(maxRowWidth) + padH * 2, dp2px(MIN_BOX_WIDTH_DP));
      height = Math.max(new StaticLayout(
        text, paint, Math.max(1, width - padH * 2), Layout.Alignment.ALIGN_NORMAL, 1F, 0F, true
      ).getHeight() + padV * 2, lineHeight);
    } else if (BACKGROUND_WINDOW.equals(backgroundMode)) {
      // 铺满窗口：保持老行为（整屏宽 × maxLineNum 行），想回到老样子就用它
      width = maxBoxWidth;
      height = Math.min(lineHeight * maxLineNum, maxHeight - 100);
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
    // 高度：铺满窗口那条老路径和竖排都保持原来的口径（一个按整屏算，一个内容多高就多高），
    // 只有贴合模式要跟着位置收——它的高度逐行在变（翻译行来去），不收的话窗口会贴着下边缘一跳一跳
    if (!isVertical && !BACKGROUND_WINDOW.equals(backgroundMode)) {
      int maxBoxHeight = Math.max(usableHeight, lineHeight);
      if (height > maxBoxHeight) height = maxBoxHeight;
    } else if (height > maxHeight - 100) {
      height = maxHeight - 100;
    }

    layoutParams.width = width;
    layoutParams.height = height;
    textView.setWidth(width);
    textView.setHeight(height);
    // 位置钉在存下来的百分比上（拖动中除外）：尺寸怎么变都不动它，才不会逐行抖。
    // 以前是「在旧位置上叠加位移」并保证对齐的那条边不动，但那样攒下来退出重进就会跑偏
    layoutParams.x = posX;
    layoutParams.y = posY;
    // 兜底：上面已经按可用空间把框收进去了，正常夹不到，留着防边界情况（旋转、超小屏等）
    clampPosition();
    // 还没挂到 WindowManager 上时不能调 updateViewLayout（首次显示时尺寸要在 addView 之前算好）
    if (windowManager != null && hasWindow()) windowManager.updateViewLayout(textView, layoutParams);
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
    // 颜色只取 RGB，透明度统一由「背景框不透明度」这个设置决定
    int color = parseColor(backgroundColor == null ? "rgba(0, 0, 0, 1)" : backgroundColor);
    GradientDrawable background = new GradientDrawable();
    background.setShape(GradientDrawable.RECTANGLE);
    background.setCornerRadius(dp2px(BACKGROUND_WINDOW.equals(backgroundMode) ? CORNER_RADIUS_WINDOW_DP : CORNER_RADIUS_TEXT_DP));
    background.setColor(Color.argb((int)(opacity * 255), Color.red(color), Color.green(color), Color.blue(color)));
    textView.setBackground(background);
  }

  /** 按当前文本重新拆列/设字号（竖排的列数取决于字号和屏幕高度，两者变了都要重排） */
  private void recompose() {
    setLyric(currentLyric, currentExtendedLyrics);
    // setLyric 在文本没变且为空时会提前返回，这里兜一下尺寸
    applyBoxSize();
  }

  private void updateViewPosition() {
    // 没有窗口就别忙活了（旋转/尺寸变化时也会走到这，窗口不在时 updateViewLayout 会抛 not attached）
    if (windowManager == null || !hasWindow()) return;
    if (!updateWH()) return;

    // 屏幕宽高变了，竖排一列能排多少行也跟着变，要重新拆列。尺寸和位置都在 applyBoxSize
    // 里按百分比重算过了（右下角的上限也跟着新屏幕走）
    if (isVertical) recompose();
    else applyBoxSize();

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
    verticalRotateLatin = options.getBoolean("verticalRotateLatin", verticalRotateLatin);
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
    backgroundColor = options.getString("backgroundColor", backgroundColor);
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
    textView = new LyricSwitchView(reactContext, isSingleLine && !isVertical, isShowToggleAnima,
      isVertical && verticalRotateLatin);

    textView.setTextColor(parseColor(playedColor));
    textView.setShadowColor(parseColor(shadowColor));
    textView.setAlpha(alpha);
    textView.setTextSize(textSize);
    // 文本要等字号设好再拆：竖排得先按字号算出「一列能排多少行」，才知道在哪里拐列
    textView.setText("");
    textView.setText(formatVerticalText(currentLyric));
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
  /**
   * 窗口还在不在（我们自己挂上去过、还没摘）。
   *
   * 不直接用 textView.isAttachedToWindow()：addView 之后要等下一次遍历它才变 true，
   * 紧接着 show 之后的设置会被误判成「没有窗口」而白白丢掉。
   *
   * textView 非空也不代表窗口在 —— addView 失败（比如悬浮窗权限被收回）之后它会一直留着，
   * 那种状态下窗口其实起不来，随便改个设置都能把 App 弄崩（removeView 抛 not attached）。
   */
  private boolean hasWindow() {
    return textView != null && windowAttached;
  }

  /** 把当前窗口从 WindowManager 上摘掉。窗口不在上面时 removeView 会抛，忽略即可 */
  private void removeViewFromWindow() {
    if (textView == null || windowManager == null) return;
    try {
      windowManager.removeView(textView);
    } catch (Exception e) {
      Log.e("Lyric", "removeView: " + e.getMessage());
    }
    windowAttached = false;
  }

  /** 把窗口挂上去。挂不上（比如悬浮窗权限被收回）就把 textView 丢掉，别留一个没挂上的僵尸 */
  private void addViewToWindow() {
    try {
      windowManager.addView(textView, layoutParams);
      windowAttached = true;
    } catch (Exception e) {
      textView = null;
      windowAttached = false;
      throw e;
    }
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
      removeViewFromWindow();
      // 已经不要它了：万一它压根没挂上去（removeView 抛了），也得丢掉，别留着
      textView = null;
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

    // 位置已经由上面的 applyBoxSize 按存的百分比算好并夹回屏内了

    //设置透明
    layoutParams.format = PixelFormat.TRANSPARENT;

    //添加到window中
    addViewToWindow();
  }

  public void setLyric(String text, ArrayList<String> extendedLyrics) {
    if (text.equals("") && text.equals(currentLyric) && extendedLyrics.size() == 0) return;
    currentLyric = text;
    currentExtendedLyrics = extendedLyrics;
    if (textView == null) return;
    int maxExtended = 0;
    if (extendedLyrics.size() > 0) {
      if (isVertical) {
        // 竖排：不开单行时每个扩展行各占一列，都带上；开了单行全挤在一列里，
        // 只带一行，不然一列能拖到屏幕外面去
        maxExtended = isSingleLine ? 1 : extendedLyrics.size();
      } else if (maxLineNum > 1 && !isSingleLine) {
        maxExtended = maxLineNum - 1;
      }
    }
    if (maxExtended > 0) {
      int num = maxExtended;
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
    int maxX = Math.max(0, maxWidth - layoutParams.width);
    int maxY = Math.max(0, maxHeight - layoutParams.height);

    switch (event.getAction()){
      case MotionEvent.ACTION_DOWN:
        // 获取按下时的X，Y坐标
        lastX = event.getRawX();
        lastY = event.getRawY();

        preY = lastY;
        downX = lastX;
        downY = lastY;
        downTime = event.getEventTime();
        isMoved = false;
        isDragging = true;
        // 记下窗口当前在哪：抬手时用它判断窗口到底动没动过。位移小于 touchSlop 的拖动不会把
        // isMoved 置真，但窗口是真的挪了，不写回设置的话下次换行就会被弹回原位
        downLayoutX = layoutParams.x;
        downLayoutY = layoutParams.y;
        break;
      case MotionEvent.ACTION_MOVE:
        // 获取移动时的X，Y坐标
        nowX = event.getRawX();
        nowY = event.getRawY();
        if (preY == 0){
          preY = nowY;
        }
        // 动过就不算长按了（不然拖到一半停一下会被判成长按，窗口锁住、拖动也断了）
        if (!isMoved && (Math.abs(nowX - downX) > touchSlop || Math.abs(nowY - downY) > touchSlop)) {
          isMoved = true;
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
        // 长按 = 请求锁定：按住没动过、超过 500ms、抬手时才认。这里只把动作报给 JS，
        // 锁不锁由 JS 侧的设置决定（锁定后窗口是 FLAG_NOT_TOUCHABLE，收不到触摸）
        if (!isMoved && event.getEventTime() - downTime >= LONG_PRESS_MS && lyricEvent != null) {
          lyricEvent.sendEvent(lyricEvent.VIEW_LONG_PRESS, null);
        }
        isDragging = false;
        // 窗口真的挪了才上报。原来是拿 0~100 的 percentageX 去和 0~1 的 prevViewPercentageX 比，
        // 条件恒为真，随便点一下抬手就会写一次设置；改成看 isMoved 又漏了小于 touchSlop 的拖动，
        // 那种拖动窗口也会动，所以直接比按下和抬起时的窗口坐标
        if (layoutParams.x != downLayoutX || layoutParams.y != downLayoutY) {
          prevViewPercentageX = (float)layoutParams.x / (float) maxWidth;
          prevViewPercentageY = (float)layoutParams.y / (float) maxHeight;
          sendPositionEvent(prevViewPercentageX * 100f, prevViewPercentageY * 100f);
        }
        break;
      case MotionEvent.ACTION_CANCEL:
        isDragging = false;
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
    if (windowManager == null || layoutParams == null) return;
    layoutParams.flags = getLayoutParamsFlags();

    if (Build.VERSION.SDK_INT > Build.VERSION_CODES.R) {
      layoutParams.alpha = 0.8f;
    }
    // layoutParams 已经改好了；窗口没挂上去就别 updateViewLayout（会抛 not attached），
    // 下次显示时按这份 layoutParams 生效
    if (!hasWindow()) return;
    windowManager.updateViewLayout(textView, layoutParams);
  }

  public void unlockView() {
    isLock = false;
    if (windowManager == null || layoutParams == null) return;
    layoutParams.flags = getLayoutParamsFlags();

    if (Build.VERSION.SDK_INT > Build.VERSION_CODES.R) {
      layoutParams.alpha = 1.0f;
    }
    if (!hasWindow()) return;
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

  /** 设置背景框颜色（rgba 字符串），透明度仍由 backgroundOpacity 控制 */
  public void setLyricBackgroundColor(String color) {
    if (color == null) return;
    backgroundColor = color;
    if (windowManager == null || textView == null) return;
    applyBackground();
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
    // 窗口没挂在屏幕上就别重建了：值已经存下，下次显示时 createTextView 会带上
    if (!hasWindow()) return;
    removeViewFromWindow();
    createTextView();
    applyBoxSize();
    addViewToWindow();

    if (isLock) lockView();
    else unlockView();

    setLyric(currentLyric, currentExtendedLyrics);
  }

  /** 切换竖向显示：文字布局方式变了，重建 TextView 再按当前歌词重算窗口大小与位置 */
  public void setVertical(boolean vertical) {
    this.isVertical = vertical;
    // 窗口没挂在屏幕上就别重建了：值已经存下，下次显示时 createTextView 会带上
    if (!hasWindow()) return;
    removeViewFromWindow();
    createTextView();
    applyBoxSize();
    addViewToWindow();

    if (isLock) lockView();
    else unlockView();

    setLyric(currentLyric, currentExtendedLyrics);
  }

  public void setShowToggleAnima(boolean showToggleAnima) {
    isShowToggleAnima = showToggleAnima;
    if (textView == null) return;
    textView.setShowAnima(showToggleAnima);
  }

  /**
   * 切换「竖排时英文横倒」。文本网格没变，只是换了个绘制类，所以按当前歌词重排一遍就够
   * （TextView 的实现类换不了，只能跟 setVertical 一样重建）
   */
  public void setVerticalRotateLatin(boolean rotateLatin) {
    this.verticalRotateLatin = rotateLatin;
    // 横向时这项用不上，别白重建一次窗口；值已经存下，切到竖排时会带上
    if (!isVertical) return;
    // 窗口没挂在屏幕上就别去碰它：值已经存下，下次显示时 createTextView 会带上
    if (!hasWindow()) return;
    removeViewFromWindow();
    createTextView();
    applyBoxSize();
    addViewToWindow();

    if (isLock) lockView();
    else unlockView();

    setLyric(currentLyric, currentExtendedLyrics);
  }

  public void setTextSize(float size) {
    this.textSize = size;
    if (windowManager == null || textView == null) return;
    textView.setTextSize(size);
    // 竖排一列能排多少行跟字号有关，字号变了要重新拆列
    if (isVertical) recompose();
    else applyBoxSize();
  }

  public void destroyView() {
    if (textView == null) return;
    // 摘不下来也照样丢掉引用，不然这个「僵尸」会一直留着，之后所有设置都改不动
    removeViewFromWindow();
    textView = null;
    removeOrientationEvent();
  }

  public void destroy() {
    destroyView();
    windowManager = null;
    layoutParams = null;
  }
}
