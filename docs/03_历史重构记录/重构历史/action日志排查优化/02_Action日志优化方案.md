# Action 日志优化方案

## 目标

在不改变业务逻辑、数据库结构、Prompt、AI 识别规则和接口行为的前提下，统一 GitHub Actions 与运行脚本日志，让维护人员可以通过 Action 日志快速回答：

1. 哪个外部消息触发了本次 run。
2. 哪个 workflow/job/step/code path 执行了。
3. AI 是否调用、是否 retry/fallback、最终是否成功。
4. DB 是否写入、是否 unchanged、是否 pending。
5. Markdown 是否生成、部署是否完成。
6. warning/error/retry/timeout 是否需要人工处理。

## 源码级约束

以下约束来自二次复核后的当前代码状态：

- ⚠️ **第三轮修正**：生产 main 仍把完整 dispatch payload 写入 `$GITHUB_ENV` 并重复打印（dev 已修复未合并）。原"当前 workflow 没有直接 echo 原始 dispatch payload"的表述仅在 dev 成立。
- 当前没有全链路 `traceId`，只有 `queue_task_id`、batch/task id、`aiCallId` 等局部关联键。
- 当前 `export:markdown` 会输出包含完整 `snapshot` 的 pretty JSON，这是已验证的 Action 日志污染点（⚠️ 范围含 backup + 两个 deploy）。
- 当前 AI prompt 全文不进入日志；DB 里记录的是 `prompt_version` 和 token usage 字段。
- 当前 DB 没有慢查询日志机制，也没有 row count / transaction id summary。

## 总体原则

1. stdout 面向机器和 summary，stderr 只保留 warning/error/retry。
2. Action step log 只输出必要事件和 compact summary。
3. 健康明细、用户原文、file id、image key、chat id、COS key 默认 hash 或截断。
4. 每条关键日志都带同一套 trace 上下文。
5. 同步、AI、DB、Markdown、Deploy 使用同一字段名。

## 统一日志格式

建议新增轻量日志工具，例如 `tools/lib/action-logger.mjs`，供 workflow 调用脚本和 Node use case 复用。格式为一行 JSON，外层可带稳定前缀，方便 `rg` 和 GitHub UI 搜索。

```json
{
  "ts": "2026-06-28T01:26:39.504Z",
  "level": "INFO",
  "domain": "AI",
  "event": "recognition.completed",
  "traceId": "tr_8dbfe3e65db19d85",
  "queueTaskId": "telegram:520905856:telegram_update:8dbfe3e65db19d85",
  "workflow": "Sync (Main)",
  "runId": "1234567890",
  "job": "sync",
  "step": "Sync updates",
  "channel": "telegram",
  "batchId": "single-727",
  "durationMs": 12437,
  "outcome": "succeeded"
}
```

## 日志级别

| Level | 用途 | Action 行为 |
| --- | --- | --- |
| `DEBUG` | 本地或临时排障，默认不在 Actions 输出 | 仅 `ACTIONS_STEP_DEBUG` 或显式开关输出 |
| `INFO` | 关键阶段开始/结束、摘要 | 默认输出 |
| `WARN` | 可恢复异常、业务未完成、重试、降级 | 输出并写 GitHub warning annotation |
| `ERROR` | 当前 step 或业务不可继续 | 输出并写 GitHub error annotation |

当前源码没有统一 level：`process.stderr.write`、`console.log`、GitHub annotation、Worker prefix 混用。因此本表是目标规范，不是现状描述。

## domain 分类

| Domain | 范围 |
| --- | --- |
| `WORKER` | Cloudflare webhook、鉴权、buffer |
| `QUEUE` | SyncDispatchQueue enqueue、dispatch、run lookup、dead-letter |
| `ACTION` | workflow/job/step 生命周期 |
| `MESSAGE` | batch/message 分组、来源通道、图片数量 |
| `AI` | provider、model、prompt version、retry、fallback、usage |
| `DATABASE` | schema preflight、事务、upsert、pending、rollback、slow query |
| `MARKDOWN` | DB -> Markdown 导出、posts/images 产物摘要 |
| `DEPLOY` | Pages/Cloudflare Pages dispatch、build、verify |
| `NOTIFY` | Telegram/飞书回执 |
| `SECURITY` | 脱敏、配置隔离、payload 安全摘要 |

## Trace ID 方案

### 现状

`SyncDispatchQueue` 已生成稳定 task id，见 `cloudflare/sync-dispatch-queue.mjs:451-459`，并放入 workflow input，见 `cloudflare/sync-dispatch-queue.mjs:470-485`。workflow run name 包含 `queue_task_id`，见 `.github/workflows/sync.yml:2`、`.github/workflows/sync-dev.yml:2`。

### 建议

新增 `traceId`，由 `queue_task_id` 派生：

```text
traceId = "tr_" + sha256(queue_task_id).slice(0, 16)
```

