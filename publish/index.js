console.error('版本与 Android 版本码由 master / Next 的 CI 发布流程统一分配。')
console.error('手动重跑请使用 Android release 工作流，并填写原推送的完整源提交 SHA。')
process.exitCode = 1
