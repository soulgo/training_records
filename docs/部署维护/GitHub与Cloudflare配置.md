# GitHub 与 Cloudflare 配置

本文是当前 main/dev 的配置入口。先按清单配置参数，再读后面的参数解释和运行链路。

当前事实：

- main：Telegram 和飞书共用 Cloudflare Worker `feishu-sync-dispatch`，进入 `.github/workflows/sync.yml`。
- dev：Telegram 和飞书共用 Cloudflare Worker `sync-dispatch-dev`，进入 `.github/workflows/sync-dev.yml`。
- Worker 只负责接收 webhook、判断 channel、触发 GitHub `repository_dispatch`；真正同步在 GitHub Actions 里执行。
- 生产站点由 GitHub Pages 部署；dev 预览由 Cloudflare Pages Direct Upload 部署。

## 1. 需要配置的参数

### 1.1 GitHub Actions Secrets

进入 GitHub 仓库：

```text
Settings -> Secrets and variables -> Actions -> Secrets
```

| Secret | main | dev | 用途 |
| --- | --- | --- | --- |
| `AI_API_KEY` | 必填 | 共用 | 图片识别和 `/分析` 的 AI Key |
| `TRAINING_DB_URL` | 必填 | 不用 | main PostgreSQL 连接串 |
| `DEV_TRAINING_DB_URL` | 不用 | 必填 | dev PostgreSQL 连接串 |
| `TELEGRAM_BOT_TOKEN` | 必填 | 不用 | main Telegram Bot |
| `DEV_TELEGRAM_BOT_TOKEN` | 不用 | 必填 | dev Telegram Bot |
| `TELEGRAM_SECRET_TOKEN` | 必填 | 不用 | main Telegram webhook secret，用于刷新 webhook |
| `DEV_TELEGRAM_SECRET_TOKEN` | 不用 | 必填 | dev Telegram webhook secret，用于刷新 webhook |
| `FEISHU_APP_ID` | 必填 | 可回退使用 | 飞书应用 App ID |
| `FEISHU_APP_SECRET` | 必填 | 可回退使用 | 飞书应用 App Secret |
| `DEV_FEISHU_APP_ID` | 不用 | 独立 dev 应用时填 | dev 飞书应用 App ID |
| `DEV_FEISHU_APP_SECRET` | 不用 | 独立 dev 应用时填 | dev 飞书应用 App Secret |
| `CLOUDFLARE_API_TOKEN` | 必填 | 必填 | Wrangler 部署 Worker |
| `CLOUDFLARE_ACCOUNT_ID` | 必填 | 必填 | Cloudflare account |
| `CLOUDFLARE_PAGES_API_TOKEN` | 不用 | 必填 | dev Cloudflare Pages Direct Upload |
| `TELEGRAM_RECOGNITION_FALLBACK_API_KEY` | 可选 | 共用 | 图片识别备用 AI provider |

### 1.2 GitHub Actions Variables

进入：

```text
Settings -> Secrets and variables -> Actions -> Variables
```

| Variable | main | dev | 建议值 / 用途 |
| --- | --- | --- | --- |
| `TRAINING_DB_ENABLED` | 必填 | 固定由 workflow 设为 `true` | main 建议 `true` |
| `TRAINING_DB_TIMEOUT_MS` | 可选 | 可选 | DB 连接超时，默认 `5000` |
| `TRAINING_DB_APP_NAME` | 可选 | 不用 | main DB 连接 app name |
| `DEV_TRAINING_DB_APP_NAME` | 不用 | 可选 | dev DB 连接 app name；飞书 dev 未填时 workflow 临时用 `sync-dev-feishu` |
| `TRAINING_SNAPSHOT_SOURCE` | 建议填 | 建议填 | 线上建议 `database` |
| `AI_PROVIDER` | 可选 | 共用 | 默认 `openai-compatible` |
| `AI_BASE_URL` | 必填 | 共用 | AI OpenAI-compatible base URL |
| `AI_MODEL` | 必填 | 共用 | 默认识别/分析模型 |
| `AI_TIMEOUT_MS` | 可选 | 共用 | AI 请求超时 |
| `AI_CONCURRENCY` | 可选 | 共用 | 图片识别并发，代码默认 `3` |
| `TELEGRAM_ALLOWED_CHAT_IDS` | 必填 | dev Telegram 建议填 | Telegram chat 白名单 |
| `TELEGRAM_POLL_LIMIT` | 可选 | 可选 | poll 模式 limit；workflow webhook 模式通常不用改 |
| `TELEGRAM_WEBHOOK_URL` | 必填 | 不用 | main Telegram webhook URL，当前应指向统一 Worker 的 Telegram 路径 |
| `DEV_TELEGRAM_WEBHOOK_URL` | 不用 | 必填 | dev Telegram webhook URL，当前为 `https://feishu-dev.soulgo.chat/telegram` |
| `FEISHU_ALLOWED_CHAT_IDS` | 必填 | 可回退使用 | main 飞书 chat 白名单 |
| `DEV_FEISHU_ALLOWED_CHAT_IDS` | 不用 | 独立 dev 白名单时填 | dev 飞书 chat 白名单 |
| `TELEGRAM_RECOGNITION_MODEL` | 可选 | 共用 | Telegram/共享图片识别模型覆盖 |
| `TELEGRAM_RECOGNITION_FALLBACK_BASE_URL` | 可选 | 共用 | 备用 AI base URL |
| `TELEGRAM_RECOGNITION_FALLBACK_MODEL` | 可选 | 共用 | 备用 AI 模型 |
| `TELEGRAM_RECOGNITION_FALLBACK_TIMEOUT_MS` | 可选 | 共用 | 备用 AI 超时 |
| `TELEGRAM_RECOGNITION_CACHE_ENABLED` | 可选 | 共用 | 是否启用识别缓存 |
| `TRAINING_ANALYSIS_GOAL` | 可选 | 共用 | `/分析` 长期目标 |
| `CLOUDFLARE_PAGES_DEV_PROJECT_NAME` | 不用 | 可选 | dev Pages 项目名，默认 `training-records-dev` |

