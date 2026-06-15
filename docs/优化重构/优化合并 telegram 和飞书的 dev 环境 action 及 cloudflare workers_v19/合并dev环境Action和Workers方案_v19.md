## v19 — 合并 Telegram 和飞书的 Dev 环境 GitHub Action 及 Cloudflare Workers

### 一、结论

v19 已将 dev 环境收敛为：

| 类型 | 合并后资源 | 说明 |
| --- | --- | --- |
| Cloudflare Worker | `sync-dispatch-dev` | 统一接收 Telegram webhook 和飞书事件回调 |
| GitHub deploy workflow | `.github/workflows/deploy-cloudflare-worker-dev.yml` | 部署统一 Worker，并刷新 dev Telegram webhook |
| GitHub sync workflow | `.github/workflows/sync-dev.yml` | 同时监听 `telegram_update_dev` / `feishu_update_dev`，并支持手动选择渠道 |

生产环境不在 v19 范围内，`wrangler.toml`、`wrangler.feishu.toml`、生产 deploy/sync workflows 保持独立。

---

### 二、合并前后链路

合并前：

```text
Telegram Webhook -> telegram-sync-dispatch-dev -> repository_dispatch(telegram_update_dev) -> telegram-sync-dev.yml
飞书 Event       -> feishu-sync-dispatch-dev   -> repository_dispatch(feishu_update_dev)   -> feishu-sync-dev.yml

deploy-cloudflare-worker-dev.yml        -> wrangler.dev.toml
deploy-cloudflare-feishu-worker-dev.yml -> wrangler.feishu-dev.toml
```

合并后：

```text
Telegram Webhook -> sync-dispatch-dev -> repository_dispatch(telegram_update_dev) -> sync-dev.yml -> npm run sync:telegram
飞书 Event       -> sync-dispatch-dev -> repository_dispatch(feishu_update_dev)   -> sync-dev.yml -> npm run sync:feishu

deploy-cloudflare-worker-dev.yml -> wrangler.dev.toml -> sync-dispatch-dev
```

---

### 三、统一 Worker 设计

新增 `cloudflare/sync-dispatch-worker.mjs`，只负责识别来源渠道并转交现有 handler：

- Telegram 继续走 `handleTelegramWebhook()` 和 `TelegramAlbumBuffer`。
- 飞书继续走 `handleFeishuWebhook()` 和 `FeishuImageBuffer`。
- 两个原 handler 的认证、解密、dispatch payload、缓冲逻辑不在统一入口里重写。

路由识别规则：

| 渠道 | 识别方式 | 说明 |
| --- | --- | --- |
| Telegram | 请求头 `X-Telegram-Bot-Api-Secret-Token` 存在 | 交给 Telegram handler 后再校验 secret 值 |
| 飞书明文事件 | 任一 `X-Lark-*` 签名头存在 | 交给 Feishu handler 后再校验 token / HMAC |
| 飞书 URL verification | body 符合 `url_verification` 结构 | 必须支持无 `X-Lark-*` 头的 challenge |
| 飞书加密事件 | body 含非空 `encrypt` 字段 | 必须支持开启加密策略后的回调 |
| 未知请求 | 不满足上述任一条件 | 返回 `400 {"ok":false,"error":"unknown_channel"}` |

关键实现约束：

```js
const body = await request.clone().json();
```

统一入口做 body 识别时必须使用 `request.clone()`，不能消耗原始 request。飞书 handler 仍需要读取 `request.text()` 来完成解密和签名校验；如果统一入口先消费原 request，会导致飞书加密事件和 URL verification 失败。

---

### 四、统一 Wrangler 配置

`wrangler.dev.toml` 改为统一 dev Worker 配置：

```toml
name = "sync-dispatch-dev"
main = "cloudflare/sync-dispatch-worker.mjs"
compatibility_date = "2026-06-15"
workers_dev = true
routes = [
  { pattern = "feishu-dev.soulgo.chat", custom_domain = true }
]

[vars]
GITHUB_DISPATCH_EVENT_TYPE_TELEGRAM = "telegram_update_dev"
GITHUB_DISPATCH_EVENT_TYPE_FEISHU = "feishu_update_dev"

[[durable_objects.bindings]]
name = "TELEGRAM_ALBUM_BUFFER"
class_name = "TelegramAlbumBuffer"

[[durable_objects.bindings]]
name = "FEISHU_IMAGE_BUFFER"
class_name = "FeishuImageBuffer"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["TelegramAlbumBuffer", "FeishuImageBuffer"]
```

