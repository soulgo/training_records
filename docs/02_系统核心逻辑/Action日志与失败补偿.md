# Action 日志与失败补偿

## 生命周期

同步、部署、监控和 pending replay 是四个独立生命周期：

1. `Sync (Main)` / `Sync (Dev)` 完成消息处理、数据库写入、结果通知和站点部署派发。
2. `Dispatch site deploy` 只调用 GitHub workflow dispatch；不查找 deploy run，也不等待 Pages 发布。
3. 部署 workflow 自己构建、验证页面并在失败时通知原 Telegram/飞书会话。
4. `Action Monitor Report` 通过 `workflow_run` 异步采集已完成的 sync、deploy 和 pending replay。

因此：同步 workflow 成功表示消息处理进程正常结束，并已提交需要的部署请求；它不等于每个业务 batch 都成功。`/分析` 等只读命令可能已经向用户返回失败消息，但 workflow 仍保持成功，业务结论必须查看 sync summary 的 `businessStatus`、`failureCategory` 和 warnings。页面是否发布成功必须查看独立 deploy run。

## 关联 ID

| 字段 | 来源 | 用途 |
| --- | --- | --- |
| `queueTaskId` | Worker Queue / workflow input | 关联 Worker、sync run 和 deploy input。 |
| `traceId` | `queueTaskId` 的 SHA-256 前 16 位 | 在安全日志和 summary 中关联同一业务任务。 |
| `batchId` | 共享消息同步用例 | 关联 `ingest.source_batch`、识别、core 写入和 pending。 |
| `transactionId` | `persistNormalizedBatch()` | 关联一次 PostgreSQL 事务观测。 |

## 同步 summary

`tools/action-sync-summary.mjs` 生成安全摘要，重点包含：

- Run context：workflow、runId、traceId、queueTaskId、channel。
- Batch results：任务状态、`businessStatus`、`failureCategory`、识别结果、归档日期和通知状态；图片批次还含 `completenessStatus`、`missingFields`、`reconciliationStatus`、`conflictFields` 等安全字段（只有字段路径与数量，不含健康数值）。
- AI：provider、model、promptVersion、token/latency/fallback 的安全统计；`recognitionAttemptKinds` 区分主识别、技术 fallback（`fallback`）和业务补全（`fallback_business_completion`）。
- Database：status、transactionId、rowCounts、duration、pendingStatus、rollbackStatus。
- Slow queries：只记录 `queryOrdinal`、operation、table、durationMs、thresholdMs，不输出 SQL 或参数。
- Deploy dispatch：是否成功提交目标 workflow、ref 和必要的 thought 校验输入；不包含 deploy run 结论。
- 睡眠回填失败会把本轮已存储的睡眠 batch 标记为 `partialFailure`，并在 warnings 中记录安全错误摘要；主写入仍保留 `stored`，但不能再把绿色 run 当作回填成功证明。
- `/分析` 回复失败时，summary 将 `businessStatus` 标为 `failed`、`failureDisposition` 标为 `manual_intervention` 并生成 business incomplete warning；原始数据库错误不会写入 summary 表格。

## 数据库观测

`persistNormalizedBatch()` 对 connect、BEGIN、业务 query、COMMIT 和 AI call log 分段计时。messages、assets、recognitions 使用 `jsonb_to_recordset` 集合式 upsert，避免按记录逐条网络往返。超过 `TRAINING_DB_SLOW_QUERY_MS`（默认 1000ms）的调用进入安全慢查询摘要。

`sleepBackfill` 只接收本轮实际写入睡眠数据的归档日期。同一天存在多个 ingest 候选时先按时间顺序合并，再执行一次 core 写入；相同睡眠身份键只保留最新记录，避免单条 `ON CONFLICT` 语句重复更新同一行。

## Action monitor 落库

`.github/workflows/action-monitor-report.yml` 监听：

- `Sync (Main)`
- `Sync (Dev)`
- `Deploy GitHub Pages`
- `Deploy Cloudflare Pages (Dev)`
- `Pending Replay`

workflow 根据被监控 run 的 `head_branch` 选择 `DEV_TRAINING_DB_URL` 或 `TRAINING_DB_URL`，调用 `tools/report-github-action-status.mjs` 写入 `monitor.github_action_runs/jobs/steps/failures`。上报失败不会改变原 workflow 的 conclusion；站点构建还可用 GitHub Actions API 补齐顶层 run。

## pending replay

- 可重试识别或数据库失败进入 `ingest.pending_task`，状态、attempt count、next retry 和失败分类都保存在 PostgreSQL。
- 新 webhook 消息不读取 pending；只有 `SYNC_REPLAY_MODE=scheduled` 才消费到期任务。
- `.github/workflows/pending-replay.yml` 每 6 小时运行，也可手工触发；按 `dev/main × Telegram/飞书` 四个 matrix job 独立重放，并使用独立 job concurrency group。
- 本地 NDJSON pending 和双来源恢复路径已经删除。

## Markdown backup 状态

`Markdown Backup` 只有在数据库导出产生变更且允许提交时才 commit/push。`backup_alert=changed_without_commit` 表示导出内容已变化但 `MARKDOWN_BACKUP_COMMIT` 关闭；`workflow_failed_before_alert_evaluation` 表示 workflow 在生成最终告警结论前失败。两者都需要人工检查 Git diff、数据库读取和目标分支权限，不能把 run success/failed 单独当作备份已落库的证明。

