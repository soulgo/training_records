# Dev 统一入口 GitHub 与 Cloudflare 配置清单

本文只写 dev 当前配置。完整参数解释见 [GitHub 与 Cloudflare 配置](GitHub与Cloudflare配置.md)。

dev 当前只保留一个消息入口：

```text
Telegram dev / 飞书 dev
-> Cloudflare Worker sync-dispatch-dev
-> .github/workflows/sync-dev.yml
-> workflow 内判断 channel
-> npm run sync:telegram 或 npm run sync:feishu
```

## 1. 需要配置的参数

### 1.1 GitHub Actions Secrets

进入：

```text
Settings -> Secrets and variables -> Actions -> Secrets
```

| Secret | 必填 | 说明 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | 是 | 部署 `sync-dispatch-dev` |
| `CLOUDFLARE_ACCOUNT_ID` | 是 | Cloudflare account |
| `CLOUDFLARE_PAGES_API_TOKEN` | 是 | 上传 dev Cloudflare Pages |
| `AI_API_KEY` | 是 | 图片识别和 `/分析` |
| `DEV_TRAINING_DB_URL` | 是 | dev PostgreSQL 连接串 |
| `DEV_TELEGRAM_BOT_TOKEN` | 是 | dev Telegram Bot token |
| `DEV_TELEGRAM_SECRET_TOKEN` | 是 | dev Telegram webhook secret，必须和 Cloudflare Worker `TELEGRAM_SECRET_TOKEN` 一致 |
| `DEV_FEISHU_APP_ID` | 独立 dev 飞书应用时填 | 未填时 workflow 回退 `FEISHU_APP_ID` |
| `DEV_FEISHU_APP_SECRET` | 独立 dev 飞书应用时填 | 未填时 workflow 回退 `FEISHU_APP_SECRET` |
| `FEISHU_APP_ID` | dev 飞书未独立时必填 | 生产飞书应用 App ID |
| `FEISHU_APP_SECRET` | dev 飞书未独立时必填 | 生产飞书应用 App Secret |
| `TELEGRAM_RECOGNITION_FALLBACK_API_KEY` | 否 | 图片识别备用 AI Key |

### 1.2 GitHub Actions Variables

| Variable | 必填 | 建议值 / 说明 |
| --- | --- | --- |
| `DEV_TELEGRAM_WEBHOOK_URL` | 是 | `https://feishu-dev.soulgo.chat/telegram` |
| `AI_BASE_URL` | 是 | AI base URL |
| `AI_MODEL` | 是 | 默认 AI 模型 |
| `AI_PROVIDER` | 否 | 默认 `openai-compatible` |
| `AI_TIMEOUT_MS` | 否 | AI 请求超时 |
| `AI_CONCURRENCY` | 否 | 图片识别并发 |
| `TRAINING_DB_TIMEOUT_MS` | 否 | DB 连接超时 |
| `TRAINING_SNAPSHOT_SOURCE` | 建议填 | 建议 `database` |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Telegram dev 建议填 | 允许使用 dev Bot 的 Telegram chat id |
| `TELEGRAM_POLL_LIMIT` | 否 | webhook 模式通常不用改 |
| `DEV_TRAINING_DB_APP_NAME` | 否 | 可填 `training-records-dev`；飞书 dev 未填时临时用 `sync-dev-feishu` |
| `DEV_FEISHU_ALLOWED_CHAT_IDS` | 飞书 dev 建议填 | 未填时 workflow 回退 `FEISHU_ALLOWED_CHAT_IDS` |
| `FEISHU_ALLOWED_CHAT_IDS` | dev 飞书未独立时必填 | 生产飞书 chat 白名单 |
| `TELEGRAM_RECOGNITION_MODEL` | 否 | 图片识别模型覆盖 |
| `TELEGRAM_RECOGNITION_FALLBACK_BASE_URL` | 否 | 备用 AI base URL |
| `TELEGRAM_RECOGNITION_FALLBACK_MODEL` | 否 | 备用 AI 模型 |
| `TELEGRAM_RECOGNITION_FALLBACK_TIMEOUT_MS` | 否 | 备用 AI 超时 |
| `TELEGRAM_RECOGNITION_CACHE_ENABLED` | 否 | 是否启用识别缓存 |
| `TRAINING_ANALYSIS_GOAL` | 否 | `/分析` 长期目标 |
| `CLOUDFLARE_PAGES_DEV_PROJECT_NAME` | 否 | 默认 `training-records-dev` |

### 1.3 Cloudflare Worker Secrets

进入：

```text
Cloudflare Dashboard -> Workers & Pages -> sync-dispatch-dev -> Settings -> Variables and Secrets
```