`wrangler.feishu-dev.toml` 已删除；飞书 dev 自定义域名 `feishu-dev.soulgo.chat` 由统一 `wrangler.dev.toml` 管理。

---

### 五、Dispatch Event Type

统一 Worker 需要同一个 runtime 内根据渠道发送不同 GitHub dispatch type，因此两个旧 handler 保留旧变量并新增分渠道优先级：

```js
// Telegram
env.GITHUB_DISPATCH_EVENT_TYPE_TELEGRAM
  || env.GITHUB_DISPATCH_EVENT_TYPE
  || 'telegram_update'

// Feishu
env.GITHUB_DISPATCH_EVENT_TYPE_FEISHU
  || env.GITHUB_DISPATCH_EVENT_TYPE
  || 'feishu_update'
```

这样 dev 统一 Worker 使用新变量；生产独立 Worker 继续使用旧 `GITHUB_DISPATCH_EVENT_TYPE` 或默认值，不受 v19 影响。

---

### 六、统一 Sync Workflow

新增 `.github/workflows/sync-dev.yml`，删除旧 `.github/workflows/telegram-sync-dev.yml` 和 `.github/workflows/feishu-sync-dev.yml`。

必须保留的行为：

- `repository_dispatch.types` 同时监听 `telegram_update_dev` 和 `feishu_update_dev`。
- `workflow_dispatch.inputs.channel` 支持手动选择 `telegram` / `feishu`，默认 `telegram`。
- `permissions` 必须包含 `contents: write` 和 `actions: write`，否则提交 dev 分支和触发 dev Pages workflow 会失败。
- checkout 固定 `ref: dev`，push 固定 `git push origin HEAD:dev`。
- 只检测并提交 `训练记录.md source/_posts source/images`，不能使用 `git add -A`。
- `AI_PROVIDER` 保持 `${{ vars.AI_PROVIDER || 'openai-compatible' }}` 默认值。
- Telegram 和飞书分别保留原 summary 表格、成功通知脚本和失败 monitor 脚本。
- 失败通知必须传入 `STEP_INSTALL_OUTCOME`、`STEP_SYNC_OUTCOME`、`STEP_DETECT_OUTCOME`、`STEP_COMMIT_OUTCOME`、`STEP_PUSH_OUTCOME`。

变更检测必须复用原 dev workflow 语义：

```js
const batches = result.batchResults ?? result.batches ?? [];
readyStoredContentBatches = batches.filter((batch) => {
  const kind = batch.kind ?? 'image';
  return ['image', 'thought'].includes(kind) &&
    batch.status === 'ready' &&
    batch.persistenceStatus === 'stored';
}).length;
```

dev Pages 触发条件保持：

```yaml
if: success() && github.event_name == 'repository_dispatch' && (steps.detect.outputs.repo_changed == 'true' || steps.detect.outputs.db_content_changed == 'true')
```

---

### 七、Deploy Workflow

`.github/workflows/deploy-cloudflare-worker-dev.yml` 保留为 dev 唯一 Worker 部署入口：

- `cloudflare/wrangler-action@v3` 部署 `wrangler.dev.toml`。
- 部署后继续运行 `npm run telegram:webhook`，刷新 Telegram dev webhook 到统一 Worker URL。
- `.github/workflows/deploy-cloudflare-feishu-worker-dev.yml` 已删除。

操作项：

- 更新 GitHub Actions Variable `DEV_TELEGRAM_WEBHOOK_URL` 为 `https://sync-dispatch-dev.<workers子域名>.workers.dev/`。
- 确认 GitHub Secret `DEV_TELEGRAM_SECRET_TOKEN` 与 Cloudflare Worker Secret `TELEGRAM_SECRET_TOKEN` 值一致。

---

### 八、Cloudflare Secrets

统一 `sync-dispatch-dev` Worker 需要重新配置以下 Worker Secrets：

| Secret | 用途 |
| --- | --- |
| `TELEGRAM_SECRET_TOKEN` | Telegram webhook secret 校验 |
| `TELEGRAM_BOT_TOKEN` | Telegram help / dispatch 失败通知 |
| `FEISHU_ENCRYPT_KEY` | 飞书解密和明文 HMAC 签名 |
| `FEISHU_VERIFICATION_TOKEN` | 飞书事件 token 校验 |
| `GITHUB_TOKEN` | 调用 GitHub repository_dispatch |

