# Dev 统一入口 GitHub 与 Cloudflare 配置清单

本文只写最终 dev 配置。目标是：Cloudflare dev 只保留一个 Worker，GitHub dev 同步只保留一个 Action。

## 最终只保留这些

| 平台 | 只保留 | 用途 |
| --- | --- | --- |
| Cloudflare Worker | `sync-dispatch-dev` | dev Telegram 和 dev 飞书共用同一个入口 |
| GitHub sync workflow | `.github/workflows/sync-dev.yml` | 同一个 workflow 内判断走 Telegram 还是飞书 |
| GitHub Worker deploy workflow | `.github/workflows/deploy-cloudflare-worker-dev.yml` | 只负责部署 `sync-dispatch-dev` 和刷新 dev Telegram webhook |
| Wrangler 配置 | `wrangler.dev.toml` | 只部署 `cloudflare/sync-dispatch-worker.mjs` |

dev Pages 预览仍由 `.github/workflows/deploy-cloudflare-pages-dev.yml` 负责，它是站点预览部署，不是 Telegram/飞书同步入口。

## 入口地址

| 渠道 | 填在哪里 | 地址 |
| --- | --- | --- |
| Telegram dev webhook | GitHub Variable `DEV_TELEGRAM_WEBHOOK_URL` | `https://sync-dispatch-dev.1406221797.workers.dev/` |
| 飞书 dev Request URL | 飞书开放平台事件订阅 | `https://feishu-dev.soulgo.chat` |

不要给 Telegram 填 `feishu-dev.soulgo.chat`。这个自定义域名只给飞书 dev 用。

## 1. GitHub 只配置这些参数

进入 GitHub 仓库：

```text
Settings -> Secrets and variables -> Actions
```

### 1.1 Secrets

| Secret | 必填 | 值 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | 是 | Cloudflare API Token，用于部署 `sync-dispatch-dev` |
| `CLOUDFLARE_ACCOUNT_ID` | 是 | Cloudflare Account ID |
| `AI_API_KEY` | 是 | 图片识别和 `/analysis` 使用的 AI Key |
| `DEV_TRAINING_DB_URL` | 是 | dev PostgreSQL 连接串 |
| `DEV_TELEGRAM_BOT_TOKEN` | 是 | dev Telegram Bot token |
| `DEV_TELEGRAM_SECRET_TOKEN` | 是 | dev Telegram webhook secret，必须和 Cloudflare `TELEGRAM_SECRET_TOKEN` 完全一致 |
| `DEV_FEISHU_APP_ID` | 飞书 dev 独立应用时必填 | dev 飞书应用 App ID |
| `DEV_FEISHU_APP_SECRET` | 飞书 dev 独立应用时必填 | dev 飞书应用 App Secret |
| `TELEGRAM_RECOGNITION_FALLBACK_API_KEY` | 否 | 图片识别备用 AI Key |

如果 dev 飞书复用生产飞书应用，可以不填 `DEV_FEISHU_APP_ID` / `DEV_FEISHU_APP_SECRET`，workflow 会回退到 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`。如果你要“dev 完全一套独立配置”，就填 `DEV_FEISHU_*`。

`DEV_TELEGRAM_SECRET_TOKEN` 可以这样生成：

```bash
openssl rand -hex 32
```

### 1.2 Variables

| Variable | 必填 | 值 |
| --- | --- | --- |
| `DEV_TELEGRAM_WEBHOOK_URL` | 是 | `https://sync-dispatch-dev.1406221797.workers.dev/` |
| `AI_BASE_URL` | 是 | AI 服务 base URL |
| `AI_MODEL` | 是 | 默认 AI 模型 |
| `AI_PROVIDER` | 否 | 不填时默认 `openai-compatible` |
| `AI_TIMEOUT_MS` | 否 | AI 请求超时 |
| `AI_CONCURRENCY` | 否 | 图片识别并发 |
| `TRAINING_DB_TIMEOUT_MS` | 否 | DB 连接超时 |
| `TRAINING_SNAPSHOT_SOURCE` | 建议填 | 建议 `database` |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Telegram dev 建议填 | 允许使用 dev Bot 的 Telegram chat id |
| `TELEGRAM_POLL_LIMIT` | 否 | webhook 模式通常不用改 |
| `DEV_TRAINING_DB_APP_NAME` | 否 | 可填 `training-records-dev` |
| `DEV_FEISHU_ALLOWED_CHAT_IDS` | 飞书 dev 建议填 | dev 飞书 chat 白名单 |
| `TELEGRAM_RECOGNITION_MODEL` | 否 | 图片识别模型覆盖 |
| `TELEGRAM_RECOGNITION_FALLBACK_BASE_URL` | 否 | 备用 AI base URL |
| `TELEGRAM_RECOGNITION_FALLBACK_MODEL` | 否 | 备用 AI 模型 |
| `TELEGRAM_RECOGNITION_FALLBACK_TIMEOUT_MS` | 否 | 备用 AI 超时 |
| `TELEGRAM_RECOGNITION_CACHE_ENABLED` | 否 | 是否启用识别缓存 |
| `TRAINING_ANALYSIS_GOAL` | 否 | `/analysis` 长期目标 |
| `CLOUDFLARE_PAGES_DEV_PROJECT_NAME` | 否 | 不填时使用 `training-records-dev` |

## 2. Cloudflare 只配置这一个 Worker

Cloudflare Worker 名称：

```text
sync-dispatch-dev
```

