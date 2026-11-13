// Applied by dependencies-patch.js after npm installs react-native-fs.
// Keep each replacement independently idempotent for repeated postinstall runs.
module.exports = [
  [
    'FS.common.js',
    'var jobId = 0;',
    `var jobId = 0;

// LX: Only active downloads retain progress callbacks.
var downloadSubscriptions = new Map();
function clearDownloadSubscriptions(jobId) {
  var subscriptions = downloadSubscriptions.get(jobId);
  if (!subscriptions) return;
  downloadSubscriptions.delete(jobId);
  subscriptions.forEach(sub => { try { sub.remove(); } catch (error) {} });
  subscriptions.length = 0;
}`,
  ],
  [
    'FS.common.js',
    `  stopDownload(jobId: number): void {
    RNFSManager.stopDownload(jobId);
  },`,
    `  stopDownload(jobId: number): void {
    // Native I/O may take time to stop; detach this job's UI callbacks now.
    clearDownloadSubscriptions(jobId);
    RNFSManager.stopDownload(jobId);
  },`,
  ],
  [
    'FS.common.js',
    `    return {
      jobId,
      promise: RNFSManager.downloadFile(bridgeOptions).then(res => {
        subscriptions.forEach(sub => sub.remove());
        return res;
      })
        .catch(e => {
          return Promise.reject(e);
        })
    };`,
    `    downloadSubscriptions.set(jobId, subscriptions);
    try {
      return {
        jobId,
        // Bind only the ID: a pending native Promise must not retain options/callbacks after cancellation.
        promise: RNFSManager.downloadFile(bridgeOptions).finally(clearDownloadSubscriptions.bind(null, jobId))
      };
    } catch (error) {
      clearDownloadSubscriptions(jobId);
      throw error;
    }`,
  ],
  [
    'android/src/main/java/com/rnfs/RNFSManager.java',
    '  private SparseArray<Downloader> downloaders = new SparseArray<>();',
    '  private final java.util.concurrent.ConcurrentHashMap<Integer, Downloader> downloaders = new java.util.concurrent.ConcurrentHashMap<>();',
  ],
  [
    'android/src/main/java/com/rnfs/RNFSManager.java',
    `      params.onTaskCompleted = new DownloadParams.OnTaskCompleted() {
        public void onTaskCompleted(DownloadResult res) {
          if (res.exception == null) {`,
    `      final Downloader downloader = new Downloader();
      params.onTaskCompleted = new DownloadParams.OnTaskCompleted() {
        public void onTaskCompleted(DownloadResult res) {
          // LX: Called after the downloader closes its streams, for every terminal outcome.
          downloaders.remove(jobId, downloader);
          if (res.exception == null) {`,
  ],
  [
    'android/src/main/java/com/rnfs/RNFSManager.java',
    `      Downloader downloader = new Downloader();

      downloader.execute(params);

      this.downloaders.put(jobId, downloader);`,
    `      // LX: Register first so an immediately completed job cannot be reinserted afterwards.
      this.downloaders.put(jobId, downloader);
      try {
        downloader.execute(params);
      } catch (Exception error) {
        this.downloaders.remove(jobId, downloader);
        throw error;
      }`,
  ],
]
