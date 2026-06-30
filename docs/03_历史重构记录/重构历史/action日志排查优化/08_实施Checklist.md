# Action 日志排查优化实施 Checklist

## 日志隐私安全

- [x] `export:markdown` 默认只输出 compact summary，不把完整 `snapshot` 或健康明细写入 stdout。
- [x] 本地显式 `--debug-json` 可保留完整 payload，GitHub Actions 中禁止使用。
- [x] sync summary 与结构化日志默认 hash `file_id`、`image_key`、`chat_id`、Feishu `oc_`、COS bucket/pathPrefix/key 等敏感字段。
- [x] sync workflows 继续禁止 `DISPATCH_PAYLOAD` / `SYNC_DISPATCH_PAYLOAD` 原文进入 `$GITHUB_ENV` 或日志。

## 排障效率

- [x] 新增统一 action logger，输出 `[action-log]` 单行 JSON，字段包含 `traceId`、`domain`、`event`、`durationMs`、`outcome` 等。
- [x] sync summary 展示 run context、traceId、queueTaskId、channel、batchId、timings 和 business incomplete warning。
- [x] AI summary 展示 provider、model、promptVersion、fallback/retry、duration 和 token totals。
- [x] DB summary 展示 persistenceStatus、transactionId、row count、pending/rollback、duration 和 slow query 摘要。
- [x] deploy wait 输出周期性状态日志，超时/成功 summary 包含 deploy run、duration 和 URL。

## 维护成本

- [x] `sync.yml` 与 `sync-dev.yml` 使用同一个 `tools/action-sync-summary.mjs` 生成 Telegram / Feishu summary。
- [x] summary formatter 覆盖 Telegram 与 Feishu 两个通道，新增字段只在脚本内扩展，不复制 YAML inline Node。
- [x] DB persistence summary 使用白名单 helper，避免上层重复手写安全字段。

## 验证

- [x] focused tests 覆盖 logger、summary、maintenance export、workflow、DB、sync report。
- [x] `npm run test:fast` 通过。
