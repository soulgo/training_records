# Main 环境配置

本文只说明 main 生产环境要在 GitHub Settings 和 Cloudflare 里配置什么。先按前两节填完，后面再看每个参数从哪里拿、有什么作用。

main 环境对应：

- Git 分支：`main`
- 同步 workflow：`.github/workflows/sync.yml`
- Pages workflow：`.github/workflows/deploy-pages.yml`
- Worker workflow：`.github/workflows/deploy-cloudflare-worker.yml`
- 备份 workflow：`.github/workflows/markdown-backup.yml`
- Worker 配置：`wrangler.toml`
- Worker 名称：`feishu-sync-dispatch`
- Worker 域名：`feishu.soulgo.chat`

## 1. GitHub Settings 必填清单

位置：GitHub 仓库 `Settings -> Secrets and variables -> Actions`。

### 1.1 Secrets

| Secret 名称 | 是否必填 | 用途 |
| --- | --- | --- |
| `TRAINING_DB_URL` | 必填 | 生产 PostgreSQL 连接串，同步、构建、Markdown 备份都读这个库。 |
| `TRAINING_DB_READONLY_URL` | 可选 | 生产只读 PostgreSQL 连接串；站点构建、数据库快照读取、Markdown 导出、巡检和一致性检查优先使用，未配置时回退 `TRAINING_DB_URL`。 |
| `TRAINING_DB_MIGRATION_URL` | 手动迁移时必填 | 生产迁移 PostgreSQL 连接串；只用于本地或显式维护环境执行 `npm run maintenance:migrate -- --confirm`，不注入日常同步 workflow。 |
| `AI_API_KEY` | 必填 | AI 服务鉴权。 |
| `TELEGRAM_BOT_TOKEN` | 必填 | 生产 Telegram Bot token，用于拉取消息、下载图片、通知结果、刷新 webhook。 |
| `TELEGRAM_SECRET_TOKEN` | 必填 | 生产 Telegram webhook secret。必须和 Cloudflare Worker Secret `TELEGRAM_SECRET_TOKEN` 的值一致。 |
| `FEISHU_APP_ID` | 必填 | 生产飞书应用 App ID。 |
| `FEISHU_APP_SECRET` | 必填 | 生产飞书应用 App Secret。 |
| `COS_SECRET_ID` | 启用 COS 时必填 | 生产腾讯云 COS SecretId。 |
| `COS_SECRET_KEY` | 启用 COS 时必填 | 生产腾讯云 COS SecretKey。 |
| `CLOUDFLARE_ACCOUNT_ID` | 部署 Cloudflare Worker 时必填 | Cloudflare account id。 |
| `CLOUDFLARE_API_TOKEN` | 必填 | 部署 Worker、清理 Cloudflare 缓存；也可用于 Pages。 |
| `CLOUDFLARE_PAGES_API_TOKEN` | 可选 | Pages / cache purge 专用 token；不填时使用 `CLOUDFLARE_API_TOKEN`。 |
| `CLOUDFLARE_ZONE_ID` | 必填 | 生产站点发布后清理 Cloudflare 缓存。 |
| `TELEGRAM_RECOGNITION_FALLBACK_API_KEY` | 可选 | 图片识别备用 AI provider 的 key。 |

### 1.2 Variables