Markdown 备份 workflow 另有 Variables：

| Variable | 建议值 | 用途 |
| --- | --- | --- |
| `MARKDOWN_BACKUP_ENABLED` | `false`，确认后改 `true` | 是否启用定时 DB -> Markdown 备份 |
| `MARKDOWN_BACKUP_FREQUENCY` | `weekly` | `weekly` 或 `daily` |
| `MARKDOWN_BACKUP_BRANCH` | `main` | 备份提交目标分支 |
| `MARKDOWN_BACKUP_COMMIT` | `true` | 是否自动提交备份 |

### 1.3 Cloudflare Worker Secrets

进入：

```text
Cloudflare Dashboard -> Workers & Pages -> <Worker> -> Settings -> Variables and Secrets
```

| Secret | main Worker `feishu-sync-dispatch` | dev Worker `sync-dispatch-dev` | 用途 |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` | 必填 | 必填 | PAT，用于调用 GitHub `repository_dispatch` |
| `TELEGRAM_BOT_TOKEN` | 必填 | 必填 | Worker 直接回复 Telegram `/帮助` 和 dispatch 失败通知 |
| `TELEGRAM_SECRET_TOKEN` | 必填 | 必填 | 校验 Telegram webhook header |
| `FEISHU_ENCRYPT_KEY` | 必填 | dev 飞书启用时必填 | 飞书事件加密与签名校验 |
| `FEISHU_VERIFICATION_TOKEN` | 必填 | dev 飞书启用时必填 | 飞书 URL verification 和事件 token 校验 |

可选 Worker Variables / Secrets：

| 名称 | 默认值 | 用途 |
| --- | --- | --- |
| `GITHUB_OWNER` | `soulgo` | dispatch 目标 owner |
| `GITHUB_REPO` | `training_records` | dispatch 目标 repo |
| `GITHUB_API_BASE_URL` | `https://api.github.com` | GitHub API base URL |
| `TELEGRAM_API_BASE_URL` | `https://api.telegram.org` | Telegram API base URL |
| `FEISHU_EVENT_LOGGING` | `true` | 是否打印飞书事件元数据日志 |

### 1.4 Wrangler 配置中的固定参数

这些参数写在仓库配置里，不要在 Cloudflare Dashboard 再建同名覆盖项。

main `wrangler.toml`：

```toml
name = "feishu-sync-dispatch"
main = "cloudflare/sync-dispatch-worker.mjs"

[vars]
GITHUB_DISPATCH_EVENT_TYPE_TELEGRAM = "telegram_update"
GITHUB_DISPATCH_EVENT_TYPE_FEISHU = "feishu_update"
```

dev `wrangler.dev.toml`：

```toml
name = "sync-dispatch-dev"
main = "cloudflare/sync-dispatch-worker.mjs"

[vars]
GITHUB_DISPATCH_EVENT_TYPE_TELEGRAM = "telegram_update_dev"
GITHUB_DISPATCH_EVENT_TYPE_FEISHU = "feishu_update_dev"
```

两个 Worker 都需要 Durable Object binding：

