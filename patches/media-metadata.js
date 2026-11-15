// End every Media3 artwork read once, after inspecting all tracks and formats.
module.exports = [
  [
    'media3/MetadataMedia3.java',
    `      @Override
      public void onSuccess(TrackGroupArray trackGroups) {
        for (int i = 0; i < trackGroups.length; i++) {
          Format format = trackGroups.get(i).getFormat(0);
          Metadata metadata = format.metadata;
          if (metadata == null) continue;
          for(int i2 = 0; i2 < metadata.length(); i2++) {
            Metadata.Entry entry = metadata.get(i2);
            if (entry instanceof ApicFrame) {
              ApicFrame pic = (ApicFrame) entry;
              if ("APIC".equals(pic.id) && pic.pictureType == 3) {
                promise.resolve(writePic(context, uri, picDir, pic.mimeType, pic.pictureData));
                return;
              }
            } else if (entry instanceof PictureFrame) {
              PictureFrame pic = (PictureFrame) entry;
              if (pic.pictureType == 3) {
                promise.resolve(writePic(context, uri, picDir, pic.mimeType, pic.pictureData));
                return;
              }
            }
          }
          promise.resolve("");
        }
      }`,
    `      private String findPicture(TrackGroupArray trackGroups) {
        if (trackGroups == null) return "";
        for (int i = 0; i < trackGroups.length; i++) {
          for (int formatIndex = 0; formatIndex < trackGroups.get(i).length; formatIndex++) {
            Format format = trackGroups.get(i).getFormat(formatIndex);
            Metadata metadata = format.metadata;
            if (metadata == null) continue;
            for (int i2 = 0; i2 < metadata.length(); i2++) {
              Metadata.Entry entry = metadata.get(i2);
              if (entry instanceof ApicFrame) {
                ApicFrame pic = (ApicFrame) entry;
                if ("APIC".equals(pic.id) && pic.pictureType == 3) {
                  return writePic(context, uri, picDir, pic.mimeType, pic.pictureData);
                }
              } else if (entry instanceof PictureFrame) {
                PictureFrame pic = (PictureFrame) entry;
                if (pic.pictureType == 3) {
                  return writePic(context, uri, picDir, pic.mimeType, pic.pictureData);
                }
              }
            }
          }
        }
        return "";
      }

      @Override
      public void onSuccess(TrackGroupArray trackGroups) {
        String result;
        try {
          result = findPicture(trackGroups);
        } catch (Exception error) {
          promise.reject("-1", "read failed: " + error.getMessage());
          return;
        }
        promise.resolve(result);
      }`,
  ],
]
