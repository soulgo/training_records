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
