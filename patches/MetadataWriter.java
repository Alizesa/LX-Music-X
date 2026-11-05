package com.localmediametadata;

import android.os.Bundle;
import android.util.Log;
import com.facebook.react.bridge.ReactApplicationContext;
import org.jaudiotagger.audio.AudioFile;
import org.jaudiotagger.audio.AudioFileIO;
import org.jaudiotagger.tag.FieldKey;
import org.jaudiotagger.tag.Tag;
import org.jaudiotagger.tag.flac.FlacTag;
import org.jaudiotagger.tag.images.Artwork;
import org.jaudiotagger.tag.images.ArtworkFactory;
import java.io.File;

/** 下载标签一次解析、一次提交；由 dependencies-patch.js 安装到依赖。 */
public final class MetadataWriter {
  private static void write(File file, Bundle metadata, String picPath, String lyric) throws Exception {
    AudioFile audioFile = AudioFileIO.read(file);
    Tag tag = audioFile.createDefaultTag();
    audioFile.setTag(tag);
    tag.setField(FieldKey.TITLE, metadata.getString("name", ""));
    tag.setField(FieldKey.ARTIST, metadata.getString("singer", ""));
    tag.setField(FieldKey.ALBUM, metadata.getString("albumName", ""));
    if (picPath != null && !picPath.isEmpty()) {
      try {
        Artwork artwork = ArtworkFactory.createArtworkFromFile(new File(picPath));
        if (tag instanceof FlacTag) {
          tag.setField(((FlacTag) tag).createArtworkField(
            artwork.getBinaryData(), artwork.getPictureType(), artwork.getMimeType(),
            artwork.getDescription(), artwork.getWidth(), artwork.getHeight(), 0,
            "image/jpeg".equals(artwork.getMimeType()) ? 24 : 32));
        } else {
          tag.setField(artwork);
        }
      } catch (Exception error) {
        Log.w("MetadataWriter", "Unable to embed artwork", error);
      }
    }
    if (lyric != null && !lyric.isEmpty()) {
      try {
        tag.setField(FieldKey.LYRICS, lyric);
      } catch (Exception error) {
        Log.w("MetadataWriter", "Unable to embed lyrics", error);
      }
    }
    audioFile.commit();
  }

  public static void writeTags(ReactApplicationContext context, String path, Bundle metadata,
                               String picPath, String lyric) throws Exception {
    MediaFile mediaFile = new MediaFile(context, path);
    try {
      try {
        write(mediaFile.getFile(true), metadata, picPath, lyric);
      } catch (Exception error) {
        // 部分 SAF provider 不支持原地改写，合并后的标签也只复制一次临时文件。
        mediaFile.closeFile();
        write(mediaFile.getTempFile(), metadata, picPath, lyric);
      }
    } finally {
      mediaFile.closeFile();
    }
  }
}
