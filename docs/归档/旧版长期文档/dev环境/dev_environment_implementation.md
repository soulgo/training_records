# Dev 环境搭建步骤

> 当前 dev 环境已合并 Telegram 和飞书入口：Cloudflare 只保留统一 Worker `sync-dispatch-dev`，GitHub Actions 只保留统一同步 workflow `.github/workflows/sync-dev.yml`。

## 前置准备

- 已登录 @BotFather（Telegram 内搜索）
- 已登录 Cloudflare Dashboard
- 已登录 GitHub 仓库 Settings 页面
- 已准备 PostgreSQL dev 数据库连接串
- 已准备飞书 dev 应用或确认 dev 复用生产飞书应用配置

## 步骤 1：创建 Dev Telegram Bot

1. 在 Telegram 中打开 @BotFather，发送 `/newbot`。
2. 按提示设置 Bot 名称和用户名。
3. 保存 BotFather 返回的 token，后续作为 GitHub Secret `DEV_TELEGRAM_BOT_TOKEN`，也要写入 Cloudflare Worker Secret `TELEGRAM_BOT_TOKEN`。

## 步骤 2：创建 Dev PostgreSQL 数据库

示例：

```sql
CREATE DATABASE training_records_dev OWNER training_writer;
```

初始化 schema：

```bash
psql -U training_writer -d training_records_dev -f sql/pgsql17.sql
```

后续把连接串写入 GitHub Secret `DEV_TRAINING_DB_URL`。

## 步骤 3：配置 GitHub Actions

在 GitHub 仓库 `Settings -> Secrets and variables -> Actions` 配置。

### Secrets

| Secret | 用途 |
| --- | --- |
| `DEV_TELEGRAM_BOT_TOKEN` | Dev Telegram Bot token |
| `DEV_TELEGRAM_SECRET_TOKEN` | Telegram webhook secret，需要与 Cloudflare `TELEGRAM_SECRET_TOKEN` 一致 |
| `DEV_TRAINING_DB_URL` | Dev PostgreSQL 连接串 |
| `DEV_FEISHU_APP_ID` | 可选；dev 飞书应用 App ID，未配置时回退 `FEISHU_APP_ID` |
| `DEV_FEISHU_APP_SECRET` | 可选；dev 飞书应用 App Secret，未配置时回退 `FEISHU_APP_SECRET` |
| `CLOUDFLARE_API_TOKEN` | Wrangler 部署 Worker |
| `CLOUDFLARE_ACCOUNT_ID` | Wrangler 部署账号 |

`DEV_TELEGRAM_SECRET_TOKEN` 可用下面命令生成：

```bash
openssl rand -hex 32
```

### Variables

| Variable | 用途 |
| --- | --- |
| `DEV_TELEGRAM_WEBHOOK_URL` | `https://feishu-dev.soulgo.chat/telegram` |
| `DEV_TRAINING_DB_APP_NAME` | 可选，例如 `training-records-dev` |
| `DEV_FEISHU_ALLOWED_CHAT_IDS` | 可选；未配置时回退 `FEISHU_ALLOWED_CHAT_IDS` |
| `CLOUDFLARE_PAGES_DEV_PROJECT_NAME` | 可选；未配置时使用 `training-records-dev` |

`/telegram` 路径只用于区分 Telegram webhook 配置；统一 Worker 仍按 Telegram secret header 和飞书请求体结构判断渠道。

## 步骤 4：复核统一 Worker 配置

`wrangler.dev.toml` 应指向统一 Worker：

```toml
name = "sync-dispatch-dev"
main = "cloudflare/sync-dispatch-worker.mjs"
workers_dev = true
routes = [
  { pattern = "feishu-dev.soulgo.chat", custom_domain = true }
]

[vars]
GITHUB_DISPATCH_EVENT_TYPE_TELEGRAM = "telegram_update_dev"
GITHUB_DISPATCH_EVENT_TYPE_FEISHU = "feishu_update_dev"
```

并同时绑定：

- `TELEGRAM_ALBUM_BUFFER`
- `FEISHU_IMAGE_BUFFER`

统一入口 `cloudflare/sync-dispatch-worker.mjs` 会按请求头和飞书 body 结构判断来源：

- Telegram：`X-Telegram-Bot-Api-Secret-Token`
- 飞书明文：`X-Lark-*`
- 飞书 URL verification / 加密事件：body 中的 `url_verification` 或 `encrypt`

## 步骤 5：部署统一 Dev Worker

本地部署：

```bash
npx wrangler deploy --config wrangler.dev.toml
```

或在 GitHub Actions 手动运行：

```text
Deploy Cloudflare Worker (Dev)
```

部署成功后记录 workers.dev URL，形如：

```text
https://sync-dispatch-dev.<你的Workers子域名>.workers.dev/
```

Dev Telegram webhook 推荐使用自定义域路径：

```text
https://feishu-dev.soulgo.chat/telegram
```

## 步骤 6：配置 Cloudflare Worker Secrets

在 Cloudflare Dashboard 的 `sync-dispatch-dev -> Settings -> Variables and Secrets` 配置：