| Binding | Class | 用途 |
| --- | --- | --- |
| `TELEGRAM_ALBUM_BUFFER` | `TelegramAlbumBuffer` | Telegram 连续图片缓冲 |
| `FEISHU_IMAGE_BUFFER` | `FeishuImageBuffer` | 飞书连续图片缓冲 |

### 1.5 外部平台参数

| 平台 | main | dev |
| --- | --- | --- |
| Telegram webhook URL | `TELEGRAM_WEBHOOK_URL` 指向 main 统一 Worker 的 Telegram 路径 | `DEV_TELEGRAM_WEBHOOK_URL=https://feishu-dev.soulgo.chat/telegram` |
| 飞书 Request URL | `https://feishu.soulgo.chat` | `https://feishu-dev.soulgo.chat` |
| GitHub Pages custom domain | `source/CNAME=soulgo.chat` | 不使用生产 CNAME |
| Cloudflare Pages project | 不使用 | `CLOUDFLARE_PAGES_DEV_PROJECT_NAME`，默认 `training-records-dev` |

## 2. 参数解释

### 2.1 GitHub Actions 参数

`sync.yml` 和 `sync-dev.yml` 的同步参数分三类：

1. 数据库参数：`TRAINING_DB_*` 决定是否写 PostgreSQL、连接哪个库、构建时是否从数据库生成页面。
2. AI 参数：`AI_*` 和 `TELEGRAM_RECOGNITION_*` 决定图片识别、备用 provider 和 `/分析`。
3. 通道参数：`TELEGRAM_*` 与 `FEISHU_*` 决定消息来源校验、白名单、图片下载和回执发送。

main workflow 使用生产 Secrets；dev workflow 使用 `DEV_*`，飞书 dev 未配置时回退生产飞书 App 凭据和白名单。

`TELEGRAM_SYNC_TRANSPORT` 与 `FEISHU_SYNC_TRANSPORT` 在 workflow 中固定为 `webhook`，不需要手工配置。

### 2.2 Cloudflare Worker 参数

统一 Worker 的职责很窄：

1. 只接受 `POST`。
2. 根据 Telegram secret header、飞书 Lark headers 或飞书请求体判断 channel。
3. Telegram 校验 `TELEGRAM_SECRET_TOKEN`。
4. 飞书校验 `FEISHU_ENCRYPT_KEY` 和 `FEISHU_VERIFICATION_TOKEN`。
5. 使用 `GITHUB_TOKEN` 调 GitHub `repository_dispatch`。

Worker 不做 AI 识别、不写数据库、不构建页面。

### 2.3 Dispatch event type

不要再配置旧的单一 `GITHUB_DISPATCH_EVENT_TYPE` 作为当前主路径。当前统一 Worker 用分渠道变量：

| 环境 | Telegram event type | Feishu event type | 接收 workflow |
| --- | --- | --- | --- |
| main | `telegram_update` | `feishu_update` | `.github/workflows/sync.yml` |
| dev | `telegram_update_dev` | `feishu_update_dev` | `.github/workflows/sync-dev.yml` |

## 3. 当前运行链路

### 3.1 main 同步

```text
Telegram / Feishu
-> Cloudflare Worker feishu-sync-dispatch
-> repository_dispatch telegram_update / feishu_update
-> .github/workflows/sync.yml
-> Determine sync channel
-> npm run sync:telegram 或 npm run sync:feishu
-> PostgreSQL / Markdown backup / async deploy
```

`sync.yml` 手动触发时也使用 `channel=telegram|feishu` 判断通道。

### 3.2 dev 同步

```text
Telegram dev / Feishu dev
-> Cloudflare Worker sync-dispatch-dev
-> repository_dispatch telegram_update_dev / feishu_update_dev
-> .github/workflows/sync-dev.yml
-> Determine sync channel
-> npm run sync:telegram 或 npm run sync:feishu
-> dev PostgreSQL / async dev Pages deploy
```

`sync-dev.yml` 手动触发时也使用 `channel=telegram|feishu`。

### 3.3 站点部署

| 环境 | Workflow | 部署目标 | 数据来源 |
| --- | --- | --- | --- |
| main | `.github/workflows/deploy-pages.yml` | GitHub Pages | `TRAINING_SNAPSHOT_SOURCE`，线上建议 `database` |
| dev | `.github/workflows/deploy-cloudflare-pages-dev.yml` | Cloudflare Pages | `DEV_TRAINING_DB_URL` + `TRAINING_SNAPSHOT_SOURCE` |