| Variable 名称 | 建议值 / 示例 | 是否必填 | 用途 |
| --- | --- | --- | --- |
| `TRAINING_DB_ENABLED` | `true` | 必填 | 是否启用生产 PostgreSQL。 |
| `TRAINING_DB_TIMEOUT_MS` | `5000` | 建议填 | 数据库连接超时。 |
| `TRAINING_DB_APP_NAME` | `sync-main` | 建议填 | PostgreSQL `application_name`，便于在 DB 侧区分来源。 |
| `GITHUB_ACTION_MONITOR_REPORT_URL_MAIN` | main 监控 API base URL | 可选 | `Report Action Status` 在没有可用生产 PostgreSQL 连接时的 HTTP 兜底上报地址。 |
| `GITHUB_ACTION_MONITOR_REPORT_URL` | 共享监控 API base URL | 可选 | main/dev 专用 URL 未配置时的共享兜底地址。 |
| `GITHUB_ACTION_MONITOR_REPORT_URL_DEV` | dev 监控 API base URL | 可选 | 所有 workflow 都注入该变量；main 分支不会优先使用它。 |
| `TRAINING_DB_SCHEMA_PREFLIGHT_ENABLED` | `false` | 可选 | 过渡期 DDL preflight 开关；默认关闭，日常业务账号不应启用。 |
| `TRAINING_SNAPSHOT_SOURCE` | `database` | 建议填 | 构建站点时从数据库还是 Markdown 生成快照。 |
| `AI_PROVIDER` | `openai-compatible` | 建议填 | 当前代码支持 OpenAI-compatible provider。 |
| `AI_BASE_URL` | `https://.../v1` | 必填 | Chat Completions base URL。 |
| `AI_MODEL` | 例如 `gpt-4.1-mini` | 必填 | 默认 AI 模型。 |
| `AI_TIMEOUT_MS` | `60000` | 建议填 | AI 请求超时。 |
| `AI_CONCURRENCY` | `3` | 建议填 | 图片识别并发数。 |
| `TELEGRAM_RECOGNITION_MODEL` | 识别模型名 | 可选 | 只覆盖 Telegram/飞书图片识别模型；不填用 `AI_MODEL`。 |
| `TELEGRAM_RECOGNITION_CACHE_ENABLED` | `true` | 建议填 | 是否启用识别结果缓存。 |
| `TELEGRAM_RECOGNITION_FALLBACK_BASE_URL` | `https://.../v1` | 可选 | 备用 AI provider base URL。 |
| `TELEGRAM_RECOGNITION_FALLBACK_MODEL` | 模型名 | 可选 | 备用 AI provider 模型。 |
| `TELEGRAM_RECOGNITION_FALLBACK_TIMEOUT_MS` | `60000` | 可选 | 备用 AI 请求超时。 |
| `TELEGRAM_ALLOWED_CHAT_IDS` | 逗号分隔 chat id | 必填 | Telegram 白名单。 |
| `TELEGRAM_POLL_LIMIT` | `20` | 可选 | poll 模式拉取数量；main workflow 当前固定 webhook 模式。 |
| `TELEGRAM_WEBHOOK_URL` | `https://feishu.soulgo.chat/telegram` | 必填 | 刷新生产 Telegram webhook 的目标 URL。 |
| `FEISHU_ALLOWED_CHAT_IDS` | 逗号分隔 chat id | 必填 | 飞书白名单。 |
| `COS_ENABLED` | `true` / `false` | 按需 | 是否把随想图片上传生产 COS。 |
| `COS_PROVIDER` | `tencent_cos` | 启用 COS 时填 | 图片存储 provider。 |
| `COS_BUCKET` | bucket 名 | 启用 COS 时填 | 生产 COS bucket。 |
| `COS_REGION` | 例如 `ap-guangzhou` | 启用 COS 时填 | 生产 COS 地域。 |
| `COS_DOMAIN` | `https://...` | 启用 COS 时填 | 生产 COS 访问域名。 |
| `COS_PATH_PREFIX` | 例如 `thoughts` | 启用 COS 时填 | 生产图片对象前缀。 |
| `CLOUDFLARE_PAGES_BASE_URL` | `https://soulgo.chat` | 建议填 | 部署后页面验证使用；不填时 workflow 默认 `https://soulgo.chat`。 |
| `MARKDOWN_BACKUP_ENABLED` | `true` / `false` | 可选 | 是否启用定时 Markdown 备份。 |
| `MARKDOWN_BACKUP_FREQUENCY` | `daily` / `weekly` | 可选 | 定时备份频率。 |
| `MARKDOWN_BACKUP_BRANCH` | `main` | 可选 | Markdown 备份目标分支。 |
| `MARKDOWN_BACKUP_COMMIT` | `true` | 可选 | 备份有变更时是否自动提交。 |
| `TRAINING_ANALYSIS_GOAL` | 自定义分析目标 | 可选 | 训练分析提示词目标。 |