| Secret | 必填 | 说明 |
| --- | --- | --- |
| `GITHUB_TOKEN` | 是 | PAT，用于调用 GitHub `repository_dispatch` |
| `TELEGRAM_BOT_TOKEN` | 是 | 和 GitHub `DEV_TELEGRAM_BOT_TOKEN` 同值 |
| `TELEGRAM_SECRET_TOKEN` | 是 | 和 GitHub `DEV_TELEGRAM_SECRET_TOKEN` 同值 |
| `FEISHU_ENCRYPT_KEY` | 飞书 dev 必填 | 飞书事件订阅 Encrypt Key |
| `FEISHU_VERIFICATION_TOKEN` | 飞书 dev 必填 | 飞书事件订阅 Verification Token |

CLI 写入：

```bash
npx wrangler secret put GITHUB_TOKEN --config wrangler.dev.toml
npx wrangler secret put TELEGRAM_BOT_TOKEN --config wrangler.dev.toml
npx wrangler secret put TELEGRAM_SECRET_TOKEN --config wrangler.dev.toml
npx wrangler secret put FEISHU_ENCRYPT_KEY --config wrangler.dev.toml
npx wrangler secret put FEISHU_VERIFICATION_TOKEN --config wrangler.dev.toml
```

### 1.4 Wrangler 固定配置

`wrangler.dev.toml` 必须指向统一 Worker：

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

不要在 Cloudflare Dashboard 额外新增 `GITHUB_DISPATCH_EVENT_TYPE` 覆盖它。

## 2. 参数解释

- `DEV_TELEGRAM_WEBHOOK_URL` 填给 Telegram setWebhook，路径可以是 `/telegram`；Worker 实际按 Telegram secret header 判断 channel。
- 飞书 dev Request URL 填 `https://feishu-dev.soulgo.chat`；飞书会在保存时发 URL verification，必须先配好 `FEISHU_ENCRYPT_KEY` 和 `FEISHU_VERIFICATION_TOKEN`。
- `sync-dev.yml` 固定 checkout `dev`，固定 `TRAINING_DB_ENABLED=true`，数据库连接使用 `DEV_TRAINING_DB_URL`。
- 手动运行 `Sync (Dev)` 时用 `channel=telegram|feishu`；webhook 触发时由 event type 决定 channel。
- 飞书 dev 可以用独立应用，也可以回退生产飞书应用；独立验证更清晰，回退配置更少。
- dev Pages 预览由 `.github/workflows/deploy-cloudflare-pages-dev.yml` 负责，不是消息入口。

## 3. 部署

部署 Worker：

```bash
npx wrangler deploy --config wrangler.dev.toml
```

或在 GitHub Actions 手动运行：

```text
Deploy Cloudflare Worker (Dev)
```

这个 workflow 会：

1. 部署 `sync-dispatch-dev`。
2. 使用 `DEV_TELEGRAM_BOT_TOKEN`、`DEV_TELEGRAM_WEBHOOK_URL`、`DEV_TELEGRAM_SECRET_TOKEN`。
3. 刷新 dev Telegram webhook。

部署 dev Pages：

```text
Deploy Cloudflare Pages (Dev)
```

该 workflow 会构建 dev 数据库快照，删除 `public/CNAME`，再上传到 Cloudflare Pages 项目。

## 4. 验证

Worker 探测：

```bash
curl -i https://sync-dispatch-dev.1406221797.workers.dev/
curl -i https://feishu-dev.soulgo.chat/telegram
curl -i https://feishu-dev.soulgo.chat
```

预期 `GET` 返回：

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

GitHub Actions 验证：

| 操作 | 只应触发 | workflow 内 channel |
| --- | --- | --- |
| Telegram dev 发消息 | `Sync (Dev)` | `telegram` |
| 飞书 dev 发消息 | `Sync (Dev)` | `feishu` |

本地配置测试：

```bash
node --test test/github-workflows.test.mjs test/cloudflare-config.test.mjs
```

## 5. 可以删除或停用的旧 dev 资源

确认上面验证通过后，旧 dev 资源不要再作为当前入口维护：

| 平台 | 旧资源 |
| --- | --- |
| Cloudflare Worker | `telegram-sync-dispatch-dev` |
| Cloudflare Worker | `feishu-sync-dispatch-dev` |
| GitHub workflow | `.github/workflows/telegram-sync-dev.yml` |
| GitHub workflow | `.github/workflows/feishu-sync-dev.yml` |
| GitHub workflow | `.github/workflows/deploy-cloudflare-feishu-worker-dev.yml` |
| Wrangler config | `wrangler.feishu-dev.toml` |

删除旧 Cloudflare Worker 前，确认：

- Telegram webhook 已指向 `https://feishu-dev.soulgo.chat/telegram`。
- 飞书 dev Request URL 已指向 `https://feishu-dev.soulgo.chat`。
- `feishu-dev.soulgo.chat` 没有绑定在旧 Worker 上。
