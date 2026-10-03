package cn.toside.music.mobile.lyric;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.text.TextPaint;
import android.widget.TextView;

import java.util.ArrayList;

/**
 * 竖排歌词里「英文这类拉丁字母横倒 90°」的画法。
 *
 * 竖排的文本是 LyricView.formatVerticalText() 拼好的网格：每个 '\n' 是一行，
 * 行里第 p 个码点属于第 p 列（各列等长，短的用全角空格补齐）。这里把网格按「一列一列
 * 往下读」还原，再按格绘制：
 *
 * - 汉字这类照旧正着摆，一个占一格（一格 = 字体自己的行高）；
 * - 一串连续的半角字符里只要带字母或数字，就算一个整体，旋转 90° 画出来，并且「画出来多长就往下
 *   占多长」——半角字符横向只有汉字六成宽，按格数算长度会让它后面空出一大截。于是一个词是一整块
 *   横倒的字（歪头看是连续的），而不是 h-e-l-l-o 五个正着的字母；
 * - 整串都是标点的（单独的 "-"、"- - -"、"." 这类）照旧正着摆：半角短横线横倒只剩一根细竖线，
 *   看着跟空了一格似的。括号是例外，半角全角都倒（落单的也倒），见 isBracket
 *
 * 网格、列数、字号全都沿用原来那套，只有画法不同；开了横倒时窗口会按「每列至少一个行高」
 * 加宽（见 LyricView.applyBoxSize），横倒的字才不用缩、也不会压到隔壁列上。
 */
@SuppressLint("AppCompatCustomView")
public class LyricVerticalTextView extends TextView {
  /** 一个格子：要么是一个正着的字，要么是一串整体横倒的文字 */
  private static final class Cell {
    String text;
    boolean rotate;
    int column;
  }

  private static final int ROTATE_DEGREES = 90;

  private final TextPaint mPaint;
  private final Paint.FontMetrics fontMetrics = new Paint.FontMetrics();
  // 不能写成 `= new ArrayList<>()`：TextView 的构造函数里就会回调 onTextChanged，而字段初始化器
  // 要等 super() 返回之后才跑，那次回调里 cells 还是 null（踩过：cells.clear() NPE，整个桌面歌词
  // 一个字都显示不出来）。统一由 buildCells 换一个新的 list
  private ArrayList<Cell> cells;
  private boolean rotateLatin;
  private int columnCount = 0;
  private int rowCount = 0;

  public LyricVerticalTextView(Context context, boolean rotateLatin) {
    super(context);
    mPaint = getPaint();
    this.rotateLatin = rotateLatin;
  }

  public void setRotateLatin(boolean rotateLatin) {
    if (this.rotateLatin == rotateLatin) return;
    this.rotateLatin = rotateLatin;
    buildCells(getText() == null ? "" : getText().toString());
    invalidate();
  }

  @Override
  protected void onTextChanged(CharSequence text, int start, int lengthBefore, int lengthAfter) {
    super.onTextChanged(text, start, lengthBefore, lengthAfter);
    buildCells(text == null ? "" : text.toString());
    invalidate();
  }

