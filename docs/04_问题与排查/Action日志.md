# Action 日志

## 现象

- GitHub Actions 结论为 success，但业务未完成。
- summary 中出现 `business incomplete` warning。
- 部署 workflow 未被找到或超时。
- `[action-log]` 中出现 `WARN` / `ERROR`。
- AI 或 DB summary 显示 fallback、retry、pending、rollback 或 slow query。
- `npm run export:markdown -- --debug-json` 在 GitHub Actions 中失败。
- `/action-monitor/` 页面为空、缺少最新 run，或某次 run 长时间显示为运行中。
- `Report Action Status` step 输出 `GitHub Action monitor report URL is not configured and branch-scoped PostgreSQL URL is unavailable; skipping.`。
- `Report Action Status` step 输出 `[github-action-monitor] local report failed`。
- `/action-monitor/` 页面有 run，但缺少 job / step / failure 计数或失败摘要。

## 原因

- 同步 step 成功执行，但某些 batch 为 `pending_replay`、`manual_intervention` 或 `partialFailure`。
- DB-only 变化触发了部署，但部署 workflow 查询超时。
- 通知 step 设置 `continue-on-error`，通知失败不会改变主同步结果。
- `tools/action-sync-summary.mjs` 未读到 result file 时会写 summary missing result，但 workflow 仍继续执行后续失败通知逻辑。
- DB 写入失败时会携带 `persistenceResult` 安全摘要；可恢复失败会进入 pending replay。
- `export:markdown` 的完整 payload 只允许本地 `--debug-json`，GitHub Actions 中会拒绝，避免训练 snapshot 进入日志。
- Action 监控本地 reporter 需要分支对应 `TRAINING_DB_URL` 和 `GITHUB_TOKEN`；缺任一项会跳过或失败。
- `monitor.github_action_runs/jobs/steps/failures` 未建表或 schema 旧，会导致本地 reporter 写库失败；代码仅兼容缺少 `monitor_environment` 列的旧表。
- 外部 report URL 只作为兜底；如果没有 DB URL 且没有 `GITHUB_ACTION_MONITOR_REPORT_URL*`，本次 run 不会落库。
- 当前 run 的最终 step 执行时，GitHub API 可能仍返回 `in_progress`；本地 reporter 用 `${{ job.status }}` 兜底，外部 HTTP reporter 没有这个兜底时可能短暂显示运行中。
- 站点构建读取 `/action-monitor/` 时优先读 PostgreSQL `monitor.*`，同时可用 `GITHUB_TOKEN` 从 GitHub Actions API 补齐当前分支最近 runs。

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
- `[github-action-monitor]`
- `github_action_report.received`
- `github_action_report.fetch_run`
- `github_action_report.fetch_jobs`
- `github_action_report.db_written`
- `github_action_report.skipped`
- `branch_not_allowed`
- `branch_not_monitored`
- `missing_database_url`
- `missing_github_token`
- `github_api_auth_failed`
- `github_run_not_found`
- `github_api_network_error`
- `monitor.github_action_runs`
- `monitor.github_action_failures`
- `Using local PostgreSQL Action monitor reporter.`

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
12. 查 `/action-monitor/` 页面异常时，先打开对应 workflow 的最后一个 `Report Action Status` step，确认是否走了 `Using local PostgreSQL Action monitor reporter.`。
13. 如果 reporter 跳过，确认当前分支是否为 `dev` / `main`，以及 workflow 是否注入了分支对应的 `TRAINING_DB_URL`。
14. 如果 reporter 写库失败，优先确认 `monitor` schema 和四张表是否已经在对应 dev/main 数据库创建，再看错误是否为 GitHub API 401/403、404、网络错误或 PostgreSQL 权限问题。
15. 如果页面缺少最新 run，先看 `source/_data/actionMonitorView.json` 是否生成，再确认构建 job 是否有 `GITHUB_TOKEN` 和 `actions: read` 权限以启用 GitHub API fallback。
16. 如果页面有 run 但没有 job/step/failure 计数，说明该 run 可能只来自 GitHub API fallback，尚未有 PostgreSQL 明细；回看该 run 的 `Report Action Status` step。

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
- `missing_database_url`：给对应分支配置 `DEV_TRAINING_DB_URL` 或 `TRAINING_DB_URL`，或配置 `GITHUB_ACTION_MONITOR_REPORT_URL_DEV` / `GITHUB_ACTION_MONITOR_REPORT_URL_MAIN` 指向外部监控服务。
- `missing_github_token`：确认 workflow 的 report step 注入 `GITHUB_TOKEN: ${{ github.token }}`；本地运行时可用 `GITHUB_TOKEN` 或 `GH_TOKEN`。
- `github_api_auth_failed`：确认 token 具备读取 Actions run/jobs 权限；Pages 构建 fallback 需要 workflow `permissions: actions: read`。
- `github_run_not_found`：确认 `GITHUB_RUN_ID` / 上报 `run_id` 属于当前 `GITHUB_REPOSITORY`。
- `branch_not_allowed`：检查 `GITHUB_ACTION_MONITOR_ALLOWED_BRANCH` 或当前分支是否与监控实例环境一致。
- `relation "monitor.github_action_runs" does not exist`：先在对应 dev/main 数据库执行 Action monitor 建表脚本，再重跑 workflow 或等待 GitHub API fallback 只显示顶层 run。
- `/action-monitor/` 长时间显示运行中：优先确认该 run 是否经本地 reporter 写入；若只来自 GitHub API fallback，等 GitHub API conclusion 更新后重新构建页面。

## 预防措施

- 不只看 Actions 绿色结论，要看业务状态字段。
- 新增状态字段时同步 summary 输出。
- 重跑队列任务前保留原始 payload 和 `payload_hash`，确保幂等判断继续生效。
- 新增日志必须走 `tools/lib/action-logger.mjs` 或等价脱敏白名单。
- 新增 summary 字段前先判断是否包含 Secret、Prompt、用户文本、SQL 参数、原始 ID 或健康明细。
- 新增 workflow 必须包含最终 `Report Action Status` step，并保持 `if: always()`、`continue-on-error: true` 和最小 `run_id` payload。
- Action 监控失败不得阻断业务 workflow；不要去掉 report step 的 `continue-on-error: true`。
- dev/main 数据库分别建 `monitor.*` 表，不能用同一个监控实例同时写入两个分支。
- 外部 report URL 只能作为兜底入口；常规 GitHub Actions 内优先使用分支对应 PostgreSQL 本地 reporter。
- 页面读取上限只在需要时配置 `GITHUB_ACTION_MONITOR_VIEW_LIMIT`；默认保留完整可读取历史，不再按最近 2 天拆分。
- 当前系统文档只记录已落地事实；未实施设想保留在历史记录，不作为排查入口。
