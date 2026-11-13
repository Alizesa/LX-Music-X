// Kept as an explicit failure for older callers: there must be only one
// version allocator, and it runs atomically against release-meta in CI.
module.exports = async() => {
  throw new Error('版本号、版本码与更新说明由 publish/release.cjs 的 CI 发布流程生成')
}