生产 Pages 部署成功后会自动尝试清理 Cloudflare 缓存；需要 GitHub Secrets 同时配置 `CLOUDFLARE_ZONE_ID` 和具备 `Zone -> Cache Purge -> Purge` 权限的 `CLOUDFLARE_API_TOKEN`。如果 secret 缺失或 token 权限不足，workflow 会输出 warning 但不会把 Pages deploy 标红，页面仍可能命中旧 HTML；可在 Cloudflare Dashboard -> Caching -> Purge Everything 手动刷新。

## 4. 部署和刷新

### 4.1 部署 main Worker

```bash
npx wrangler deploy --config wrangler.toml
```

或在 GitHub Actions 手动运行：

```text
Deploy Cloudflare Worker
```

该 workflow 会部署 `wrangler.toml` 指向的统一 Worker，并在部署后用 `TELEGRAM_WEBHOOK_URL` 刷新生产 Telegram webhook。

### 4.2 部署 dev Worker

```bash
npx wrangler deploy --config wrangler.dev.toml
```

或在 GitHub Actions 手动运行：

```text
Deploy Cloudflare Worker (Dev)
```

该 workflow 会部署 `sync-dispatch-dev`，并在部署后用 `DEV_TELEGRAM_WEBHOOK_URL` 刷新 dev Telegram webhook。

### 4.3 写入 Worker Secrets

main：

```bash
npx wrangler secret put GITHUB_TOKEN --config wrangler.toml
npx wrangler secret put TELEGRAM_BOT_TOKEN --config wrangler.toml
npx wrangler secret put TELEGRAM_SECRET_TOKEN --config wrangler.toml
npx wrangler secret put FEISHU_ENCRYPT_KEY --config wrangler.toml
npx wrangler secret put FEISHU_VERIFICATION_TOKEN --config wrangler.toml
```

dev：

```bash
npx wrangler secret put GITHUB_TOKEN --config wrangler.dev.toml
npx wrangler secret put TELEGRAM_BOT_TOKEN --config wrangler.dev.toml
npx wrangler secret put TELEGRAM_SECRET_TOKEN --config wrangler.dev.toml
npx wrangler secret put FEISHU_ENCRYPT_KEY --config wrangler.dev.toml
npx wrangler secret put FEISHU_VERIFICATION_TOKEN --config wrangler.dev.toml
```

## 5. 验证

### 5.1 Worker 路由

```bash
curl -i https://feishu.soulgo.chat
curl -i https://feishu-dev.soulgo.chat
```

预期 `GET` 返回 `405 method_not_allowed`。如果返回 DNS、TLS、404 或静态页面，优先检查 Cloudflare custom domain route。

未知 POST：

```bash
curl -i -X POST https://feishu-dev.soulgo.chat \
  -H 'content-type: application/json' \
  --data '{"hello":"world"}'
```

预期返回 `400 unknown_channel`。

### 5.2 GitHub Actions

| 操作 | 预期 workflow | 预期 channel |
| --- | --- | --- |
| main Telegram 发消息 | `Sync (Main)` | `telegram` |
| main 飞书发消息 | `Sync (Main)` | `feishu` |
| dev Telegram 发消息 | `Sync (Dev)` | `telegram` |
| dev 飞书发消息 | `Sync (Dev)` | `feishu` |

进入 run summary 检查：

- Telegram: `Telegram sync result`
- 飞书: `Feishu sync result`
- 重点看 `batchId`、`taskStatus`、`persistenceStatus`、`archivedDate`、图片计数、pending、`failureDisposition`、failed message ids。

### 5.3 本地文档/配置检查

```bash
node --test test/github-workflows.test.mjs test/cloudflare-config.test.mjs
git diff --check -- docs
```

## 6. 旧入口处理

以下资源不再作为当前 main/dev 入口：

| 旧口径 | 当前替代 |
| --- | --- |
| `.github/workflows/telegram-sync.yml` | `.github/workflows/sync.yml` |
| `.github/workflows/feishu-sync.yml` | `.github/workflows/sync.yml` |
| `.github/workflows/telegram-sync-dev.yml` | `.github/workflows/sync-dev.yml` |
| `.github/workflows/feishu-sync-dev.yml` | `.github/workflows/sync-dev.yml` |
| `wrangler.feishu.toml` / `wrangler.feishu-dev.toml` | `wrangler.toml` / `wrangler.dev.toml` |
| 独立 Telegram Worker + 独立 Feishu Worker | 统一 Worker `cloudflare/sync-dispatch-worker.mjs` |

历史方案可以留在 `docs/优化重构/`，但日常维护以本文、[日常维护手册](日常维护手册.md) 和 [系统总览](../系统架构/系统总览.md) 为准。
