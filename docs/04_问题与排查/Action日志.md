# Action 日志

## 现象

- Bot 已回复“已入库”，但页面尚未更新或独立 deploy run 失败。
- sync run 成功，但 summary 中出现 `pending_replay`、`partialFailure`、fallback 或 slow query。
- Worker 已收到消息，但 GitHub workflow 没有启动。
- `/action-monitor/` 缺少 run、只有顶层 run 没有 job/step，或环境显示不正确。
- `Pending Replay (Dev)` 长期失败、重复运行或某一渠道没有消费。

## 原因

- sync 与 deploy 已解耦：sync 只派发 Pages workflow，不等待部署完成。
- 业务写入失败会进入 `ingest.pending_task`；GitHub run 的 conclusion 不能替代业务状态判断。
- Queue 需要在 dispatch 后找到带 `queue_task_id` 的 sync run；查找超时会进入 dead letter。
- `Action Monitor Report` 依赖 `workflow_run`、GitHub `actions: read` 和分支数据库连接；上报晚于原 workflow 完成是正常时序。
- dev pending replay 按 Telegram/飞书两个 matrix job 分组；某一组失败不会取消另一组。

## 日志特征

同步 summary 重点字段：

- `traceId`、`queueTaskId`、`channel`、`batchId`
- `persistenceStatus` / `status`
- `transactionId`、`rowCounts`、`durationMs`
- `pendingStatus`、`rollbackStatus`
- `slowQueries[].queryOrdinal/operation/table/durationMs/thresholdMs`
- deploy dispatch 的 workflow、ref 与 dispatch 成功/失败

Queue / Worker 重点字段：

- `github_workflow_run_not_found_after_dispatch`
- `outcome: dead_letter` / `dead-letter`
- `taskId`、`eventType`、`channel`
- “GitHub Action 未能启动”通知

## 排查步骤

1. 从 Bot 回执或 sync run 记录 `queueTaskId`、`traceId` 和 `batchId`。
2. 打开 `Sync (Main)` / `Sync (Dev)` summary，先判断业务状态是否为 `stored` / `unchanged`，还是 `pending_replay` / `partialFailure` / `skipped`。
3. 查看 Database 摘要。慢查询只根据 operation/table/ordinal 定位，不应要求日志输出 SQL 参数。
4. 如果 sync 成功但页面未更新，打开独立 `Deploy GitHub Pages` 或 `Deploy Cloudflare Pages (Dev)` run；不要在 sync run 中等待 deploy conclusion。
5. 如果没有 sync run，查 Cloudflare Worker/Queue 日志，确认分片键对应正确 channel/chat，并检查 `dead-letter`。
6. 如果 workflow 已 dispatch 但 Queue 报 run lookup timeout，确认 run-name 含同一个 `queue_task_id`，并检查 workflow file/ref 配置。
7. 对 `pending_replay`，运行 `npm run maintenance:inspect`；需要精确审计时加 `-- --batch-id <batchId>`。
8. 检查 `Pending Replay (Dev)` 最近两条 matrix job，确认 `SYNC_REPLAY_MODE=scheduled` 和目标渠道凭据完整。
9. `/action-monitor/` 缺少明细时，打开由原 run 触发的 `Action Monitor Report`，确认选择了正确分支数据库并成功读取 GitHub API。
10. 页面只有 GitHub API 顶层 run 时，说明 PostgreSQL 明细尚未写入或上报失败；继续查 `Action Monitor Report`，不要修改原 workflow conclusion。

## 解决方案

- deploy 失败：修复 Pages 构建、数据库快照或页面精确校验后，单独重跑 deploy workflow。
- pending：修复 AI、COS 或 PostgreSQL 根因，等待定时 replay 或手工运行 `Pending Replay (Dev)`；不要让新 webhook 顺带消费历史任务。
- queue `dead-letter`：修复 GitHub token、workflow file/ref、run-name 关联或 API 权限，再按原 payload 重跑；保留 `payload_hash` / `payloadHash`，相同批次应返回 `unchanged`，避免重复写 core。
- Action monitor 上报失败：确认 `.github/workflows/action-monitor-report.yml` 的 `actions: read`、目标分支、DB Secret 和 `monitor.*` 表权限。
- Provider fallback：核对 `AI_SUPPORTS_VISION/JSON_SCHEMA/JSON_OBJECT/TEXT_JSON` 与服务商真实能力，再查 HTTP 429/5xx、timeout 和本地 schema failure。
- DB 慢：先区分 connect/BEGIN/query/COMMIT 分段，再根据 `queryOrdinal + operation + table` 定位；不要把网络停顿猜成具体 SQL 执行慢。

## 预防措施

- 新增 sync/deploy/pending workflow 时同步更新 `action-monitor-report.yml` 的监听列表。
- 不在 sync workflow 恢复 deploy 轮询或同步 Action monitor 拉取。
- Queue 继续按会话分片；不要改成全局单队列，也不要破坏同一会话 FIFO。
- summary、monitor 表和通知不得记录 dispatch payload、消息正文、chat id 明文、图片 key、Prompt、SQL 参数或 Secret。
- 定期检查 `Pending Replay (Dev)`、dead letter 和 `/action-monitor/` 是否同时覆盖 dev/main 当前分支。
