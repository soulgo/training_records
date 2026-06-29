# Action 日志与失败补偿

## GitHub Actions summary

`sync.yml` / `sync-dev.yml` 在 webhook dispatch 场景会把同步结果写入 `GITHUB_STEP_SUMMARY`。

| Summary | workflow 代码 |
| --- | --- |
| Telegram sync result | `.github/workflows/sync.yml`、`.github/workflows/sync-dev.yml` 的 `Write Telegram sync summary` step |
| Feishu sync result | `.github/workflows/sync.yml`、`.github/workflows/sync-dev.yml` 的 `Write Feishu sync summary` step |
| Image storage | 同步 summary 中聚合 `batch.imageUploadStats` |
| Site deploy result | 同步 workflow 的 `Trigger and wait for site deploy` step |

## 关键状态字段

| 字段 | 来源 | 含义 |
| --- | --- | --- |
| `taskStatus` | `buildMessageSyncTasks` | 任务级状态。 |
| `persistenceStatus` | `persistNormalizedBatch` 结果 | `stored`、`unchanged`、`pending_replay`、`manual_intervention` 等。 |
| `failureCategory` | `classifyFailureCategory` | AI、Telegram API、database、user_input 等失败分类。 |
| `failureDisposition` | summary 计算 | `auto_retry`、`manual_intervention`、`skip` 等处置。 |
| `recognitionAttemptKinds` | 图片识别流程 | `normal`、`fallback`、`strict_json_retry` 等。 |
| `aiCallLogStatus` | AI call log 写入 | AI 审计日志状态。 |

## 失败补偿

| 失败点 | 代码位置 | 处理 |
| --- | --- | --- |
| AI 识别失败 | `src/app/use-cases/telegram-sync/image-processing.mjs` | 可重试失败进入 pending recognition。 |
| DB 写入失败 | `src/app/use-cases/telegram-sync.use-case.mjs` 写库 catch 分支 | 写入 pending，返回 `pending_replay`。 |
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
| `npm run maintenance:inspect` | 只读巡检 pending 队列、归档失败和 AI monitoring 来源。 |
| `npm run maintenance:inspect -- --batch-id <batchId>` | 只读审计单个批次的识别 JSON、core 目标和 `recoveryTargetDays`。 |
| `npm run maintenance:sync` | 显式运行维护同步入口。 |
| `npm run maintenance:migrate` | 迁移入口，写入前必须 dry-run 或显式 confirm。 |
| `npm run sync:db` | 安全数据库修复入口。 |
| `npm run import:markdown` | 显式 Markdown 导入数据库。 |
| `npm run export:markdown` | 数据库导出 Markdown 备份。 |
| `npm run reconcile:markdown` | 显式 Markdown 与数据库对账。 |
| `npm run backfill:core` | 重放 archive 到 core。 |
| `npm run backfill:thoughts` | 随想 Markdown 回填 core。 |

安全数据库修复：`sync:db` 内部按维护阶段执行，可显式使用 `--phase archive`、`--phase ingest`、`--phase markdown`、`--phase thoughts` 或 `--phase all`。Markdown 导入属于 legacy 修复阶段，生产写入前先 dry-run 并核对 affected days。

pending 队列巡检重点看 `pendingDatabaseOldestAgeMinutes`、`pendingDatabaseMaxAttemptCount`、`pendingDatabaseAlertLevel` 和 `pendingDatabaseAlertReasons`。AI monitoring 重点看 `aiMonitoringFallbackRate`、`aiMonitoringSchemaFailureCount`、`aiMonitoringAvgRecognitionLatencyMs`、`aiMonitoringTotalCostUsd`，来源是 `ingest.ai_call_log` 和 `ingest.telegram_recognition.recognition_json.aiAttemptKind`。

旧 NDJSON pending 只在兼容恢复时使用。需要先运行 `node tools/telegram-sync-fallback.mjs inspect`，确认后才允许 `TELEGRAM_SYNC_REPLAY_LEGACY_NDJSON_PENDING=true npm run sync:telegram`。重放前备份文件名使用 `telegram-sync-pending.ndjson.backup-<UTC timestamp>`。

Markdown backup workflow 的告警值包括 `changed_without_commit` 和 `workflow_failed_before_alert_evaluation`。出现 `changed_without_commit` 时先确认是否应由 `npm run export:markdown` 在目标分支提交，不能手工改派生备份来绕过数据库事实源。

## 内部接口索引

| 接口 | 说明 |
| --- | --- |
| `tools/training-maintenance.mjs sync --phase markdown` | Markdown 导入数据库阶段，对应 `import:markdown` 和 `reconcile:markdown`。 |
| `tools/training-maintenance.mjs sync --phase all` | 显式运行全部维护阶段。 |
| `tools/training-maintenance.mjs export markdown` | 数据库导出 Markdown 备份，对应 `export:markdown`。 |
| `aiCallLogStatus` | sync summary 中 AI 审计日志写入状态。 |
| `recognitionAttemptKinds` | 图片识别尝试类型，包括 normal、fallback、strict_json_retry。 |
| `syncStages` | 同步阶段状态集合，用于定位 Action 成功但业务未完成。 |
| `dateConfidence` | 日期归档可信度。 |
| `dateStages` | 日期推断阶段集合。 |

## 接手演练题卡

1. 画出 Telegram/飞书 -> Worker -> Queue -> Action -> AI -> DB -> Pages 的全链路，并指出哪些日志在 Worker、GitHub Actions、PostgreSQL 和 Pages。
2. 解释 `Action success` 不等于业务 stored：summary 中 `pending_replay`、`auto_retry`、`manual_intervention`、`skipped` 和 `partialFailure` 都需要继续判断业务状态。
3. 说明 `core.*`、`ingest.*`、`archive.*` 和 `训练记录.md` 的恢复优先级：优先保护 `core.*`，用 `ingest.*` 追溯消息和识别，用 `archive.*` 与 Markdown 作为恢复材料。
4. 给出人工验收步骤：先 `maintenance:inspect`，再按 `recoveryTargetDays` 核对目标日期，最后确认页面或数据库结果。