  @Override
  protected void onDraw(Canvas canvas) {
    if (!rotateLatin) {
      super.onDraw(canvas);
      return;
    }
    if (cells == null || cells.isEmpty() || columnCount <= 0 || rowCount <= 0) return;
    float contentWidth = getWidth() - getPaddingLeft() - getPaddingRight();
    float contentHeight = getHeight() - getPaddingTop() - getPaddingBottom();
    if (contentWidth <= 0 || contentHeight <= 0) return;

    // 「把当前文字颜色刷进画笔」本来是 TextView 在自己的 onDraw 里做的，这里绕开了
    // super.onDraw，不补这一下，画笔就一直是构造时的颜色，一个字都画不出来
    // （横向的 LyricTextView 同样是自绘的，它靠重写 setTextColor 做了同一件事）
    mPaint.setColor(getCurrentTextColor());

    float cellWidth = contentWidth / columnCount;
    mPaint.getFontMetrics(fontMetrics);
    float lineHeight = fontMetrics.descent - fontMetrics.ascent;
    // 一行的高度用字体自己的行高，不拿「窗口高 ÷ 行数」去摊：窗口高和「行数 × 行高」一旦对不上
    // （首屏那次 maxHeight 还是 0、整句排成一长列时就会被截断成对不上），摊出来的格高只有行高的
    // 六成，字会互相盖住、看着又细又挤。用原生行高就永远是正常大小，顶多超出窗口被裁掉。
    // 取的是 applyBoxSize 量窗口高度用的同一个值，格距和框高才是一致的
    float cellHeight = mPaint.getFontMetricsInt(null);
    // 让文字以格心为中线
    float baselineOffset = -(fontMetrics.ascent + fontMetrics.descent) / 2;
    // 横倒之后，这一串文字占的「厚」是字体的行高。正常情况窗口宽度已经保证每格不比行高窄
    // （见 LyricView.applyBoxSize），这里算出来就是 1；万一窗口还是被挤窄了，缩一点总比压到
    // 隔壁列上强
    float scale = lineHeight > cellWidth ? cellWidth / lineHeight : 1f;

    // 每列各自往下排，位置是「前面那些格子依次占掉之后」累加出来的：
    // 正着的字一个占一格（字体行高），横倒的一串按它自己画出来有多长就占多长。
    //
    // 不能一律拿「占了几格 × 行高」当长度：半角字符横向只有汉字六成宽，一串 22 个字符的英文
    // 横倒之后画出来只有它占的那几格的三分之一长，剩下三分之二会变成下一个字前面的一大段空白
    // （踩过："Time of the nihility - 凌" 里 "凌" 前面整整空了一大截，看着像被 "-" 顶开的）。
    // 按实际长度往下走，横倒的串后面紧跟着就是下一个字
    float[] columnY = new float[columnCount];
    for (Cell cell : cells) {
      float cx = getPaddingLeft() + (cell.column + 0.5f) * cellWidth;
      float advance = cell.rotate ? mPaint.measureText(cell.text) * scale : cellHeight;
      float cy = getPaddingTop() + columnY[cell.column] + advance / 2f;
      columnY[cell.column] += advance;
      if (!cell.rotate) {
        canvas.drawText(cell.text, cx - mPaint.measureText(cell.text) / 2f, cy + baselineOffset, mPaint);
        continue;
      }
      // 横倒的串画出来正好是 advance 那么长（绕格心转、再按同一个点心缩放），两头不会有空档
      canvas.save();
      canvas.rotate(ROTATE_DEGREES, cx, cy);
      if (scale != 1f) canvas.scale(scale, scale, cx, cy);
      canvas.drawText(cell.text, cx - mPaint.measureText(cell.text) / 2f, cy + baselineOffset, mPaint);
      canvas.restore();
    }
  }

