# Main 统一入口 GitHub 与 Cloudflare 配置清单

本文只写 main 最终配置。目标是：Cloudflare main 只保留一个 Worker，GitHub main 同步只保留一个 Action。

## 最终只保留这些

| 平台 | 只保留 | 用途 |
| --- | --- | --- |
| Cloudflare Worker | `sync-dispatch` | main Telegram 和 main 飞书共用同一个入口 |
| GitHub sync workflow | `.github/workflows/sync.yml` | 同一个 workflow 内判断走 Telegram 还是飞书 |
| GitHub Worker deploy workflow | `.github/workflows/deploy-cloudflare-worker.yml` | 部署 `sync-dispatch` 并刷新 main Telegram webhook |
| GitHub Telegram webhook refresh workflow | `.github/workflows/refresh-telegram-webhook.yml` | 手动 / 定时刷新 main Telegram webhook |
| Wrangler 配置 | `wrangler.toml` | 只部署 `cloudflare/sync-dispatch-worker.mjs` |

生产 Pages 仍由 `.github/workflows/deploy-pages.yml` 负责，它是站点部署，不是 Telegram/飞书同步入口。

## 入口地址

| 渠道 | 填在哪里 | 地址 |
| --- | --- | --- |
| Telegram main webhook | GitHub Variable `TELEGRAM_WEBHOOK_URL` | `https://feishu.soulgo.chat/telegram` |
| 飞书 main Request URL | 飞书开放平台事件订阅 | `https://feishu.soulgo.chat` |

`/telegram` 路径只用于区分配置入口；统一 Worker 仍按 Telegram secret header、飞书签名头和飞书请求体结构判断渠道。

## 1. GitHub 只配置这些参数

进入 GitHub 仓库：

```text
Settings -> Secrets and variables -> Actions
```

### 1.1 Secrets

| Secret | 必填 | 值 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | 是 | Cloudflare API Token，用于部署 `sync-dispatch` |
| `CLOUDFLARE_ACCOUNT_ID` | 是 | Cloudflare Account ID |
| `AI_API_KEY` | 是 | 图片识别、随想和 `/analysis` 使用的 AI Key |
| `TRAINING_DB_URL` | 是 | main PostgreSQL 连接串 |
| `TELEGRAM_BOT_TOKEN` | 是 | main Telegram Bot token |
| `TELEGRAM_SECRET_TOKEN` | 是 | main Telegram webhook secret，必须和 Cloudflare `TELEGRAM_SECRET_TOKEN` 完全一致 |
| `FEISHU_APP_ID` | 飞书 main 必填 | main 飞书应用 App ID |
| `FEISHU_APP_SECRET` | 飞书 main 必填 | main 飞书应用 App Secret |
| `TELEGRAM_RECOGNITION_FALLBACK_API_KEY` | 否 | 图片识别备用 AI Key |

`TELEGRAM_SECRET_TOKEN` 可以这样生成：

```bash
openssl rand -hex 32
```

### 1.2 Variables

| Variable | 必填 | 值 |
| --- | --- | --- |
| `TELEGRAM_WEBHOOK_URL` | 是 | `https://feishu.soulgo.chat/telegram` |
| `AI_BASE_URL` | 是 | AI 服务 base URL |
| `AI_MODEL` | 是 | 默认 AI 模型 |
| `AI_PROVIDER` | 否 | 不填时默认 `openai-compatible` |
| `AI_TIMEOUT_MS` | 否 | AI 请求超时 |
| `AI_CONCURRENCY` | 否 | 图片识别并发 |
| `TRAINING_DB_ENABLED` | 建议填 | 生产稳态建议 `true` |
| `TRAINING_DB_TIMEOUT_MS` | 否 | DB 连接超时 |
| `TRAINING_DB_APP_NAME` | 否 | 可填 `training-records-dashboard` |
| `TRAINING_SNAPSHOT_SOURCE` | 建议填 | 生产稳态建议 `database` |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Telegram main 建议填 | 允许使用 main Bot 的 Telegram chat id |
| `FEISHU_ALLOWED_CHAT_IDS` | 飞书 main 建议填 | 允许使用 main 飞书应用的 chat id |
| `TELEGRAM_POLL_LIMIT` | 否 | webhook 模式通常不用改 |
| `TELEGRAM_RECOGNITION_MODEL` | 否 | 图片识别模型覆盖 |
| `TELEGRAM_RECOGNITION_FALLBACK_BASE_URL` | 否 | 备用 AI base URL |
| `TELEGRAM_RECOGNITION_FALLBACK_MODEL` | 否 | 备用 AI 模型 |
| `TELEGRAM_RECOGNITION_FALLBACK_TIMEOUT_MS` | 否 | 备用 AI 超时 |
| `TELEGRAM_RECOGNITION_CACHE_ENABLED` | 否 | 是否启用识别缓存 |
| `TRAINING_ANALYSIS_GOAL` | 否 | `/analysis` 长期目标 |

