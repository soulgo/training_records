# 模块级重构方案：clodflare-action

> 文件名按原始要求保留 `clodflare-action.md`。本文覆盖 Cloudflare Worker 与 GitHub Actions 链路。

## 当前问题

| 问题 | 证据 | 优先级 | 风险等级 |
| --- | --- | --- | --- |
| Worker 只负责 dispatch，任务状态主要在 GitHub Action 内部形成 | `cloudflare/sync-dispatch-worker.mjs` -> `SyncDispatchQueue` -> workflow_dispatch | P1 | P2 |
| Workflow 包含较多业务判断和 summary 解析 | `.github/workflows/sync.yml` / `sync-dev.yml` 中有 6 段内联 Node.js | P2 | P2 |
| main/dev 配置靠人工和测试混合维护 | `wrangler.toml`、`wrangler.dev.toml`、GitHub Variables/Secrets | P1 | P2 |
| SyncDispatchQueue 已实现基础队列，但缺少优先级和批量合并 | `cloudflare/sync-dispatch-queue.mjs` 已实现三阶段状态机 + 死信 | P1 | P1 |
| FeishuImageBuffer 进入队列前的失败恢复弱于 SyncDispatchQueue | 原始审计发现前置 buffer 没有最大次数和 dead-letter；当前本地合同已为 FeishuImageBuffer 增加最大 dispatch retry 与 `deadLetters` 摘要 | P1 | P1 |
| Workflow `run:` shell 语法缺少测试 | 原始审计发现 workflow 文本断言不足；当前本地合同已用 `js-yaml` 解析 `.github/workflows/sync*.yml` 后对所有 `run:` 执行 `bash -n` | P1 | P1 |
| main 飞书 sync -> deploy 链路在历史窗口反复失败 | `27700045978`/`27698033957` 飞书 sync 成功但 deploy 触发失败；`27700072997`/`27698068999` deploy 构建/验证失败；最新 10 次 Actions 已恢复全绿 | P0 | P1 |
| npm 4 个 vulnerable packages 未修复 | `dompurify` XSS/sanitization bypass、`form-data` CRLF、`js-yaml` DoS、`ws` 内存耗尽，均可 `npm audit fix` | P1 | P1 |
| TelegramAlbumBuffer dispatch 失败恢复需保留真实平台验收 | 原始审计发现 dispatch 失败后仍删除 `updates`；当前本地合同已保留缓冲重试，达到上限后写 `deadLetters` 并清理缓冲 | P1 | P1 |
| 飞书签名 timestamp/replay 防护需保留真实平台验收 | 原始审计发现只校验 HMAC；当前本地合同已检查 timestamp freshness，并对窗口内重复 nonce/signature 记录 replay warning | P1 | P1 |

实施状态校准（2026-06-21，本地合同）：

- Workflow `run:` 脚本语法、TelegramAlbumBuffer dispatch 失败恢复、FeishuImageBuffer dead-letter、飞书 timestamp freshness / replay warning 均已完成本地合同测试，并记录到 `实施checklist.md`。
- 上表保留原始风险来源；真实 Cloudflare Durable Object storage、tail 日志、GitHub workflow_dispatch 和 dev/main 端到端仍按阶段 6/7 单独验收。

## 设计缺陷

- `SyncDispatchQueue` 已提供 `task_id` 和顺序派发，但缺少优先级分级（所有任务同等优先级）和跨 dispatch 的批量合并。
- `FeishuImageBuffer` 是进入统一队列前的前置缓冲层，它的重试/终止语义必须单独描述，不能被 `SyncDispatchQueue` 的 dead-letter 掩盖；当前本地合同已为它补最大次数和 dead-letter。
- `TelegramAlbumBuffer` 与 `FeishuImageBuffer` 的失败语义曾不一致；当前本地合同已让 Telegram 前置 buffer 在 dispatch 失败时保留 updates、重试并最终 dead-letter。
- 同一 chat 连续消息需要顺序处理，当前由 `SyncDispatchQueue` 按 `sortKey` 排队保证，但长队列可能延迟响应。
- Workflow 内联 6 段 Node.js 代码，越来越像业务编排器，不利于本地测试和复用。
- Worker → workflow_dispatch 的 `dispatch_payload` 结构未标准化（Telegram 和飞书 payload 格式不同）。
- 当前 workflow `run:` 脚本已由 `test/github-workflows.test.mjs` 解析 YAML 后执行 `bash -n`；历史 heredoc 缩进问题仍作为回归风险保留。