`wrangler.dev.toml` 最终形态：

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
```

部署方式二选一：

```bash
npx wrangler deploy --config wrangler.dev.toml
```

或在 GitHub Actions 手动运行：

```text
Deploy Cloudflare Worker (Dev)
```

部署成功后应看到两个触发入口：

```text
https://sync-dispatch-dev.1406221797.workers.dev
feishu-dev.soulgo.chat
```

## 3. Cloudflare Worker Secrets

进入：

```text
Cloudflare Dashboard -> Workers & Pages -> sync-dispatch-dev -> Settings -> Variables and Secrets
```

只在 `sync-dispatch-dev` 上配置这些 Secret：

| Secret | 必填 | 值 |
| --- | --- | --- |
| `GITHUB_TOKEN` | 是 | GitHub PAT，用于调用 `repository_dispatch` |
| `TELEGRAM_BOT_TOKEN` | 是 | 和 GitHub `DEV_TELEGRAM_BOT_TOKEN` 同值 |
| `TELEGRAM_SECRET_TOKEN` | 是 | 和 GitHub `DEV_TELEGRAM_SECRET_TOKEN` 同值 |
| `FEISHU_ENCRYPT_KEY` | 飞书 dev 必填 | 飞书 dev 应用事件订阅 Encrypt Key |
| `FEISHU_VERIFICATION_TOKEN` | 飞书 dev 必填 | 飞书 dev 应用事件订阅 Verification Token |

CLI 写入方式：

```bash
npx wrangler secret put GITHUB_TOKEN --config wrangler.dev.toml
npx wrangler secret put TELEGRAM_BOT_TOKEN --config wrangler.dev.toml
npx wrangler secret put TELEGRAM_SECRET_TOKEN --config wrangler.dev.toml
npx wrangler secret put FEISHU_ENCRYPT_KEY --config wrangler.dev.toml
npx wrangler secret put FEISHU_VERIFICATION_TOKEN --config wrangler.dev.toml
```

不要在 Cloudflare Dashboard 额外新增 `GITHUB_DISPATCH_EVENT_TYPE`。dev 统一 Worker 已经通过 `wrangler.dev.toml` 固定使用：

```text
GITHUB_DISPATCH_EVENT_TYPE_TELEGRAM=telegram_update_dev
GITHUB_DISPATCH_EVENT_TYPE_FEISHU=feishu_update_dev
```

## 4. Telegram dev 配置

GitHub Variable：

```text
DEV_TELEGRAM_WEBHOOK_URL=https://sync-dispatch-dev.1406221797.workers.dev/
```

然后手动运行 GitHub Actions：

```text
Deploy Cloudflare Worker (Dev)
```

这个 workflow 会：

1. 部署 `sync-dispatch-dev`
2. 使用 `DEV_TELEGRAM_BOT_TOKEN`
3. 使用 `DEV_TELEGRAM_WEBHOOK_URL`
4. 使用 `DEV_TELEGRAM_SECRET_TOKEN`
5. 刷新 dev Telegram webhook

## 5. 飞书 dev 配置

飞书开放平台 dev 应用：

```text
开发配置 -> 事件与回调 -> Request URL
```

填写：

```text
https://feishu-dev.soulgo.chat
```

保存前确认 Cloudflare `sync-dispatch-dev` 已配置：

```text
FEISHU_ENCRYPT_KEY
FEISHU_VERIFICATION_TOKEN
```

## 6. 最终验证

### 6.1 Worker 路由

```bash
curl -i https://sync-dispatch-dev.1406221797.workers.dev/
curl -i https://feishu-dev.soulgo.chat
```

预期都是：

```text
405 method_not_allowed
```

未知 POST：

```bash
curl -i -X POST https://sync-dispatch-dev.1406221797.workers.dev/ \
  -H 'content-type: application/json' \
  --data '{"hello":"world"}'
```

预期：

```text
400 unknown_channel
```

### 6.2 GitHub Actions

Telegram dev 发消息后，只应触发：

```text
Sync (Dev)
```

飞书 dev 发消息后，也只应触发：

```text
Sync (Dev)
```

区别只在 workflow 内部判断出的 channel：

```text
telegram -> npm run sync:telegram
feishu   -> npm run sync:feishu
```

## 7. 可以删除或停用的旧 dev 资源

确认上面验证通过后，只保留新入口。旧 dev 资源可以删除或停用：

| 平台 | 删除 / 停用 |
| --- | --- |
| Cloudflare Worker | `telegram-sync-dispatch-dev` |
| Cloudflare Worker | `feishu-sync-dispatch-dev` |
| GitHub workflow | `.github/workflows/telegram-sync-dev.yml` |
| GitHub workflow | `.github/workflows/feishu-sync-dev.yml` |
| GitHub workflow | `.github/workflows/deploy-cloudflare-feishu-worker-dev.yml` |
| Wrangler config | `wrangler.feishu-dev.toml` |

删除旧 Cloudflare Worker 前，先确认：

- Telegram webhook 已指向 `https://sync-dispatch-dev.1406221797.workers.dev/`
- 飞书 dev Request URL 已指向 `https://feishu-dev.soulgo.chat`
- `feishu-dev.soulgo.chat` 没有绑定在旧 Worker 上

## 8. 一句话总表

| 要配的地方 | 最终值 |
| --- | --- |
| Cloudflare Worker | `sync-dispatch-dev` |
| Telegram dev webhook | `https://sync-dispatch-dev.1406221797.workers.dev/` |
| 飞书 dev Request URL | `https://feishu-dev.soulgo.chat` |
| GitHub 同步 Action | `Sync (Dev)` / `.github/workflows/sync-dev.yml` |
| GitHub Worker 部署 Action | `Deploy Cloudflare Worker (Dev)` / `.github/workflows/deploy-cloudflare-worker-dev.yml` |
| Telegram dispatch type | `telegram_update_dev` |
| 飞书 dispatch type | `feishu_update_dev` |