## 2. Cloudflare 必填清单

Cloudflare 里有两类配置：`wrangler.toml` 里的公开变量和 Durable Object 绑定，以及 Dashboard / `wrangler secret put` 写入的 Worker Secrets。

### 2.1 `wrangler.toml` 已写死的配置

这些配置已经在仓库里，不需要在 GitHub Settings 里再填一遍：

| 配置 | 当前值 | 作用 |
| --- | --- | --- |
| Worker name | `feishu-sync-dispatch` | 生产 webhook 统一入口。 |
| Worker route | `feishu.soulgo.chat` | Telegram 和飞书事件进入同一个生产 Worker。 |
| `GITHUB_DISPATCH_EVENT_TYPE_TELEGRAM` | `telegram_update` | 生产 Telegram 事件类型。 |
| `GITHUB_DISPATCH_EVENT_TYPE_FEISHU` | `feishu_update` | 生产飞书事件类型。 |
| `GITHUB_SYNC_WORKFLOW_FILE` | `sync.yml` | Worker 触发生产同步 workflow。 |
| `GITHUB_SYNC_REF` | `main` | workflow_dispatch 目标分支。 |
| Durable Object `TELEGRAM_ALBUM_BUFFER` | `TelegramAlbumBuffer` | Telegram 相册/连续图片缓冲。 |
| Durable Object `FEISHU_IMAGE_BUFFER` | `FeishuImageBuffer` | 飞书图片缓冲。 |
| Durable Object `SYNC_DISPATCH_QUEUE` | `SyncDispatchQueue` | 排队触发 GitHub Actions 并查询 run 状态。 |

### 2.2 Worker Secrets

位置：Cloudflare Dashboard 的 Worker Secret，或在本地/CI 使用 `wrangler secret put --config wrangler.toml`。

| Worker Secret 名称 | 是否必填 | 值从哪里来 | 用途 |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` | 必填 | GitHub Personal Access Token | Worker 调 GitHub Actions API，触发 `sync.yml`。 |
| `TELEGRAM_SECRET_TOKEN` | 必填 | 自己生成的随机字符串 | 校验 Telegram webhook header；值必须等于 GitHub Secret `TELEGRAM_SECRET_TOKEN`。 |
| `TELEGRAM_BOT_TOKEN` | 建议填 | BotFather 的生产 bot token | Worker 需要直接回 Telegram 时使用，例如帮助文本或队列失败通知。 |
| `FEISHU_ENCRYPT_KEY` | 必填 | 飞书开放平台事件订阅配置 | 解密和校验飞书事件。 |
| `FEISHU_VERIFICATION_TOKEN` | 必填 | 飞书开放平台事件订阅配置 | 校验飞书事件 token。 |
| `FEISHU_APP_ID` | 建议填 | 生产飞书应用凭证 | Worker 需要直接回飞书时使用。 |
| `FEISHU_APP_SECRET` | 建议填 | 生产飞书应用凭证 | Worker 需要直接回飞书时使用。 |

示例命令：

```bash
npx wrangler secret put GITHUB_TOKEN --config wrangler.toml
npx wrangler secret put TELEGRAM_SECRET_TOKEN --config wrangler.toml
npx wrangler secret put TELEGRAM_BOT_TOKEN --config wrangler.toml
npx wrangler secret put FEISHU_ENCRYPT_KEY --config wrangler.toml
npx wrangler secret put FEISHU_VERIFICATION_TOKEN --config wrangler.toml
npx wrangler secret put FEISHU_APP_ID --config wrangler.toml
npx wrangler secret put FEISHU_APP_SECRET --config wrangler.toml
```

`deploy-cloudflare-worker.yml` 当前会自动写入 `TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_SECRET_TOKEN`，但 `GITHUB_TOKEN`、`FEISHU_ENCRYPT_KEY`、`FEISHU_VERIFICATION_TOKEN` 仍需要你在 Cloudflare Worker Secret 中配置。

## 3. 参数从哪里查

### 3.1 AI

| 参数 | 来源 | 说明 |
| --- | --- | --- |
| `AI_API_KEY` | AI 服务商控制台 | Secret。只放 GitHub Secrets。 |
| `AI_BASE_URL` | AI 服务商文档 | Variable。必须是 Chat Completions 兼容接口的 base URL。 |
| `AI_MODEL` | AI 服务商模型列表 | Variable。默认识别和分析模型。 |
| `TELEGRAM_RECOGNITION_MODEL` | AI 服务商模型列表 | Variable。只想让图片识别用另一个模型时再填。 |

当前代码读取位置：`src/adapters/ai/openai-compatible.adapter.mjs`、`src/app/use-cases/telegram-sync.use-case.mjs`。

### 3.2 Telegram

| 参数 | 来源 | 说明 |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Telegram `@BotFather` | 生产 bot token。 |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Telegram 消息来源 chat id | 白名单，多个 id 用逗号分隔。 |
| `TELEGRAM_SECRET_TOKEN` | 自己生成 | 用于 `setWebhook`。必须和 Cloudflare Worker Secret `TELEGRAM_SECRET_TOKEN` 一致。 |
| `TELEGRAM_WEBHOOK_URL` | 生产 Worker URL | 通常是 `https://feishu.soulgo.chat/telegram`。 |