| Secret | 用途 |
| --- | --- |
| `GITHUB_TOKEN` | 调用 GitHub repository_dispatch 的 PAT |
| `TELEGRAM_BOT_TOKEN` | Dev Telegram Bot token |
| `TELEGRAM_SECRET_TOKEN` | 必须等于 GitHub `DEV_TELEGRAM_SECRET_TOKEN` |
| `FEISHU_ENCRYPT_KEY` | 飞书事件订阅 Encrypt Key |
| `FEISHU_VERIFICATION_TOKEN` | 飞书事件订阅 Verification Token |

也可以用 CLI 写入：

```bash
npx wrangler secret put GITHUB_TOKEN --config wrangler.dev.toml
npx wrangler secret put TELEGRAM_BOT_TOKEN --config wrangler.dev.toml
npx wrangler secret put TELEGRAM_SECRET_TOKEN --config wrangler.dev.toml
npx wrangler secret put FEISHU_ENCRYPT_KEY --config wrangler.dev.toml
npx wrangler secret put FEISHU_VERIFICATION_TOKEN --config wrangler.dev.toml
```

## 步骤 7：刷新 Dev Telegram Webhook

推荐在 GitHub Actions 手动运行 `Deploy Cloudflare Worker (Dev)`。该 workflow 部署统一 Worker 后会自动执行：

```bash
npm run telegram:webhook
```

本地手动兜底：

```bash
TELEGRAM_BOT_TOKEN="DEV_TELEGRAM_BOT_TOKEN" \
TELEGRAM_WEBHOOK_URL="https://feishu-dev.soulgo.chat/telegram" \
TELEGRAM_SECRET_TOKEN="DEV_TELEGRAM_SECRET_TOKEN" \
npm run telegram:webhook
```

## 步骤 8：配置飞书 Dev Request URL

飞书 dev 应用的事件订阅 Request URL 填：

```text
https://feishu-dev.soulgo.chat
```

保存前确认统一 Worker 已配置 `FEISHU_ENCRYPT_KEY` 和 `FEISHU_VERIFICATION_TOKEN`。飞书保存 Request URL 时会立即发送 URL verification，统一 Worker 会识别飞书 body 后转交给 Feishu handler。

## 步骤 9：复核统一 Sync Workflow

`.github/workflows/sync-dev.yml` 是 dev 唯一同步 workflow：

- `repository_dispatch` 监听 `telegram_update_dev` 和 `feishu_update_dev`。
- `workflow_dispatch.inputs.channel` 可手动选择 `telegram` 或 `feishu`。
- checkout 固定 `ref: dev`。
- 数据库固定使用 `DEV_TRAINING_DB_URL`。
- Telegram 使用 `DEV_TELEGRAM_BOT_TOKEN`。
- 飞书优先使用 `DEV_FEISHU_APP_ID` / `DEV_FEISHU_APP_SECRET` / `DEV_FEISHU_ALLOWED_CHAT_IDS`，未配置时回退生产飞书配置。
- 同步后只提交 `训练记录.md source/_posts source/images`。
- 文件变化或 DB-only 内容变化时异步触发 `deploy-cloudflare-pages-dev.yml`。

## 步骤 10：验证

1. Telegram dev 发送 `/help`，应由 Worker 直接回复，不触发 GitHub Actions。
2. Telegram dev 发送文字或图片，应触发 `Sync (Dev)`，channel 为 `telegram`。
3. 飞书 dev 保存 Request URL，应通过 URL verification。
4. 飞书 dev 发送 `/帮助` 或图片，应触发 `Sync (Dev)`，channel 为 `feishu`。
5. 连接 `training_records_dev`，确认数据写入 dev 数据库。
6. 如果同步只改数据库，也应触发 `deploy-cloudflare-pages-dev.yml`。

## 配置速查

| 配置项 | 位置 | 类型 |
| --- | --- | --- |
| `DEV_TELEGRAM_BOT_TOKEN` | GitHub Secrets | 必填 |
| `DEV_TELEGRAM_SECRET_TOKEN` | GitHub Secrets | 必填 |
| `DEV_TRAINING_DB_URL` | GitHub Secrets | 必填 |
| `DEV_TELEGRAM_WEBHOOK_URL` | GitHub Variables | 必填 |
| `GITHUB_TOKEN` | Cloudflare `sync-dispatch-dev` Secrets | 必填 |
| `TELEGRAM_BOT_TOKEN` | Cloudflare `sync-dispatch-dev` Secrets | 必填 |
| `TELEGRAM_SECRET_TOKEN` | Cloudflare `sync-dispatch-dev` Secrets | 必填 |
| `FEISHU_ENCRYPT_KEY` | Cloudflare `sync-dispatch-dev` Secrets | 飞书 dev 必填 |
| `FEISHU_VERIFICATION_TOKEN` | Cloudflare `sync-dispatch-dev` Secrets | 飞书 dev 必填 |
| `GITHUB_DISPATCH_EVENT_TYPE_TELEGRAM` | `wrangler.dev.toml` | 固定 `telegram_update_dev` |
| `GITHUB_DISPATCH_EVENT_TYPE_FEISHU` | `wrangler.dev.toml` | 固定 `feishu_update_dev` |

## 日常使用

1. 在 `dev` 分支修改代码。
2. 用 Telegram dev 或飞书 dev 发送测试消息，触发 `Sync (Dev)`。
3. 本地运行 `npm test`。
4. push 到 `dev` 后等待 `Deploy Cloudflare Pages (Dev)` 完成。
5. 访问 `https://training-records-dev.pages.dev` 验证预览。
