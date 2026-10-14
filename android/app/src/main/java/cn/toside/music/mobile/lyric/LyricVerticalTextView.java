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
 * - 一串连续的「可横倒」字符算一个整体，旋转 90° 画出来，并且「画出来多长就往下占多长」——
 *   半角字符横向只有汉字六成宽，按格数算长度会让它后面空出一大截。于是一个词是一整块横倒的
 *   字（歪头看是连续的），而不是 h-e-l-l-o 五个正着的字母；
 * - 标点里只有最常用的那几个（半角 , . ? ! ; : 和它们的全角写法）例外：正着摆，而且会把左右
 *   两边的横倒串切开（见 isCommonPunctuation）。括号、数字、短横线这类不常用的标点一律横倒，
 *   不再要求「这一串里得有字母或数字」
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
        // 连着能横倒的字算一串，整体旋转 90° 画出来。末尾的空格不再单独剥出来：长度按实际
        // 画出来算，留着的空格就是词间空白，后面那个字接着它排
        StringBuilder run = new StringBuilder();
        while (row < rowCount) {
          int cp = codePointAt(rowCodePoints.get(row), column);
          if (cp < 0 || !isRotatable(cp)) break;
          run.appendCodePoint(cp);
          row++;
        }
        addCell(column, run.toString(), true);
      }
    }
  }

  /**
   * 常用标点：永远正着摆，并且会把左右两边的横倒串切开（"Hello, world!" 是 Hello 横倒、
   * 逗号正着、world 横倒、感叹号正着）。全角写法由 isRotatable 折回半角之后一起判。
   *
   * 半角这几个转 90° 之后没有「横躺的字」的样子（逗号是块小尾巴、句号是个点、问号是个钩），
   * 混在横倒的英文里只是脏，所以只留它们正着。
   */
  private static boolean isCommonPunctuation(int codePoint) {
    switch (codePoint) {
      case ',': case '.': case '?': case '!': case ';': case ':':
        return true;
      default:
        return false;
    }
  }

  /**
   * 中日韩区里的括号：直角引号 「」『』 和它们的半角 ｢｣、书名号 〈〉《》、
   * 方括号 【】〔〕〖〗〘〙〚〛。
   *
   * 半角、全角 ASCII 变体的括号靠 isRotatable 里的「折回半角」就能倒，这些码位在中日韩区、
   * 折不回去，所以单独列一份。竖排里它们本来就该倒着（弧口朝上下），跟「」在竖排里的正字一样；
   * 全角的不倒、半角的倒也不行——「（」和「」混着写时会出现半边倒半边不倒的怪样子。
   *
   * 不列 ﹁﹂﹃﹄、︵︶ 这些：它们本身就是竖排专用的字形，再转 90° 就横过来了。
   */
  private static boolean isCjkBracket(int codePoint) {
    switch (codePoint) {
      case 0x300C: case 0x300D: // 「」
      case 0x300E: case 0x300F: // 『』
      case 0x3008: case 0x3009: // 〈〉
      case 0x300A: case 0x300B: // 《》
      case 0x3010: case 0x3011: // 【】
      case 0x3014: case 0x3015: // 〔〕
      case 0x3016: case 0x3017: // 〖〗
      case 0x3018: case 0x3019: // 〘〙
      case 0x301A: case 0x301B: // 〚〛
      case 0xFF62: case 0xFF63: // ｢｣（半角直角引号）
        return true;
      default:
        return false;
    }
  }

  /**
   * 能不能横倒。半角拉丁字母、数字、半角符号、词间空格算「能」，中文日文、全角标点、
   * emoji 这些照旧正着摆。0x2E80 是中日韩部首补充的起点，之前的码位基本都是西文。
   *
   * 全角 ASCII 变体（全角括号 （）、全角数字 ０-９、全角符号 ～＊／ 之类）折回半角之后按同一条
   * 规则判：于是全角括号、全角符号跟着半角一起倒，全角的 ．，？！；： 跟半角一样正着。
   * 中日韩区里的括号（「」《》【】这类）折不回去，由 isCjkBracket 单独兜住。
   *
   * 说「能」的不只是字母数字：不常用的标点（短横线、波浪线、星号、括号……）也直接倒，不再要求
   * 「这一串里得有字母或数字」。半角短横线转 90° 只剩一根两像素宽的细竖线、掉在五六十像素的
   * 格子里看着像空了一格——这是知道的取舍：只有最常用的那几个标点值得为它正着摆（原先整串标点
   * 都不倒，就是为了躲这个退化）。
   *
   * 全角空格（U+3000）是补齐网格用的填充，永远正着摆，所以它照样把横倒串隔开。
   */
  private static boolean isRotatable(int codePoint) {
    if (codePoint == ' ') return true;
    if (isCjkBracket(codePoint)) return true;
    if (codePoint >= 0xFF01 && codePoint <= 0xFF5E) codePoint -= 0xFEE0; // 全角 → 半角
    if (Character.isWhitespace(codePoint)) return false;
    return codePoint < 0x2E80 && !isCommonPunctuation(codePoint);
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