CLI 写入 `TELEGRAM_WEBHOOK_URL`：

```bash
gh variable set TELEGRAM_WEBHOOK_URL --body 'https://feishu.soulgo.chat/telegram'
```

## 2. Cloudflare 只配置这一个 Worker

Cloudflare Worker 名称：

```text
sync-dispatch
```

`wrangler.toml` 最终形态：

```toml
name = "sync-dispatch"
main = "cloudflare/sync-dispatch-worker.mjs"
compatibility_date = "2026-06-15"
workers_dev = true
routes = [
  { pattern = "feishu.soulgo.chat", custom_domain = true }
]

[vars]
GITHUB_DISPATCH_EVENT_TYPE_TELEGRAM = "telegram_update"
GITHUB_DISPATCH_EVENT_TYPE_FEISHU = "feishu_update"

[[durable_objects.bindings]]
name = "TELEGRAM_ALBUM_BUFFER"
class_name = "TelegramAlbumBuffer"

[[durable_objects.bindings]]
name = "FEISHU_IMAGE_BUFFER"
class_name = "FeishuImageBuffer"
```

部署方式二选一：

```bash
npx wrangler deploy --config wrangler.toml
```

或在 GitHub Actions 手动运行：

```text
Deploy Cloudflare Worker
```

部署成功后应看到统一 Worker 可通过这些地址访问：

```text
https://sync-dispatch.<workers子域名>.workers.dev
https://feishu.soulgo.chat/telegram
https://feishu.soulgo.chat
```

## 3. Cloudflare Worker Secrets

进入：

```text
Cloudflare Dashboard -> Workers & Pages -> sync-dispatch -> Settings -> Variables and Secrets
```

只在 `sync-dispatch` 上配置这些 Secret：

| Secret | 必填 | 值 |
| --- | --- | --- |
| `GITHUB_TOKEN` | 是 | GitHub PAT，用于调用 `repository_dispatch` |
| `TELEGRAM_BOT_TOKEN` | 是 | 和 GitHub `TELEGRAM_BOT_TOKEN` 同值 |
| `TELEGRAM_SECRET_TOKEN` | 是 | 和 GitHub `TELEGRAM_SECRET_TOKEN` 同值 |
| `FEISHU_ENCRYPT_KEY` | 飞书 main 必填 | 飞书 main 应用事件订阅 Encrypt Key |
| `FEISHU_VERIFICATION_TOKEN` | 飞书 main 必填 | 飞书 main 应用事件订阅 Verification Token |

CLI 写入方式：

```bash
npx wrangler secret put GITHUB_TOKEN --config wrangler.toml
npx wrangler secret put TELEGRAM_BOT_TOKEN --config wrangler.toml
npx wrangler secret put TELEGRAM_SECRET_TOKEN --config wrangler.toml
npx wrangler secret put FEISHU_ENCRYPT_KEY --config wrangler.toml
npx wrangler secret put FEISHU_VERIFICATION_TOKEN --config wrangler.toml
```

不要在 Cloudflare Dashboard 额外新增 `GITHUB_DISPATCH_EVENT_TYPE`。main 统一 Worker 已经通过 `wrangler.toml` 固定使用：

```text
GITHUB_DISPATCH_EVENT_TYPE_TELEGRAM=telegram_update
GITHUB_DISPATCH_EVENT_TYPE_FEISHU=feishu_update
```

## 4. Telegram main 配置

GitHub Variable：

```text
TELEGRAM_WEBHOOK_URL=https://feishu.soulgo.chat/telegram
```

然后手动运行 GitHub Actions：

```text
Refresh Telegram Webhook
```

或运行 Worker 部署：

```text
Deploy Cloudflare Worker
```

这两个 workflow 都会使用：

1. `TELEGRAM_BOT_TOKEN`
2. `TELEGRAM_WEBHOOK_URL`
3. `TELEGRAM_SECRET_TOKEN`

确认 `TELEGRAM_SECRET_TOKEN` 与 Cloudflare `sync-dispatch` Worker 的 `TELEGRAM_SECRET_TOKEN` 完全一致。

