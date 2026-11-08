// Playback tests run with diagnostic logging disabled unless they explicitly inject the real logger.
module.exports = {
  playbackLog() {}, playbackLogState() {}, playbackLogId() {}, newPlaybackLogId() {},
  registerPlaybackLogSnapshot: () => () => {}, isPlaybackLogEnabled: () => false,
}