## 重构方案

### P0：统一 dispatch payload

当前 Worker 通过两条路径派发到 GitHub：

**路径 A — workflow_dispatch（主路径，经 SyncDispatchQueue）：**

```json
{
  "ref": "main",
  "inputs": {
    "channel": "telegram",
    "queue_task_id": "telegram:123:telegram_update:abc123",
    "dispatch_payload": "{\"action\":\"telegram_update\",\"client_payload\":{\"telegram_updates\":[...]}}"
  }
}
```

**路径 B — repository_dispatch（fallback，SyncDispatchQueue 未配置时）：**

```json
{
  "event_type": "telegram_update",
  "client_payload": {
    "telegram_updates": []
  }
}
```

建议在 `dispatch_payload` 内统一为标准字段（`task_id`、`channel`、`trace`），旧字段保留兼容。

### P1：增强 SyncDispatchQueue

`SyncDispatchQueue` Durable Object 已在 `cloudflare/sync-dispatch-queue.mjs` 中实现：

- 三阶段状态机：`dispatch` → `wait_for_run` → `wait_for_completion`。
- 指数退避重试（base 10s，max 60s，最多 5 次），超过后进入死信队列（保留最近 100 条）。
- SQLite 存储 + KV fallback。
- 死信时向原始聊天发送失败通知。

需要增强：

- 先补可观测性和前置缓冲失败恢复：死信数量、平均等待时间、当前队列深度、FeishuImageBuffer 连续失败次数。
- 再评估是否需要优先级分级（P0 系统消息 > P1 图片 > P2 随想 > P3 分析）和跨 dispatch 批量合并。当前项目规模下它们是可选增强，不应阻塞核心能力保护。

当前 Workflow concurrency 使用条件式 group（队列派发走 per-run group，手动/push 走共享 group），`cancel-in-progress: false`。

### P1：Workflow 薄化

把 Detect changes、summary、DB-only deploy 判定逐步移入 Node 脚本：

- `tools/sync-action-runner.mjs`
- `tools/sync-action-summary.mjs`
- `tools/sync-action-deploy-decision.mjs`

Workflow 只保留 checkout、setup、install、run script、commit、push。

### P1：补 Workflow shell 语法合同测试

推荐测试策略：

1. 用 `js-yaml` 解析 `.github/workflows/sync.yml` 与 `.github/workflows/sync-dev.yml`。
2. 遍历所有 `jobs.*.steps[].run`。
3. 对 bash shell 脚本执行 `bash -n`。
4. 对含 `node <<'NODE'` 的脚本额外断言 YAML 解析后的 `NODE` 结束符位于列 0。

当前本地验证结果：`node --test --test-name-pattern "sync workflow run scripts are valid bash" test/github-workflows.test.mjs` 会解析 YAML 后对所有 `run:` 脚本执行 `bash -n`。该验证证明本地 workflow shell 语法合同，不替代真实 GitHub Actions 执行。

## 接口变更影响

| 接口 | 影响 | 兼容策略 |
| --- | --- | --- |
| Worker dispatch payload | 新增 `task_id/channel/trace` 标准化字段 | 旧 `telegram_updates` / `feishu_updates` 仍保留 |
| `buildTelegramDispatchPayload()` / `buildFeishuDispatchPayload()` | 扩展 payload 结构 | 旧字段不删除 |
| `SyncDispatchQueue.buildTaskId()` | 调整 task_id 格式以支持优先级 | 保持向后兼容 |
| GitHub workflow | concurrency 已是条件式 group | dev 先验证 |

## 数据结构影响

见 `消息链路.md` 的 `ingest.message_task` 设计。

## 风险评估

| 风险 | 等级 | 控制 |
| --- | --- | --- |
| concurrency 分组错误导致并发阻塞 | P1 | dev only 灰度，保留 run id fallback |
| Worker 生成 task_id 与应用层不一致 | P1 | 共享 fixture 和合同测试 |
| workflow 脚本化引入新 failure mode | P2 | 每步保留 JSON 输出和 GitHub summary |
| heredoc/YAML 缩进回归 | P1 | 新增 `bash -n` 测试，或改为临时 `.mjs` 文件执行 |
| FeishuImageBuffer 无终止导致长期 alarm 重试 | P1 | 本地合同已增加最大次数与 dead-letter；真实 DO/tail 告警仍需演练 |
| TelegramAlbumBuffer dispatch 失败后丢失 Worker 缓冲 | P1 | 本地合同已在 dispatch/通知失败时保留 updates 并重试，超过阈值写 dead-letter |
| 飞书旧签名请求可重放 | P1 | 本地合同已增加 timestamp skew 校验，并对 nonce/signature 重放记录 warning |
| main 飞书 deploy 链路持续失败 | P0 | 先定位根因再修复，不在 workflow 结构上大改 |
| npm 漏洞被利用 | P1 | `npm audit fix` 后立即验证，CI 增加 audit 检查 |

