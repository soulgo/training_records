# Action 日志与失败补偿

## 当前实现范围

Action 日志现在由 workflow、同步结果文件、统一 summary 脚本和少量结构化事件共同组成。当前事实如下：

- `sync.yml` / `sync-dev.yml` 在 `workflow_dispatch` 场景把 `dispatch_payload` 转写到 runner 临时文件，并只通过 `SYNC_DISPATCH_EVENT_PATH` 跨 step 传递事件文件路径；不再把原始 `DISPATCH_PAYLOAD` / `SYNC_DISPATCH_PAYLOAD` 写入 `$GITHUB_ENV`。
- `tools/lib/action-logger.mjs` 生成 `[action-log]` 单行 JSON。事件字段会统一归一化，敏感 key 默认 hash 或丢弃。
- `tools/action-sync-summary.mjs` 是 Telegram / 飞书 sync summary 的统一入口。`sync.yml` 与 `sync-dev.yml` 都调用它写入 `GITHUB_STEP_SUMMARY`。
- `traceId` 由 `queueTaskId` 派生，格式为 `tr_<sha256前16位>`；workflow 没有队列任务时使用 `GITHUB_RUN_ID` 作为兜底 seed。
- Telegram / 飞书 sync CLI stdout 默认只输出 safe report；完整 report 只写入 `TELEGRAM_SYNC_RESULT_PATH` / `FEISHU_SYNC_RESULT_PATH`，供 summary 和 notify step 读取。
- `npm run export:markdown` 默认只输出 compact summary；完整导出 payload 只允许本地显式 `--debug-json`，GitHub Actions 中会拒绝该参数。
- DB 写入结果会带 `persistenceResult`，其中只保留安全字段：`transactionId`、`sourceChannel`、`rowCounts`、`durationMs`、`slowQueries`、`pendingStatus`、`rollbackStatus` 等。
- `sleepBackfill` 的同步链路回填只针对本轮写入的睡眠归档日期；全量回填只能走显式维护入口。
- Deploy 等待阶段会周期性输出 `[action-log]`，并在 step summary 中记录 deploy 状态、耗时和 URL。

## GitHub Actions summary

`sync.yml` / `sync-dev.yml` 在 webhook dispatch 场景会把同步结果写入 `GITHUB_STEP_SUMMARY`。

| Summary | 生成方式 |
| --- | --- |
| Run context | `tools/action-sync-summary.mjs` 输出 `workflow`、`runId`、`traceId`、`queueTaskId`、`channel` |
| Telegram sync result | `Write Telegram sync summary` step 调用 `tools/action-sync-summary.mjs --channel telegram` |
| Feishu sync result | `Write Feishu sync summary` step 调用 `tools/action-sync-summary.mjs --channel feishu` |
| AI | summary 聚合 provider、model、promptVersion、fallback/retry、duration 和 token totals |
| Database | summary 聚合 `persistenceResult` 中的 status、transactionId、rowCounts、pending/rollback、duration 和 slow query 数量 |
| Image storage | summary 聚合 `batch.imageUploadStats`，bucket/pathPrefix 以 hash 展示 |
| Site deploy result | 同步 workflow 的 `Trigger and wait for site deploy` step |

## 关键状态字段

| 字段 | 来源 | 含义 |
| --- | --- | --- |
| `traceId` | `tools/lib/action-logger.mjs` / workflow summary | 安全追踪 ID，优先由 `queueTaskId` 派生。 |
| `queueTaskId` | Worker / Queue / workflow input | 队列任务 ID，用于关联 Worker、workflow run 和 batch。 |
| `taskStatus` | `buildMessageSyncTasks` | 任务级状态。 |
| `persistenceStatus` | `persistNormalizedBatch` 结果 | `stored`、`unchanged`、`pending_replay`、`manual_intervention` 等。 |
| `persistenceResult.status` | `src/db/training/write.mjs` | DB 写入阶段状态。 |
| `persistenceResult.transactionId` | `persistNormalizedBatch` | 单次写入事务摘要 ID，格式为 `dbtx_<hex>`，不是数据库内部事务号。 |
| `persistenceResult.rowCounts` | `createObservedClient()` | 按白名单表聚合的影响行数。 |
| `persistenceResult.slowQueries` | `createObservedClient()` | 超过 `TRAINING_DB_SLOW_QUERY_MS` 的慢查询摘要，只含 operation/table/duration/threshold。 |
| `persistenceResult.pendingStatus` | pending replay 处理 | DB 失败后是否已进入 pending。 |
| `persistenceResult.rollbackStatus` | DB catch 分支 | rollback 是否 `succeeded`、`failed`、`not_needed` 等。 |
| `failureCategory` | `classifyFailureCategory` | AI、Telegram API、database、user_input 等失败分类。 |
| `failureDisposition` | summary 计算 | `auto_retry`、`manual_intervention`、`skip` 等处置。 |
| `recognitionAttemptKinds` | 图片识别流程 | `normal`、`fallback`、`strict_json_retry` 等。 |
| `aiCallLogStatus` | AI call log 写入 | AI 审计日志状态。 |
| `ai.provider` / `ai.model` | 图片识别结果 summary | 本次识别使用的 provider 和模型。 |
| `ai.promptVersion` | Prompt metadata | 使用的 Prompt 版本。 |
| `ai.fallbackUsed` / `ai.retryCount` | AI provider / fallback 逻辑 | 是否发生 fallback 和 HTTP retry 次数。 |
| `ai.totalTokens` | provider usage | provider 返回 token usage 时的总 token 数。 |