`deploy-cloudflare-worker.yml` 和 `refresh-telegram-webhook.yml` 都会把这些参数注入 `npm run telegram:webhook`。

### 3.3 飞书

| 参数 | 来源 | 说明 |
| --- | --- | --- |
| `FEISHU_APP_ID` | 飞书开放平台应用凭证 | GitHub Secret，用于同步 workflow 调飞书 API。 |
| `FEISHU_APP_SECRET` | 飞书开放平台应用凭证 | GitHub Secret，用于获取 tenant access token。 |
| `FEISHU_ALLOWED_CHAT_IDS` | 飞书群 / 会话 id | GitHub Variable，限制允许处理的飞书会话。 |
| `FEISHU_ENCRYPT_KEY` | 飞书事件订阅安全设置 | Cloudflare Worker Secret，用于解密和签名校验。 |
| `FEISHU_VERIFICATION_TOKEN` | 飞书事件订阅安全设置 | Cloudflare Worker Secret，用于事件 token 校验。 |

飞书事件订阅的回调 URL 应指向生产 Worker 的飞书入口，通常是 `https://feishu.soulgo.chat/feishu`。

### 3.4 PostgreSQL

| 参数 | 来源 | 说明 |
| --- | --- | --- |
| `TRAINING_DB_URL` | PostgreSQL 服务商 | 生产数据库连接串，放 GitHub Secrets。 |
| `TRAINING_DB_READONLY_URL` | PostgreSQL 服务商 | 可选只读连接串，放 GitHub Secrets；读取快照、巡检和一致性检查优先使用。 |
| `TRAINING_DB_MIGRATION_URL` | PostgreSQL 服务商 | 显式迁移连接串，放受控 Secret 或本地 `.env`；只在执行 `maintenance:migrate -- --confirm` 时注入。 |
| `TRAINING_DB_ENABLED` | 自定义 | 生产建议为 `true`。 |
| `TRAINING_DB_TIMEOUT_MS` | 自定义 | 连接超时，放 GitHub Variables。 |
| `TRAINING_DB_APP_NAME` | 自定义 | DB 连接名，便于排查。 |
| `TRAINING_DB_SCHEMA_PREFLIGHT_ENABLED` | 自定义 | 默认 `false`；只有显式迁移兜底时才临时打开。 |
| `TRAINING_SNAPSHOT_SOURCE` | 自定义 | 生产建议使用 `database`。 |