## Bug 修复方案（本轮审计新增）

### P1-15：TelegramAlbumBuffer dispatch 失败恢复需保留真实平台验收

**问题文件**：`cloudflare/telegram-sync-dispatch-worker.mjs:65-85`

**原始问题描述**：原始审计发现 Telegram 图片 buffer 在 alarm 中 dispatch GitHub，若 response 非 2xx，会尝试逐条通知用户，但随后无条件删除 `updates`。通知发送函数在 fetch 异常时返回 `null`，没有日志。若 GitHub dispatch 失败且通知也失败，Worker 层没有保留可重放原始消息。

**实施状态（本地）**：当前本地合同已完成：dispatch 失败时递增 `dispatchRetryCount` 并保留 `updates`，达到最大次数后写 `deadLetters`。`test/telegram-sync-dispatch-worker.test.mjs` 已覆盖 dispatch+通知失败保留缓冲和超过最大重试后 dead-letter。真实 Cloudflare DO storage/tail、GitHub API 故障注入和 dev/main 端到端仍需验收。

**修复策略**：

1. dispatch 失败后只有在通知成功且明确不重试时才清空缓冲；否则保留 `updates`。
2. 增加 `dispatchRetryCount`、最大次数和 dead-letter。
3. 通知失败写入日志，dead-letter 中保留 update_id/chat/message_id 摘要。

**测试策略**：

- dispatch 500 + 通知失败：updates 保留，设置下一次 alarm。
- dispatch 500 + 通知成功 + 达到最大次数：写 dead-letter。
- dispatch 后续成功：清空 updates。

**回滚计划**：

- 如保留缓冲造成重复 dispatch，可把最大重试降为 1，但仍保留 dead-letter 摘要。

---

### P1-16：飞书签名 timestamp/replay 防护需保留真实平台验收

**问题文件**：`cloudflare/feishu-sync-dispatch-worker.mjs:232-257`

**原始问题描述**：原始审计发现 `verifyFeishuSignature()` 校验 HMAC，但不检查 `X-Lark-Request-Timestamp` 是否在允许时间窗内，也不记录 nonce。旧合法请求被重放时仍可进入后续 dispatch；队列和 DB 幂等不能替代入口层防重放。

**实施状态（本地）**：当前本地合同已完成：签名校验拒绝过旧/过远未来 timestamp，窗口内重复 nonce/signature 会记录 replay warning。`test/feishu-dispatch-worker.test.mjs` 已覆盖 timestamp freshness 与 replay warning。真实飞书回调时间偏差、加密信封和 replay 演练仍需验收。

**修复策略**：

1. `FEISHU_SIGNATURE_MAX_SKEW_SECONDS=300`。
2. 拒绝 timestamp 非数字、过旧、过远未来。
3. 可选：DO/KV 保存短期 nonce/signature，窗口内重复拒绝。

**测试策略**：

- 当前窗口内合法签名通过。
- 超过 skew 的旧 timestamp 被拒绝。
- 相同 nonce/signature 在窗口内重放被拒绝或记录 replay warning。

**回滚计划**：

- 临时放宽 skew，不关闭 timestamp 校验。

## 回滚方案

1. Worker 继续发送旧 payload 字段。
2. Workflow concurrency 回退到当前配置。
3. Node runner 失败时可直接恢复 YAML 内联逻辑。
4. 不删除旧 workflow，先在 dev 分支验证。

## 验证

```bash
node --test test/sync-dispatch-worker.test.mjs test/telegram-sync-dispatch-worker.test.mjs test/feishu-dispatch-worker.test.mjs test/github-workflows.test.mjs
npx wrangler deploy --dry-run --config wrangler.dev.toml
```

验收必须覆盖：

- TelegramAlbumBuffer dispatch 失败、通知失败、重试成功、dead-letter 四个状态。
- FeishuImageBuffer 入队前连续失败的最大次数/告警。
- 飞书签名 timestamp 新鲜度和 nonce replay。
- sync summary 暴露 `dateSources/warnings/dateConfidence`，不能只输出 `archivedDate`。
