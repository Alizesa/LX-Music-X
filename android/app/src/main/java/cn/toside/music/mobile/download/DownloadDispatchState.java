package cn.toside.music.mobile.download;

// 在同一把锁内调用。完成代次持久化后，才封口当前原生调度者。
final class DownloadDispatchState {
  long requested;
  long completed;
  boolean queued;
  String owner;

  DownloadDispatchState(long requestedEpoch, long completedEpoch) {
    requested = requestedEpoch;
    completed = completedEpoch;
  }

  boolean request() {
    requested++;
    if (owner != null || queued) return false;
    queued = true;
    return true;
  }

  boolean recover() {
    if (requested <= completed || owner != null || queued) return false;
    queued = true;
    return true;
  }

  void start(String identity) {
    owner = identity;
    queued = false;
  }

  long claim() {
    return requested;
  }

  boolean complete(String identity, long generation) {
    if (owner == null || !owner.equals(identity)) return true;
    if (requested != generation) return false;
    completed = generation;
    owner = null;
    return true;
  }

  void fail(String identity) {
    if (owner != null && owner.equals(identity)) owner = null;
  }

  void enqueueFailed() {
    queued = false;
  }

  boolean isActive() {
    return owner != null;
  }
}