## 日志安全规则

当前日志只允许写入可排障的安全摘要：

| 类别 | 当前规则 |
| --- | --- |
| 原始 dispatch payload | 只落到 runner 临时 event 文件；跨 step 只传 `SYNC_DISPATCH_EVENT_PATH`。 |
| 文件、图片、聊天和来源 ID | `file_id`、`file_unique_id`、`image_key`、`chat_id`、`chatIds`、`sourceId`、飞书 `oc_` 默认 hash 或不输出。 |
| COS 信息 | `bucket`、`pathPrefix`、`object key` 默认 hash 或不输出完整值。 |
| Prompt / 用户文本 / SQL | `prompt`、`caption`、`text`、`body`、`sql`、`params` 在 action logger 中丢弃。 |
| Markdown 导出 | stdout 默认只输出 `status`、`mode`、`target`、`outputPath`、daily/thought 计数和 `durationMs`。 |
| 同步 CLI stdout | 默认只输出 safe report；完整 sync report 只写 result file，不直接 tee 到 Action log。 |
| Secret | 不允许输出 API Key、DB URL、token、password。 |

## 失败补偿

| 失败点 | 代码位置 | 处理 |
| --- | --- | --- |
| AI 识别失败 | `src/app/use-cases/telegram-sync/image-processing.mjs` | 可重试失败进入 pending recognition。 |
| DB 写入失败 | `src/app/use-cases/telegram-sync.use-case.mjs` 写库 catch 分支 | 写入 pending，返回 `pending_replay`。 |
| DB rollback | `src/db/training/write.mjs` | `persistenceResult.rollbackStatus` 记录 rollback 结果；rollback 失败写 stderr。 |
| 用户输入问题 | `classifyFailureCategory(..., { phase })` 后为 `user_input` | 返回 `manual_intervention`，不自动重放。 |
| AI call log 写入失败 | `src/db/training/write.mjs:91-99` | stderr 记录，不回滚主业务事务。 |
| Telegram 通知失败 | workflow `continue-on-error: true` 的通知 step | 不阻断已成功的同步结果。 |

## 通知脚本

| 脚本 | 触发位置 | 作用 |
| --- | --- | --- |
| `tools/telegram-sync-notify.mjs` | sync workflow 成功后 | 向 Telegram 回发同步结果。 |
| `tools/feishu-sync-notify.mjs` | sync workflow 成功后 | 向飞书回发同步结果。 |
| `tools/telegram-action-monitor.mjs` | sync workflow 失败后 | 汇总失败步骤并通知 Telegram。 |
| `tools/feishu-action-monitor.mjs` | sync workflow 失败后 | 汇总失败步骤并通知飞书。 |

## 日常维护

维护入口必须优先使用只读巡检和显式阶段命令，避免把旧 Markdown 当作事实源覆盖数据库。

| 命令 | 说明 |
| --- | --- |
| `npm run maintenance:inspect` | 只读巡检 pending 队列、归档失败、AI monitoring 来源和 DB 账号权限摘要。 |
| `npm run maintenance:inspect -- --batch-id <batchId>` | 只读审计单个批次的识别 JSON、core 目标和 `recoveryTargetDays`。 |
| `npm run maintenance:sync` | 显式运行维护同步入口。 |
| `npm run maintenance:migrate` | 迁移入口，写入前必须 dry-run 或显式 confirm。 |
| `npm run sync:db` | 安全数据库修复入口。 |
| `npm run import:markdown` | 显式 Markdown 导入数据库。 |
| `npm run export:markdown` | 数据库导出 Markdown 备份，stdout 默认只输出 compact summary。 |
| `npm run export:markdown -- --debug-json` | 本地调试时输出完整导出 payload；GitHub Actions 中禁用。 |
| `npm run reconcile:markdown` | 显式 Markdown 与数据库对账。 |
| `npm run backfill:core` | 重放 archive 到 core。 |
| `npm run backfill:thoughts` | 随想 Markdown 回填 core。 |

