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
 * - 汉字这类照旧正着摆，一个占一格；
 * - 一串连续的拉丁字母/数字/半角符号算一个整体，在它占的那几格中间旋转 90° 画出来。
 *   于是一个词是一整块横倒的字（歪头看是连续的），而不是 h-e-l-l-o 五个正着的字母。
 *
 * 网格、列数、列宽全都沿用原来那套（窗口大小与位置一点没变），只有画法不同。
 */
@SuppressLint("AppCompatCustomView")
public class LyricVerticalTextView extends TextView {
  /** 一个格子：要么是一个正着的字，要么是一串整体横倒的文字 */
  private static final class Cell {
    String text;
    boolean rotate;
    int column;
    int firstRow;
    int lastRow;
  }

  private static final int ROTATE_DEGREES = 90;

  private final TextPaint mPaint;
  private final Paint.FontMetrics fontMetrics = new Paint.FontMetrics();
  private final ArrayList<Cell> cells = new ArrayList<>();
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
    if (cells.isEmpty() || columnCount <= 0 || rowCount <= 0) return;
    float contentWidth = getWidth() - getPaddingLeft() - getPaddingRight();
    float contentHeight = getHeight() - getPaddingTop() - getPaddingBottom();
    if (contentWidth <= 0 || contentHeight <= 0) return;

    // 「把当前文字颜色刷进画笔」本来是 TextView 在自己的 onDraw 里做的，这里绕开了
    // super.onDraw，不补这一下，画笔就一直是构造时的颜色，一个字都画不出来
    // （横向的 LyricTextView 同样是自绘的，它靠重写 setTextColor 做了同一件事）
    mPaint.setColor(getCurrentTextColor());

    float cellWidth = contentWidth / columnCount;
    float cellHeight = contentHeight / rowCount;
    mPaint.getFontMetrics(fontMetrics);
    float lineHeight = fontMetrics.descent - fontMetrics.ascent;
    // 让文字以格心为中线
    float baselineOffset = -(fontMetrics.ascent + fontMetrics.descent) / 2;

    for (Cell cell : cells) {
      float cx = getPaddingLeft() + (cell.column + 0.5f) * cellWidth;
      float cy = getPaddingTop() + (cell.firstRow + cell.lastRow + 1) / 2f * cellHeight;
      if (!cell.rotate) {
        canvas.drawText(cell.text, cx - mPaint.measureText(cell.text) / 2f, cy + baselineOffset, mPaint);
        continue;
      }
      // 横倒之后，这一串文字占的「宽」是字体的行高，而一格只有汉字那么宽，
      // 太长会压到隔壁列上去，按需缩一点
      float scale = lineHeight > cellWidth ? cellWidth / lineHeight : 1f;
      canvas.save();
      canvas.rotate(ROTATE_DEGREES, cx, cy);
      if (scale != 1f) canvas.scale(scale, scale, cx, cy);
      canvas.drawText(cell.text, cx - mPaint.measureText(cell.text) / 2f, cy + baselineOffset, mPaint);
      canvas.restore();
    }
  }

  /** 把网格拆成一个个格子 */
  private void buildCells(String text) {
    cells.clear();
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
          addCell(column, row, row, new String(Character.toChars(codePoint)), false);
          row++;
          continue;
        }
        // 连着能转的字算一串，整体横倒
        int firstRow = row;
        StringBuilder run = new StringBuilder();
        while (row < rowCount) {
          int cp = codePointAt(rowCodePoints.get(row), column);
          if (cp < 0 || !isRotatable(cp)) break;
          run.appendCodePoint(cp);
          row++;
        }
        addRun(column, firstRow, row - 1, run.toString());
      }
    }
  }

  /** 一串横倒的文字。末尾的空白不该跟着转（转出来是一道空条），退回去当普通空格画 */
  private void addRun(int column, int firstRow, int lastRow, String run) {
    int end = run.length();
    while (end > 0 && run.charAt(end - 1) == ' ') end--;
    if (end == 0) {
      addCell(column, firstRow, lastRow, " ", false);
      return;
    }
    int runLength = run.codePointCount(0, end);
    addCell(column, firstRow, firstRow + runLength - 1, run.substring(0, end), true);
    if (end < run.length()) addCell(column, firstRow + runLength, lastRow, " ", false);
  }

  /**
   * 能不能横倒。半角拉丁字母、数字、半角符号、词间空格算「能」，中文日文、全角标点、
   * emoji 这些照旧正着摆。0x2E80 是中日韩部首补充的起点，之前的码位基本都是西文。
   */
  private static boolean isRotatable(int codePoint) {
    if (codePoint == ' ') return true;
    return codePoint < 0x2E80 && !Character.isWhitespace(codePoint);
  }

  private static int codePointAt(int[] codePoints, int index) {
    return index < codePoints.length ? codePoints[index] : -1;
  }

  private void addCell(int column, int firstRow, int lastRow, String text, boolean rotate) {
    Cell cell = new Cell();
    cell.column = column;
    cell.firstRow = firstRow;
    cell.lastRow = lastRow;
    cell.text = text;
    cell.rotate = rotate;
    cells.add(cell);
  }
}
