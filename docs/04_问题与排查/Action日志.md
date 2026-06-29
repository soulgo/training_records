# Action 日志

## 现象

- GitHub Actions 结论为 success，但业务未完成。
- summary 中出现 `business incomplete` warning。
- 部署 workflow 未被找到或超时。

## 原因

- 同步 step 成功执行，但某些 batch 为 `pending_replay`、`manual_intervention` 或 `partialFailure`。
- DB-only 变化触发了部署，但部署 workflow 查询超时。
- 通知 step 设置 `continue-on-error`，通知失败不会改变主同步结果。

## 日志特征

- `business incomplete`
- `pending_replay`
- `manual_intervention`
- `queue_task_id`
- `workflow run 查找超时` / `run lookup timeout`
- `dead-letter`
- `payload_hash` / `payloadHash`
- `unchanged`
- `Deploy workflow not found`
- `Deploy workflow timed out`

## 排查步骤

1. 先看 summary 表格中的 `taskStatus`、`persistenceStatus`、`failureDisposition`。
2. 看 `Image storage` 表是否有 failed。
3. 看 `failed messageIds`。
4. 看 `Site deploy result` 的 workflow、runId、conclusion。
5. 对失败步骤查对应脚本：`tools/telegram-action-monitor.mjs`、`tools/feishu-action-monitor.mjs`。
6. 队列任务必须用 `queue_task_id` 关联 workflow run。若出现 workflow run 查找超时 / run lookup timeout，先查 Worker/Queue 日志，再查 `SyncDispatchQueue` dead-letter。
7. 重跑 / rerun 时复用原始 payload，避免改变 `payload_hash` / `payloadHash`。同一 `batch_id + payload_hash` 重复执行应返回 `unchanged`，不得重复写 core。

## 解决方案

- `pending_replay`：先修复 DB 或 AI/COS 根因，再重放。
- `manual_intervention`：修正用户输入或目标随想 id。
- 部署失败：单独重跑 Pages workflow。
- run lookup timeout：确认 workflow dispatch 已发出、`queue_task_id` 是否进入 run-name，再按 dead-letter 记录重放。
- `unchanged`：代表相同 payload 已处理，不应人工重复写 `core.*`。

## 预防措施

- 不只看 Actions 绿色结论，要看业务状态字段。
- 新增状态字段时同步 summary 输出。
- 重跑队列任务前保留原始 payload 和 `payload_hash`，确保幂等判断继续生效。