保留 `queueTaskId` 用于 summary 或必要排障，普通日志优先显示 `traceId`。从 Worker 到 GitHub Actions、AI call log、DB pending、Markdown deploy summary 全部传递。

### 字段要求

| 字段 | 必填范围 | 说明 |
| --- | --- | --- |
| `traceId` | 全链路 | 安全追踪 ID |
| `queueTaskId` | sync/deploy summary | 可选，必要时显示 |
| `workflow` / `runId` | Actions | 来自 GitHub env |
| `channel` | 消息同步 | `telegram` / `feishu` |
| `batchId` | batch 级 | 同步结果主索引 |
| `sourceMessageHash` | message 级 | 不打印原始 message id 时使用 |
| `sourceChatHash` | message 级 | 不打印原始 chat id |
| `attempt` / `maxAttempts` | retry | 所有 retry 统一 |
| `durationMs` | stage 结束 | 所有关键阶段 |
| `outcome` | stage 结束 | `succeeded` / `failed` / `skipped` / `deferred` |

## 删除或降噪建议

### P0：Markdown 导出只输出 compact summary

代码依据：

- `tools/export-training-markdown.mjs:47-51` 返回 `snapshot`。
- `tools/training-maintenance.mjs:87` 将 payload pretty JSON 写入 stdout。
- `.github/actions/site-build/action.yml:109-121`、`.github/workflows/markdown-backup.yml:82-84` 在 Action 中执行 `npm run export:markdown`。

替代输出：

```json
{
  "status": "stored",
  "mode": "export",
  "target": "markdown",
  "outputPath": "训练记录.md",
  "dailyCount": 123,
  "thoughtExportedCount": 4,
  "thoughtRemovedCount": 4,
  "durationMs": 3210
}
```

实施方式：

1. `runExportMaintenance()` 默认返回 compact summary，不把 `snapshot` 放入 stdout payload。
2. 如需完整 payload，增加显式本地参数 `--debug-json`。
3. GitHub Actions 环境中禁止 `--debug-json`。

### P1：dispatch payload 防回归约束

⚠️ **第三轮修正**：原文"当前 workflow 已经只把临时 event 文件路径写入 `$GITHUB_ENV`，不直接输出原始 payload"——**该前提仅在 dev 成立**。生产 main 仍写 `SYNC_DISPATCH_PAYLOAD` 原文到 `$GITHUB_ENV`（实测 Sync Main #112 日志可见）。因此本项不是"删除已存在日志"，而是**先合并 dev 修复到 main（见 05 P0-0），再防止后续改动回退**。

约束：

1. 保持 workflow_dispatch input 接收 `dispatch_payload`。
2. `Determine sync channel` 只写临时 event 文件路径。
3. 跨 step 只传 `SYNC_DISPATCH_EVENT_PATH`、`channel`、`queue_task_id`、`payload_hash`。
4. 不新增 `echo "$dispatch_payload"`、不写 `DISPATCH_PAYLOAD` / `SYNC_DISPATCH_PAYLOAD` 原文到 `$GITHUB_ENV`。
5. 安全摘要只包含 channel、messageCount、imageCount、payloadHash。

### P1：deploy 等待降噪与可观测

代码依据：`sync.yml:570-624`、`sync-dev.yml:556-610` 先查找 deploy run，再轮询完成，中间没有周期性状态输出。

建议每 3 到 6 次输出一次状态：

```json
{"domain":"DEPLOY","event":"workflow.waiting","deployRunId":"1234567891","attempt":6,"status":"in_progress","elapsedMs":60000}
```

超时时输出最后状态、deploy URL、GitHub API status。

### P2：CI 模拟日志前缀

测试中的模拟 `failed/retrying/timeout` 应加测试前缀，例如：

```text
[test-fixture][telegram-sync] primary AI recognition failed...
```

或者在测试中捕获 stderr，只在失败时输出。

## 新增日志建议

### 1. Action 生命周期

在 sync workflow 开始和结束输出：

```json
{"level":"INFO","domain":"ACTION","event":"sync.started","workflow":"Sync (Main)","runId":"...","channel":"telegram","traceId":"..."}
{"level":"INFO","domain":"ACTION","event":"sync.completed","outcome":"succeeded","durationMs":86200,"businessOutcome":"stored"}
```

### 2. 消息链路

Worker / Queue / Action 统一输出：

| 事件 | 字段 |
| --- | --- |
| `worker.webhook.accepted` | channel、traceId、messageCount、imageCount |
| `queue.task.enqueued` | queueTaskId、traceId、sortKey、payloadHash |
| `queue.workflow.dispatched` | workflowFile、ref、queueTaskId |
| `queue.workflow.completed` | runId、conclusion |
| `message.batch.grouped` | batchId、kind、imageCount、messageCount |

### 3. AI 调用