原 `telegram-sync-dispatch-dev` 和 `feishu-sync-dispatch-dev` 的 Secrets 不会自动迁移到新 Worker，需要在 Cloudflare Dashboard 或通过 `wrangler secret put --config wrangler.dev.toml` 重新写入。

---

### 九、文件变更清单

新增：

- `cloudflare/sync-dispatch-worker.mjs`
- `.github/workflows/sync-dev.yml`
- `test/sync-dispatch-worker.test.mjs`

修改：

- `wrangler.dev.toml`
- `.github/workflows/deploy-cloudflare-worker-dev.yml`
- `.github/workflows/ci-tests.yml`
- `cloudflare/telegram-sync-dispatch-worker.mjs`
- `cloudflare/feishu-sync-dispatch-worker.mjs`
- `test/cloudflare-config.test.mjs`
- `test/github-workflows.test.mjs`
- `test/telegram-sync-dispatch-worker.test.mjs`
- `test/feishu-dispatch-worker.test.mjs`
- 相关部署/架构文档

删除：

- `wrangler.feishu-dev.toml`
- `.github/workflows/deploy-cloudflare-feishu-worker-dev.yml`
- `.github/workflows/telegram-sync-dev.yml`
- `.github/workflows/feishu-sync-dev.yml`

生产环境文件不修改：

- `wrangler.toml`
- `wrangler.feishu.toml`
- `.github/workflows/deploy-cloudflare-worker.yml`
- `.github/workflows/deploy-cloudflare-feishu-worker.yml`
- `.github/workflows/telegram-sync.yml`
- `.github/workflows/feishu-sync.yml`

---

### 十、测试与验收

新增/更新测试覆盖：

- `test/sync-dispatch-worker.test.mjs`：Telegram header、飞书 Lark header、飞书明文 URL verification、飞书加密 `encrypt`、未知请求、非 POST、两个 DO 导出。
- `test/telegram-sync-dispatch-worker.test.mjs`：`GITHUB_DISPATCH_EVENT_TYPE_TELEGRAM` 优先于旧变量。
- `test/feishu-dispatch-worker.test.mjs`：`GITHUB_DISPATCH_EVENT_TYPE_FEISHU` 优先于旧变量。
- `test/cloudflare-config.test.mjs`：统一 `wrangler.dev.toml` 包含两个 DO 绑定、两个 dispatch vars、飞书 dev custom domain，且不存 secrets。
- `test/github-workflows.test.mjs`：统一 `sync-dev.yml` 的权限、触发类型、手动 channel、dev 分支写入、变更检测、summary、通知和 dev Pages 触发。

推荐验证命令：

```bash
node --test test/sync-dispatch-worker.test.mjs test/telegram-sync-dispatch-worker.test.mjs test/feishu-dispatch-worker.test.mjs test/cloudflare-config.test.mjs test/github-workflows.test.mjs
npm test
```

端到端验收：

1. 运行 `Deploy Cloudflare Worker (Dev)`，确认部署目标为 `sync-dispatch-dev`。
2. Telegram dev 发送 `/帮助`，确认 Worker 本地响应，不触发 dispatch。
3. Telegram dev 发送文字/图片，确认触发 `Sync (Dev)` 且 channel 为 `telegram`。
4. 飞书 dev 保存 Request URL，确认 URL verification 返回 challenge。
5. 飞书 dev 发送文字/图片，确认触发 `Sync (Dev)` 且 channel 为 `feishu`。
6. 有 DB-only 写入时，确认 `Sync (Dev)` 异步触发 `deploy-cloudflare-pages-dev.yml`。

---

### 十一、回退方案

如果统一 dev Worker 出现问题：

1. 从 git history 恢复 `wrangler.feishu-dev.toml`、`telegram-sync-dev.yml`、`feishu-sync-dev.yml` 和 `deploy-cloudflare-feishu-worker-dev.yml`。
2. 将 `wrangler.dev.toml` 恢复为旧 Telegram dev Worker 配置。
3. 重新部署旧 `telegram-sync-dispatch-dev` 和 `feishu-sync-dispatch-dev`。
4. 将 `DEV_TELEGRAM_WEBHOOK_URL` 改回旧 Telegram dev workers.dev URL。
5. 飞书 dev Request URL 保持 `https://feishu-dev.soulgo.chat`，但 Cloudflare route 需重新指回旧 `feishu-sync-dispatch-dev`。

旧 Worker 下线前建议先保留一段验证窗口，确认 Telegram 相册缓冲和飞书图片缓冲都已清空。