## 队列失败

`SyncDispatchQueue` 最多重试 5 次，退避上限 60 秒。GitHub workflow dispatch 后发生 workflow run 查找超时，或连续失败达到上限时，任务进入 Durable Object `dead-letter`，并向原会话发送“GitHub Action 未能启动”通知。`dead-letter` 只保留最近 100 条安全任务结构。

修复根因后可以按原 payload 重跑；`persistNormalizedBatch()` 使用 `payloadHash` / `payload_hash` 做幂等判断，相同批次返回 `unchanged`，避免重复写 core。

## 安全规则

- 不输出 dispatch payload、chat id 明文、消息正文、图片 file id/key、COS 路径、Prompt、完整 AI 响应、SQL 参数或 Secret。
- `workflow_dispatch` 只在 channel 判定步骤读取原始 input，并将同步事件和通知路由写入 runner 临时文件；后续同步、通知和部署派发只传 `SYNC_DISPATCH_EVENT_PATH`，不得重新注入 `SYNC_DISPATCH_PAYLOAD`。
- 完整同步结果只写 runner 临时 result file 供 summary/通知使用；stdout 使用脱敏 safe report。
- `monitor.*` 保存 GitHub run/job/step/failure 结构化数据，不保存业务 payload。

## 状态合同

| 字段 | 含义 |
| --- | --- |
| `taskStatus` | 归一化任务状态，例如 succeeded、auto_retry、manual_intervention、skipped。 |
| `failureDisposition` | 失败应自动重试、人工处理还是忽略。 |
| `aiCallLogStatus` | AI 调用审计状态。 |
| `recognitionAttemptKinds` | strict schema、json object、text JSON、fallback provider 等尝试类型。 |
| `syncStages` | resolve、recognition、persist、notify 等同步阶段。 |
| `dateConfidence` / `dateStages` | 日期可信度和批次日期决策过程。 |
| `partialFailure` | 主业务写入已完成，但识别或睡眠回填等后续阶段不完整；必须结合 warnings 继续处理。 |
| `completenessStatus` / `reconciliationStatus` | 图片识别业务完整性与主备合并结论；`reconciliationStatus=conflict` 或 `failureCategory=business_incomplete` 时 `failureDisposition=manual_intervention`，该批次 `core.*` 零写入。 |

## 安全数据库修复与维护命令

| 命令 | 作用 |
| --- | --- |
| `npm run maintenance:inspect` | 只读巡检 pending、AI monitoring、恢复目标和 DB 权限。 |
| `npm run maintenance:inspect -- --batch-id <batchId>` | 审计单个批次和 `recoveryTargetDays`。 |
| `npm run sync:db` | 默认安全数据库修复入口。 |
| `node tools/training-maintenance.mjs sync --phase all` | 显式运行全部维护 phase。 |
| `node tools/training-maintenance.mjs sync --phase markdown --dry-run` | 只读预览 Markdown 导入影响。 |
| `npm run import:markdown` | 显式执行 Markdown -> core 同步。 |
| `npm run export:markdown` | PostgreSQL -> Markdown 备份。 |
| `npm run reconcile:markdown` | Markdown 与数据库对账/同步。 |
| `npm run backfill:core` | archive -> core 回填。 |
| `npm run backfill:thoughts` | 随想 Markdown -> core 回填。 |

pending 恢复只有 PostgreSQL `ingest.pending_task` 一条路径。巡检重点看 `pendingDatabaseOldestAgeMinutes`、`pendingDatabaseMaxAttemptCount`、`pendingDatabaseAlertLevel`；AI monitoring 重点看 `aiMonitoringFallbackRate`、`aiMonitoringSchemaFailureCount`、`aiMonitoringAvgRecognitionLatencyMs`、`aiMonitoringTotalCostUsd`。

## 日常排查入口

| 入口 | 用途 |
| --- | --- |
| GitHub sync run summary | 判断业务是否 stored、pending、partial 或 skipped。 |
| 独立 deploy run | 判断页面构建、发布和 thought 精确校验是否成功。 |
| `/action-monitor/` | 查看分支内 Action 历史和 job/step 失败。 |
| `npm run maintenance:inspect` | 只读巡检 pending、AI monitoring、单批次恢复目标和 DB 权限。 |
| `npm run maintenance:inspect -- --batch-id <batchId>` | 审计指定 batch 的识别、core 目标和恢复日期。 |

## 接手演练题卡

1. 画出 `Telegram/飞书 -> Worker -> Queue -> Action -> AI -> DB -> Pages`，指出 sync、deploy、monitor、pending 的生命周期边界。
2. 解释 `Action success` 不等于业务 stored：`auto_retry`、`manual_intervention`、`skipped` 和 partial failure 都需要继续判断。
3. 说明 `core.*`、`ingest.*`、`archive.*` 与 `训练记录.md` 的事实源和备份边界。
4. 给出恢复优先级：先修复外部依赖或数据库，再检查 pending/dead-letter，最后重跑并核对幂等状态。
5. 给出人工验收：先看 summary 和 `maintenance:inspect`，再核对 `recoveryTargetDays` 对应数据库/页面，最后确认独立 deploy run。