数据库 schema 以 `sql/pgsql17.sql` 和当前显式建表脚本为准；增量 DDL 通过 `sql/training_records/migrations/` 显式执行，不走日常 `TRAINING_DB_URL` 默认路径。Action 监控当前在同一个生产 PostgreSQL 中写入 `monitor.github_action_runs/jobs/steps/failures`，建表脚本见 `docs/03_历史重构记录/重构历史/action日志监控/03_github_action_monitor.sql`。

`Report Action Status` step 会使用运行时 `TRAINING_DB_URL`、`TRAINING_DB_APP_NAME` 和 `github.token` 读取 GitHub Actions run/jobs/steps 后直写 `monitor.*`。只有当生产 DB URL 不可用时，才使用 `GITHUB_ACTION_MONITOR_REPORT_URL_MAIN` / `GITHUB_ACTION_MONITOR_REPORT_URL` 走 HTTP 兜底。

`/action-monitor/` 页面在生产 Pages 构建时由 `build:data` 生成。构建 job 只有在 `TRAINING_DB_ENABLED=true` 时读取 PostgreSQL，优先使用 `TRAINING_DB_READONLY_URL`，未配置只读连接时回退 `TRAINING_DB_URL`。共享 site-build action 会注入 `GITHUB_TOKEN`，用于通过 GitHub Actions API 补齐当前 main 分支漏报或滞后的 runs。

### 3.5 COS 图片存储

main 只有在 `COS_ENABLED=true` 时才需要配置 COS。

| 参数 | 来源 | 说明 |
| --- | --- | --- |
| `COS_SECRET_ID` / `COS_SECRET_KEY` | 腾讯云 CAM 密钥 | 放 GitHub Secrets。 |
| `COS_BUCKET` | 腾讯云 COS bucket | 生产 bucket。 |
| `COS_REGION` | COS bucket 地域 | 例如 `ap-guangzhou`。 |
| `COS_DOMAIN` | COS 默认域名或自定义域名 | 生产图片访问域名。 |
| `COS_PATH_PREFIX` | 自定义 | 生产图片路径前缀。 |

当前 `sync.yml` 已把 `COS_*` 注入同步流程；不要再把 COS 写成“main 未使用”。

### 3.6 Cloudflare

| 参数 | 来源 | 说明 |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Dashboard | GitHub Secret。部署 Worker 时使用。 |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Tokens | GitHub Secret。需要 Workers 编辑权限；生产还用于 cache purge。 |
| `CLOUDFLARE_PAGES_API_TOKEN` | Cloudflare API Tokens | 可选 Secret，专门用于 Pages / cache purge。 |
| `CLOUDFLARE_ZONE_ID` | Cloudflare 站点 Overview | GitHub Secret。生产发布后清理缓存。 |
| `CLOUDFLARE_PAGES_BASE_URL` | 生产站点 URL | GitHub Variable。部署后验证使用。 |

## 4. 部署和验收顺序

1. 在 GitHub Settings 填完 main Secrets 和 Variables。
2. 在 Cloudflare 写入生产 Worker Secrets。
3. 手动运行 `Deploy Cloudflare Worker`，确认 Worker 部署成功并刷新 Telegram webhook。
4. 手动运行 `Deploy GitHub Pages`，确认生产站点能构建、部署并清理 Cloudflare 缓存。
5. 给生产 Telegram bot 或生产飞书应用发测试消息，确认 `Sync (Main)` 被触发。
6. 检查 GitHub Actions summary：同步结果、数据库写入、图片上传、站点部署、缓存清理都应成功。
7. 如启用备份，手动运行一次 `Markdown Backup`，确认能从生产 DB 导出 Markdown。
8. 打开生产站点 `/action-monitor/`，确认新 run 出现在 Action 日志里；如果只有顶层 run 没有 job/step 明细，先回看该 run 的 `Report Action Status` step 是否成功写入 `monitor.*`。

## 5. 不需要配置 Docker

当前仓库没有 `Dockerfile` 或 `docker-compose` 入口。main 环境由 GitHub Actions、GitHub Pages、Cloudflare Worker、Node scripts、PostgreSQL 和可选 COS 组成，不需要 Docker 参数。