安全数据库修复：`sync:db` 内部按维护阶段执行，可显式使用 `--phase archive`、`--phase ingest`、`--phase markdown`、`--phase thoughts` 或 `--phase all`。Markdown 导入属于 legacy 修复阶段，生产写入前先 dry-run 并核对 affected days。

pending 队列巡检重点看 `pendingDatabaseOldestAgeMinutes`、`pendingDatabaseMaxAttemptCount`、`pendingDatabaseAlertLevel` 和 `pendingDatabaseAlertReasons`。AI monitoring 重点看 `aiMonitoringFallbackRate`、`aiMonitoringSchemaFailureCount`、`aiMonitoringAvgRecognitionLatencyMs`、`aiMonitoringTotalCostUsd`，来源是 `ingest.ai_call_log` 和 `ingest.telegram_recognition.recognition_json.aiAttemptKind`。DB 权限巡检重点看 `database.permissionAudit.isSuperuser`、`database.permissionAudit.isMigratorLikeUser`、`database.permissionAudit.schemaCreatePrivileges` 和 `database.permissionAudit.dangerousPrivilegeReasons`；这些字段只来自只读权限查询，不会输出 DB URL 或 Secret。

配置 `TRAINING_DB_READONLY_URL` 后，`maintenance:inspect` 的 pending summary、AI monitoring、单批次审计和 DB 权限巡检优先使用只读连接；未配置时才回退 `TRAINING_DB_URL`。

旧 NDJSON pending 已从同步主链路下线。需要先运行 `node tools/telegram-sync-fallback.mjs inspect` 确认历史文件为空或仅作归档，不再通过 `sync:telegram` 重放；恢复统一走数据库 pending 队列。

Markdown backup workflow 的告警值包括 `changed_without_commit` 和 `workflow_failed_before_alert_evaluation`。出现 `changed_without_commit` 时先确认是否应由 `npm run export:markdown` 在目标分支提交，不能手工改派生备份来绕过数据库事实源。

## 内部接口索引

| 接口 | 说明 |
| --- | --- |
| `tools/lib/action-logger.mjs` | `[action-log]` 单行 JSON logger，负责 trace context、字段归一化和敏感字段处理。 |
| `tools/action-sync-summary.mjs` | Telegram / 飞书同步 summary 的统一 formatter。 |
| `tools/training-maintenance.mjs sync --phase markdown` | Markdown 导入数据库阶段，对应 `import:markdown` 和 `reconcile:markdown`。 |
| `tools/training-maintenance.mjs sync --phase all` | 显式运行全部维护阶段。 |
| `tools/training-maintenance.mjs export markdown` | 数据库导出 Markdown 备份，对应 `export:markdown`，默认 compact summary。 |
| `TRAINING_DB_SLOW_QUERY_MS` | DB 慢查询摘要阈值，默认 1000ms；只记录 operation/table/duration/threshold。 |
| `aiCallLogStatus` | sync summary 中 AI 审计日志写入状态。 |
| `recognitionAttemptKinds` | 图片识别尝试类型，包括 normal、fallback、strict_json_retry。 |
| `persistenceResult` | DB 写入安全摘要，用于 summary 和失败排查。 |
| `syncStages` | 同步阶段状态集合，用于定位 Action 成功但业务未完成。 |
| `dateConfidence` | 日期归档可信度。 |
| `dateStages` | 日期推断阶段集合。 |

## 接手演练题卡

1. 画出 Telegram/飞书 -> Worker -> Queue -> Action -> AI -> DB -> Pages 的全链路，并指出哪些日志在 Worker、GitHub Actions、PostgreSQL 和 Pages。
2. 解释 `Action success` 不等于业务 stored：summary 中 `pending_replay`、`auto_retry`、`manual_intervention`、`skipped` 和 `partialFailure` 都需要继续判断业务状态。
3. 说明 `core.*`、`ingest.*`、`archive.*` 和 `训练记录.md` 的恢复优先级：优先保护 `core.*`，用 `ingest.*` 追溯消息和识别，用 `archive.*` 与 Markdown 作为恢复材料。
4. 给出人工验收步骤：先 `maintenance:inspect`，再按 `recoveryTargetDays` 核对目标日期，最后确认页面或数据库结果。