不得记录 Prompt 全文、图片 data URL、API Key、用户原文。只记录安全摘要：

| 字段 | 说明 |
| --- | --- |
| `provider` | `openai-compatible` 等实际 provider |
| `model` | 实际模型名 |
| `promptVersion` | prompt metadata version |
| `schemaName` / `schemaVersion` | 识别 schema |
| `attemptKind` | `normal` / `strict_json_retry` / `fallback` / `primary` |
| `retryCount` | HTTP retry 次数 |
| `fallbackUsed` | boolean |
| `durationMs` | AI 调用耗时 |
| `status` | `succeeded` / `failed` |
| `httpStatus` | 非 2xx 时 |
| `tokenUsage` | prompt/completion/total，如 provider 返回 |

建议在 batch summary 增加：

```json
"ai": {
  "provider": "openai-compatible",
  "model": "...",
  "promptVersion": "...",
  "attemptKinds": ["normal"],
  "fallbackUsed": false,
  "retryCount": 0,
  "durationMs": 12437,
  "totalTokens": 1234
}
```

### 4. 数据库写入

不得记录 SQL 参数、数据库 URL、用户原文。只记录阶段和行数：

```json
{
  "level": "INFO",
  "domain": "DATABASE",
  "event": "batch.persist.completed",
  "traceId": "tr_...",
  "batchId": "single-727",
  "transactionId": "dbtx_...",
  "sourceChannel": "telegram",
  "status": "stored",
  "rowCounts": {
    "ingestBatch": 1,
    "ingestMessage": 1,
    "ingestRecognition": 1,
    "coreMeasurement": 1,
    "coreActivity": 0,
    "coreMeal": 0,
    "coreSleep": 0
  },
  "durationMs": 3822
}
```

失败时输出：

```json
{
  "level": "ERROR",
  "domain": "DATABASE",
  "event": "batch.persist.failed",
  "batchId": "...",
  "transactionId": "...",
  "errorCategory": "database",
  "errorCode": "CONNECTION_TIMEOUT",
  "rollbackStatus": "succeeded",
  "pendingStatus": "queued"
}
```

### 5. DB 慢查询

当前没有慢查询日志。建议在 DB adapter 层包一层最小 query helper：

```json
{"level":"WARN","domain":"DATABASE","event":"query.slow","operation":"persist.batch","durationMs":1500,"thresholdMs":1000}
```

不打印 SQL 参数，不打印 DB URL。

### 6. Markdown 导出

新增 `MARKDOWN` domain：

```json
{
  "level": "INFO",
  "domain": "MARKDOWN",
  "event": "export.completed",
  "snapshotSource": "database",
  "outputPath": "训练记录.md",
  "dailyCount": 123,
  "thoughtExportedCount": 4,
  "thoughtRemovedCount": 4,
  "bytes": 456789,
  "durationMs": 2100
}
```

## Summary 标准

GitHub Step Summary 应是人读的最终索引，不替代完整日志。

同步 summary 建议固定为：

1. `Run context`: workflow、runId、traceId、queueTaskId、channel、source summary。
2. `Business result`: batchId、taskStatus、persistenceStatus、failureDisposition。
3. `AI`: provider、model、promptVersion、fallbackUsed、retryCount、durationMs、tokens。
4. `Database`: status、transactionId、row counts、pending。
5. `Markdown / Deploy`: exported、deploy workflow、deploy runId、url。
6. `Warnings`: only actionable warnings。

## 安全脱敏规则

| 字段 | 处理 |
| --- | --- |
| API key / token / secret | 禁止输出 |
| DB URL | 禁止输出 |
| Prompt 全文 | 禁止输出 |
| 用户正文 / caption | 默认禁止输出 |
| Telegram file_id / file_unique_id | hash 或不输出 |
| Feishu image_key | hash 或不输出 |
| chat_id / user_id | hash 或末 4 位 |
| ⚠️ 飞书 `oc_` chat id（出现在 sync stdout 的 batchId/sourceId/chatIds） | hash 或截断，实测 Sync Dev #117 日志第 343/346/351 行明文 `oc_47126c2d831c7a201c30c801ad77ef71` |
| message_id | 可输出，必要时 hash |
| 健康明细 | 禁止进入 Action 日志 |
| COS secret | 禁止输出 |
| COS bucket/domain/pathPrefix/key | 默认 hash 或仅输出 host |

## 推荐落地方式

1. 先修 `export:markdown` compact summary。
2. 新增日志工具，不在 workflow inline JS 中复制日志格式逻辑。
3. 把 `.github/workflows/sync.yml` 和 `sync-dev.yml` 的 summary 生成抽到 `tools/action-sync-summary.mjs`。
4. 给 AI 和 DB use case 增加安全 summary 字段，不改变现有业务返回语义。
5. 给 deploy wait 和 DB query 增加最小观测。
6. 最后清理 CI/deploy 噪声。