## 5. 飞书 main 配置

飞书开放平台 main 应用：

```text
开发配置 -> 事件与回调 -> Request URL
```

填写：

```text
https://feishu.soulgo.chat
```

保存前确认 Cloudflare `sync-dispatch` 已配置：

```text
FEISHU_ENCRYPT_KEY
FEISHU_VERIFICATION_TOKEN
```

## 6. GitHub Actions 最终行为

Telegram main 发消息后，只应触发：

```text
Sync (Main)
```

飞书 main 发消息后，也只应触发：

```text
Sync (Main)
```

区别只在 workflow 内部判断出的 channel：

```text
telegram -> npm run sync:telegram
feishu   -> npm run sync:feishu
```

`Sync (Main)` 仍保留这些生产语义：

- `repository_dispatch.types` 同时监听 `telegram_update` / `feishu_update`。
- `workflow_dispatch.inputs.channel` 支持手动选择 `telegram` / `feishu`，默认 `telegram`。
- `push` 到 `main` 且变更 `训练记录.md` 时走 Telegram 维护路径。
- checkout 固定 `ref: main`，push 固定 `git push origin HEAD:main`。
- 只检测并提交 `训练记录.md source/_posts source/images`。
- Telegram / 飞书分别保留 summary、成功通知和失败 monitor。
- DB-only 写入时异步触发 `deploy-pages.yml`，并传入 `strict_database_snapshot=true`。

## 7. 最终验证

### 7.1 Worker 路由

```bash
curl -i https://feishu.soulgo.chat/telegram
curl -i https://feishu.soulgo.chat
```

预期都是：

```text
405 method_not_allowed
```

未知 POST：

```bash
curl -i -X POST https://feishu.soulgo.chat/ \
  -H 'content-type: application/json' \
  --data '{"hello":"world"}'
```

预期：

```text
400 unknown_channel
```

### 7.2 端到端

1. Telegram main 发送 `/帮助`，应直接收到命令清单，不触发 GitHub dispatch。
2. Telegram main 发送文字/图片，应触发 `Sync (Main)` 且 channel 为 `telegram`。
3. 飞书 main 保存 Request URL，URL verification 应返回 challenge。
4. 飞书 main 发送文字/图片，应触发 `Sync (Main)` 且 channel 为 `feishu`。
5. 有 DB-only 写入时，`Sync (Main)` 应异步触发 `deploy-pages.yml`。

## 8. 可以删除或停用的旧 main 资源

确认上面验证通过后，只保留新入口。旧 main 资源可以删除或停用：

| 平台 | 删除 / 停用 |
| --- | --- |
| Cloudflare Worker | `telegram-sync-dispatch` |
| Cloudflare Worker | `feishu-sync-dispatch` |
| GitHub workflow | `.github/workflows/telegram-sync.yml` |
| GitHub workflow | `.github/workflows/feishu-sync.yml` |
| GitHub workflow | `.github/workflows/deploy-cloudflare-feishu-worker.yml` |
| Wrangler config | `wrangler.feishu.toml` |

删除旧 Cloudflare Worker 前，先确认：

- Telegram webhook 已指向 `https://feishu.soulgo.chat/telegram`。
- 飞书 main Request URL 已指向 `https://feishu.soulgo.chat`。
- `feishu.soulgo.chat` 已绑定在 `sync-dispatch` 上。
- `sync-dispatch` 已配置所有 Cloudflare Worker Secrets。

CLI 删除旧 Worker：

```bash
npx wrangler delete telegram-sync-dispatch
npx wrangler delete feishu-sync-dispatch
```

不要删除这些源码文件：

```text
cloudflare/telegram-sync-dispatch-worker.mjs
cloudflare/feishu-sync-dispatch-worker.mjs
```

它们不是旧线上资源；`cloudflare/sync-dispatch-worker.mjs` 仍复用这两个 handler。

## 9. 一句话总表

| 要配的地方 | 最终值 |
| --- | --- |
| Cloudflare Worker | `sync-dispatch` |
| Telegram main webhook | `https://feishu.soulgo.chat/telegram` |
| 飞书 main Request URL | `https://feishu.soulgo.chat` |
| GitHub 同步 Action | `Sync (Main)` / `.github/workflows/sync.yml` |
| GitHub Worker 部署 Action | `Deploy Cloudflare Worker` / `.github/workflows/deploy-cloudflare-worker.yml` |
| Telegram dispatch type | `telegram_update` |
| 飞书 dispatch type | `feishu_update` |

