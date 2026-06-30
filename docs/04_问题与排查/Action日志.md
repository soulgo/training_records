# Action 日志

## 现象

- GitHub Actions 结论为 success，但业务未完成。
- summary 中出现 `business incomplete` warning。
- 部署 workflow 未被找到或超时。
- `[action-log]` 中出现 `WARN` / `ERROR`。
- AI 或 DB summary 显示 fallback、retry、pending、rollback 或 slow query。
- `npm run export:markdown -- --debug-json` 在 GitHub Actions 中失败。

## 原因

- 同步 step 成功执行，但某些 batch 为 `pending_replay`、`manual_intervention` 或 `partialFailure`。
- DB-only 变化触发了部署，但部署 workflow 查询超时。
- 通知 step 设置 `continue-on-error`，通知失败不会改变主同步结果。
- `tools/action-sync-summary.mjs` 未读到 result file 时会写 summary missing result，但 workflow 仍继续执行后续失败通知逻辑。
- DB 写入失败时会携带 `persistenceResult` 安全摘要；可恢复失败会进入 pending replay。
- `export:markdown` 的完整 payload 只允许本地 `--debug-json`，GitHub Actions 中会拒绝，避免训练 snapshot 进入日志。

## 日志特征

- `[action-log]`
- `traceId`
- `business incomplete`
- `pending_replay`
- `manual_intervention`
- `queue_task_id`
- `queueTaskId`
- `workflow run 查找超时` / `run lookup timeout`
- `dead-letter`
- `payload_hash` / `payloadHash`
- `unchanged`
- `Deploy workflow not found`
- `Deploy workflow timed out`
- `sync.summary.completed`
- `sync.summary.missing_result`
- `fallbackUsed`
- `retryCount`
- `totalTokens`
- `transactionId`
- `rowCounts`
- `rollbackStatus`
- `slow=`
- `sha256:`

## 排查步骤

1. 先看 summary 的 `Run context`，记录 `traceId`、`queueTaskId`、`workflow`、`runId` 和 `channel`。
2. 看 `Business result` 表格中的 `taskStatus`、`persistenceStatus`、`failureDisposition`、`failed messageIds`。
3. 看 `AI` 表：`provider`、`model`、`promptVersion` 是否符合预期，`fallbackUsed`、`retryCount`、`attemptKinds`、`totalTokens` 是否解释了耗时或失败。
4. 看 `Database` 表：`status`、`transactionId`、`rowCounts`、`pendingStatus`、`rollbackStatus`、`durationMs`、`slowQueries`。`slowQueries` 只显示 operation/table/duration/threshold，不会显示 SQL 参数。
5. 看 `Image storage` 表是否有 failed；bucket/pathPrefix 应显示 hash，不应出现完整 COS 路径。
6. 看 `Site deploy result` 的 workflow、runId、conclusion、duration 和 URL。
7. 搜索同一 `traceId` 的 `[action-log]`。Deploy 等待阶段每 6 次 attempt 输出一次 `workflow.waiting`。
8. 对失败步骤查对应脚本：`tools/telegram-action-monitor.mjs`、`tools/feishu-action-monitor.mjs`。
9. 队列任务必须用 `queueTaskId` 关联 workflow run。若出现 workflow run 查找超时 / run lookup timeout，先查 Worker/Queue 日志，再查 `SyncDispatchQueue` dead-letter。
10. 重跑 / rerun 时复用原始 payload，避免改变 `payload_hash` / `payloadHash`。同一 `batch_id + payload_hash` 重复执行应返回 `unchanged`，不得重复写 core。
11. 如果日志出现 `SYNC_DISPATCH_PAYLOAD` 原文、`file_id`、飞书完整 `oc_`、完整 COS key、Prompt 全文、caption/text、SQL 参数、DB URL 或完整训练 snapshot，把它当成日志脱敏回归处理。

## 解决方案

- `pending_replay`：先修复 DB 或 AI/COS 根因，再重放。
- `manual_intervention`：修正用户输入或目标随想 id。
- 部署失败：单独重跑 Pages workflow。
- run lookup timeout：确认 workflow dispatch 已发出、`queue_task_id` 是否进入 run-name，再按 dead-letter 记录重放。
- `unchanged`：代表相同 payload 已处理，不应人工重复写 `core.*`。
- `sync.summary.missing_result`：先查同步 step 是否写出 result file，再查 `TELEGRAM_SYNC_RESULT_PATH` / `FEISHU_SYNC_RESULT_PATH`。
- `fallbackUsed=true` 或 `retryCount>0`：先查 provider HTTP 状态、schema fallback 和 fallback provider；不要把测试 fixture 日志误判为真实 AI 故障。
- `slowQueries` 非空：先看 operation/table 和 `durationMs`，再结合数据库连接、索引和当次负载排查；不要期待 Action 日志里有 SQL 参数。
- `rollbackStatus=failed`：优先查 DB 连接和事务状态，再查 pending 是否已 queued。
- `--debug-json is disabled in GitHub Actions`：移除 Actions 中的 `--debug-json`，本地调试才允许完整 payload。
- 原始 payload 或健康 snapshot 泄漏：先检查 `.github/workflows/sync.yml`、`.github/workflows/sync-dev.yml` 是否又写入 `SYNC_DISPATCH_PAYLOAD`，以及 `tools/training-maintenance.mjs export markdown` 是否绕过 compact summary。

## 预防措施

- 不只看 Actions 绿色结论，要看业务状态字段。
- 新增状态字段时同步 summary 输出。
- 重跑队列任务前保留原始 payload 和 `payload_hash`，确保幂等判断继续生效。
- 新增日志必须走 `tools/lib/action-logger.mjs` 或等价脱敏白名单。
- 新增 summary 字段前先判断是否包含 Secret、Prompt、用户文本、SQL 参数、原始 ID 或健康明细。
- 当前系统文档只记录已落地事实；未实施设想保留在历史记录，不作为排查入口。