  /** 把网格拆成一个个格子 */
  private void buildCells(String text) {
    cells = new ArrayList<>();
    columnCount = 0;
    rowCount = 0;
    if (text.isEmpty()) return;

    String[] rows = text.split("\n", -1);
    rowCount = rows.length;
    if (rowCount == 0) return;

    ArrayList<int[]> rowCodePoints = new ArrayList<>(rowCount);
    for (String row : rows) {
      int[] codePoints = new int[row.codePointCount(0, row.length())];
      int index = 0;
      for (int i = 0; i < row.length(); ) {
        int codePoint = row.codePointAt(i);
        codePoints[index++] = codePoint;
        i += Character.charCount(codePoint);
      }
      rowCodePoints.add(codePoints);
      if (codePoints.length > columnCount) columnCount = codePoints.length;
    }
    if (columnCount == 0) return;

    for (int column = 0; column < columnCount; column++) {
      int row = 0;
      while (row < rowCount) {
        int codePoint = codePointAt(rowCodePoints.get(row), column);
        if (codePoint < 0) {
          row++;
          continue;
        }
        if (!rotateLatin || !isRotatable(codePoint)) {
          addCell(column, new String(Character.toChars(codePoint)), false);
          row++;
          continue;
        }
        // 连着能转的字算一串，整体横倒
        StringBuilder run = new StringBuilder();
        while (row < rowCount) {
          int cp = codePointAt(rowCodePoints.get(row), column);
          if (cp < 0 || !isRotatable(cp)) break;
          run.appendCodePoint(cp);
          row++;
        }
        String runText = run.toString();
        if (containsLetterOrDigit(runText)) {
          // 末尾的空格不再单独剥出来：长度按实际画出来算，留着的空格就是词间空白，
          // 后面那个字接着它排（整串空格的情况不会走到这，见下面 else）
          addCell(column, runText, true);
        } else {
          // 整串都是标点或空格（单独的 "-"、"- - -"、"..." 这类）：不横倒，跟汉字一样一个字占一格。
          // 半角的短横线转 90° 之后只有十几像素长、两像素宽的细竖线，掉在五六十像素的格子里
          // 看着就像空了一格（踩过）。字母数字带头的串才值得倒，"well-known" 这种不会被拆开。
          //
          // 括号是例外，落单的也倒（见 isBracket）。注意是逐字判、不是整串判：
          // "(-)"、"——（" 这种括号和短横线混在一起的串整串倒下去，短横线就又变回那根细竖线了，
          // 正是这条规则要躲开的退化
          for (int i = 0; i < runText.length(); ) {
            int cp = runText.codePointAt(i);
            addCell(column, new String(Character.toChars(cp)), isBracket(cp));
            i += Character.charCount(cp);
          }
        }
      }
    }
  }

  /** 这一串里有没有字母或数字（有才值得整体横倒，见上面调用处的注释） */
  private static boolean containsLetterOrDigit(String text) {
    for (int i = 0; i < text.length(); ) {
      int codePoint = text.codePointAt(i);
      if (Character.isLetterOrDigit(codePoint)) return true;
      i += Character.charCount(codePoint);
    }
    return false;
  }

  /**
   * 能不能横倒。半角拉丁字母、数字、半角符号、词间空格算「能」，中文日文、全角标点、
   * emoji 这些照旧正着摆。0x2E80 是中日韩部首补充的起点，之前的码位基本都是西文。
   * 括号不管半角全角都算「能」，理由见 isBracket。
   */
  private static boolean isRotatable(int codePoint) {
    if (codePoint == ' ' || isBracket(codePoint)) return true;
    return codePoint < 0x2E80 && !Character.isWhitespace(codePoint);
  }

  /**
   * 括号（半角/全角的圆括号、方括号、花括号）。
   *
   * 一般标点不横倒是为了躲开「半角短横线转 90° 只剩一根细竖线」这种退化，但括号没有这个
   * 问题，而正着摆的括号在竖排里其实很难看：竖排的括号本来就该倒着（弧口朝上下）。
   *
   * 更麻烦的是半角在可倒集里、全角不在，于是两种宽度混着写的时候、或者一对括号被拆到
   * 相邻两列里各自成串的时候，会出现「左括号倒了而右括号没倒」——半个括号倒着的怪样子（踩过）。
   * 所以两种宽度一起并进可倒集，并且在「整串没字母数字」那条不横倒的规则里也给它开个口子
   * （见 buildCells），让落单的括号跟着倒。
   */
  private static boolean isBracket(int codePoint) {
    switch (codePoint) {
      case '(': case ')':
      case '[': case ']':
      case '{': case '}':
      case 0xFF08: case 0xFF09: // （）
      case 0xFF3B: case 0xFF3D: // ［］
      case 0xFF5B: case 0xFF5D: // ｛｝
        return true;
      default:
        return false;
    }
  }

  private static int codePointAt(int[] codePoints, int index) {
    return index < codePoints.length ? codePoints[index] : -1;
  }

  private void addCell(int column, String text, boolean rotate) {
    Cell cell = new Cell();
    cell.column = column;
    cell.text = text;
    cell.rotate = rotate;
    cells.add(cell);
  }
}
