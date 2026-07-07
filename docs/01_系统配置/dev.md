# Dev 环境配置

本文只说明 dev 环境要在 GitHub Settings 和 Cloudflare 里配置什么。先按前两节填完，后面再看每个参数从哪里拿、有什么作用。

dev 环境对应：

- Git 分支：`dev`
- 同步 workflow：`.github/workflows/sync-dev.yml`
- Pages workflow：`.github/workflows/deploy-cloudflare-pages-dev.yml`
- Worker workflow：`.github/workflows/deploy-cloudflare-worker-dev.yml`
- Worker 配置：`wrangler.dev.toml`
- Worker 名称：`sync-dispatch-dev`
- Worker 域名：`feishu-dev.soulgo.chat`

## 1. GitHub Settings 必填清单

位置：GitHub 仓库 `Settings -> Secrets and variables -> Actions`。

### 1.1 Secrets

| Secret 名称 | 是否必填 | 用途 |
| --- | --- | --- |
| `DEV_TRAINING_DB_URL` | 必填 | dev PostgreSQL 连接串，同步、构建、导出都读这个库。 |
| `DEV_TRAINING_DB_READONLY_URL` | 可选 | dev 只读 PostgreSQL 连接串；workflow 映射为运行时 `TRAINING_DB_READONLY_URL`，站点构建、数据库快照读取、Markdown 导出、巡检和一致性检查优先使用，未配置时回退 `DEV_TRAINING_DB_URL` 映射后的运行时 `TRAINING_DB_URL`。 |
| `DEV_TRAINING_DB_MIGRATION_URL` | 手动迁移时必填 | dev 迁移 PostgreSQL 连接串；执行 `npm run maintenance:migrate -- --confirm` 前手动映射为运行时 `TRAINING_DB_MIGRATION_URL`，不注入日常 dev 同步 workflow。 |
| `AI_API_KEY` | 必填 | AI 服务鉴权。dev 和 main 当前共用这个名称。 |
| `DEV_TELEGRAM_BOT_TOKEN` | 必填 | dev Telegram Bot token，用于拉取消息、下载图片、通知结果、刷新 webhook。 |
| `DEV_TELEGRAM_SECRET_TOKEN` | 必填 | dev Telegram webhook secret。必须和 Cloudflare Worker Secret `TELEGRAM_SECRET_TOKEN` 的值一致。 |
| `DEV_FEISHU_APP_ID` | 建议必填 | dev 飞书应用 App ID。未配置时 workflow 会回退到 `FEISHU_APP_ID`，但不利于环境隔离。 |
| `DEV_FEISHU_APP_SECRET` | 建议必填 | dev 飞书应用 App Secret。未配置时 workflow 会回退到 `FEISHU_APP_SECRET`。 |
| `DEV_COS_SECRET_ID` | 启用 COS 时必填 | dev 腾讯云 COS SecretId。 |
| `DEV_COS_SECRET_KEY` | 启用 COS 时必填 | dev 腾讯云 COS SecretKey。 |
| `CLOUDFLARE_ACCOUNT_ID` | 部署 Cloudflare 时必填 | Cloudflare account id。 |
| `CLOUDFLARE_API_TOKEN` | 部署 Cloudflare 时必填 | 部署 Worker、Pages 的 Cloudflare API token。 |
| `CLOUDFLARE_PAGES_API_TOKEN` | 可选 | Pages 专用 token；不填时使用 `CLOUDFLARE_API_TOKEN`。 |
| `TELEGRAM_RECOGNITION_FALLBACK_API_KEY` | 可选 | 图片识别备用 AI provider 的 key。 |

### 1.2 Variables

| Variable 名称 | 建议值 / 示例 | 是否必填 | 用途 |
| --- | --- | --- | --- |
| `TRAINING_DB_TIMEOUT_MS` | `5000` | 建议填 | 数据库连接超时。 |
| `DEV_TRAINING_DB_APP_NAME` | `sync-dev` | 建议填 | PostgreSQL `application_name`，便于在 DB 侧区分来源。 |
| `GITHUB_ACTION_MONITOR_REPORT_URL_DEV` | dev 监控 API base URL | 可选 | `Report Action Status` 在没有可用 dev PostgreSQL 连接时的 HTTP 兜底上报地址。 |
| `GITHUB_ACTION_MONITOR_REPORT_URL` | 共享监控 API base URL | 可选 | dev/main 专用 URL 未配置时的共享兜底地址。 |
| `GITHUB_ACTION_MONITOR_REPORT_URL_MAIN` | main 监控 API base URL | 可选 | 所有 workflow 都注入该变量；dev 分支不会优先使用它。 |
| `TRAINING_DB_SCHEMA_PREFLIGHT_ENABLED` | `false` | 可选 | 过渡期 DDL preflight 开关；默认关闭，日常 dev 业务账号不应启用。 |
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
| `TELEGRAM_ALLOWED_CHAT_IDS` | 逗号分隔 chat id | 必填 | Telegram 白名单。dev 当前没有 `DEV_` 前缀变量。 |
| `TELEGRAM_POLL_LIMIT` | `20` | 可选 | poll 模式拉取数量；dev workflow 当前固定 webhook 模式。 |
| `DEV_TELEGRAM_WEBHOOK_URL` | `https://feishu-dev.soulgo.chat/telegram` | 必填 | 刷新 dev Telegram webhook 的目标 URL。 |
| `DEV_FEISHU_ALLOWED_CHAT_IDS` | 逗号分隔 chat id | 建议必填 | dev 飞书白名单；不填会回退到 `FEISHU_ALLOWED_CHAT_IDS`。 |
| `DEV_COS_ENABLED` | `true` / `false` | 按需 | 是否把随想图片上传 dev COS。 |
| `DEV_COS_PROVIDER` | `tencent_cos` | 启用 COS 时填 | 图片存储 provider。 |
| `DEV_COS_BUCKET` | bucket 名 | 启用 COS 时填 | dev COS bucket，必须和 main bucket 不同。 |
| `DEV_COS_REGION` | 例如 `ap-guangzhou` | 启用 COS 时填 | dev COS 地域。 |
| `DEV_COS_DOMAIN` | `https://...` | 启用 COS 时填 | dev COS 访问域名，必须和 main domain 不同。 |
| `DEV_COS_PATH_PREFIX` | 例如 `dev/thoughts` | 启用 COS 时填 | dev 图片对象前缀。 |
| `CLOUDFLARE_PAGES_DEV_PROJECT_NAME` | `training-records-dev` | 建议填 | Cloudflare Pages dev 项目名。 |
| `CLOUDFLARE_PAGES_DEV_BASE_URL` | dev 站点 URL | 建议填 | dev 部署后页面验证使用。 |
| `TRAINING_ANALYSIS_GOAL` | 自定义分析目标 | 可选 | 训练分析提示词目标。 |

## 2. Cloudflare 必填清单

Cloudflare 里有两类配置：`wrangler.dev.toml` 里的公开变量和 Durable Object 绑定，以及 Dashboard / `wrangler secret put` 写入的 Worker Secrets。

### 2.1 `wrangler.dev.toml` 已写死的配置

这些配置已经在仓库里，不需要在 GitHub Settings 里再填一遍：

| 配置 | 当前值 | 作用 |
| --- | --- | --- |
| Worker name | `sync-dispatch-dev` | dev webhook 统一入口。 |
| Worker route | `feishu-dev.soulgo.chat` | Telegram 和飞书事件进入同一个 dev Worker。 |
| `GITHUB_DISPATCH_EVENT_TYPE_TELEGRAM` | `telegram_update_dev` | dev Telegram 事件类型。 |
| `GITHUB_DISPATCH_EVENT_TYPE_FEISHU` | `feishu_update_dev` | dev 飞书事件类型。 |
| `GITHUB_SYNC_WORKFLOW_FILE` | `sync-dev.yml` | Worker 触发 dev 同步 workflow。 |
| `GITHUB_SYNC_REF` | `dev` | workflow_dispatch 目标分支。 |
| Durable Object `TELEGRAM_ALBUM_BUFFER` | `TelegramAlbumBuffer` | Telegram 相册/连续图片缓冲。 |
| Durable Object `FEISHU_IMAGE_BUFFER` | `FeishuImageBuffer` | 飞书图片缓冲。 |
| Durable Object `SYNC_DISPATCH_QUEUE` | `SyncDispatchQueue` | 排队触发 GitHub Actions 并查询 run 状态。 |

### 2.2 Worker Secrets

位置：Cloudflare Dashboard 的 Worker Secret，或在本地/CI 使用 `wrangler secret put --config wrangler.dev.toml`。

| Worker Secret 名称 | 是否必填 | 值从哪里来 | 用途 |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` | 必填 | GitHub Personal Access Token | Worker 调 GitHub Actions API，触发 `sync-dev.yml`。 |
| `TELEGRAM_SECRET_TOKEN` | 必填 | 自己生成的随机字符串 | 校验 Telegram webhook header；值必须等于 GitHub Secret `DEV_TELEGRAM_SECRET_TOKEN`。 |
| `TELEGRAM_BOT_TOKEN` | 建议填 | BotFather 的 dev bot token | Worker 需要直接回 Telegram 时使用，例如帮助文本或队列失败通知。 |
| `FEISHU_ENCRYPT_KEY` | 必填 | 飞书开放平台事件订阅配置 | 解密和校验飞书事件。 |
| `FEISHU_VERIFICATION_TOKEN` | 必填 | 飞书开放平台事件订阅配置 | 校验飞书事件 token。 |
| `FEISHU_APP_ID` | 建议填 | dev 飞书应用凭证 | Worker 需要直接回飞书时使用。 |
| `FEISHU_APP_SECRET` | 建议填 | dev 飞书应用凭证 | Worker 需要直接回飞书时使用。 |

示例命令：

```bash
npx wrangler secret put GITHUB_TOKEN --config wrangler.dev.toml
npx wrangler secret put TELEGRAM_SECRET_TOKEN --config wrangler.dev.toml
npx wrangler secret put TELEGRAM_BOT_TOKEN --config wrangler.dev.toml
npx wrangler secret put FEISHU_ENCRYPT_KEY --config wrangler.dev.toml
npx wrangler secret put FEISHU_VERIFICATION_TOKEN --config wrangler.dev.toml
npx wrangler secret put FEISHU_APP_ID --config wrangler.dev.toml
npx wrangler secret put FEISHU_APP_SECRET --config wrangler.dev.toml
```

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
| `DEV_TELEGRAM_BOT_TOKEN` | Telegram `@BotFather` | dev bot token。 |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Telegram 消息来源 chat id | 白名单，多个 id 用逗号分隔。 |
| `DEV_TELEGRAM_SECRET_TOKEN` | 自己生成 | 用于 `setWebhook`。必须和 Cloudflare Worker Secret `TELEGRAM_SECRET_TOKEN` 一致。 |
| `DEV_TELEGRAM_WEBHOOK_URL` | dev Worker URL | 通常是 `https://feishu-dev.soulgo.chat/telegram`。 |

刷新 webhook 的 workflow 会把 `DEV_TELEGRAM_BOT_TOKEN`、`DEV_TELEGRAM_WEBHOOK_URL`、`DEV_TELEGRAM_SECRET_TOKEN` 注入 `npm run telegram:webhook`。

### 3.3 飞书

| 参数 | 来源 | 说明 |
| --- | --- | --- |
| `DEV_FEISHU_APP_ID` | 飞书开放平台应用凭证 | GitHub Secret，用于同步 workflow 调飞书 API。 |
| `DEV_FEISHU_APP_SECRET` | 飞书开放平台应用凭证 | GitHub Secret，用于获取 tenant access token。 |
| `DEV_FEISHU_ALLOWED_CHAT_IDS` | 飞书群 / 会话 id | GitHub Variable，限制允许处理的飞书会话。 |
| `FEISHU_ENCRYPT_KEY` | 飞书事件订阅安全设置 | Cloudflare Worker Secret，用于解密和签名校验。 |
| `FEISHU_VERIFICATION_TOKEN` | 飞书事件订阅安全设置 | Cloudflare Worker Secret，用于事件 token 校验。 |

飞书事件订阅的回调 URL 应指向 dev Worker 的飞书入口，通常是 `https://feishu-dev.soulgo.chat/feishu`。

### 3.4 PostgreSQL

| 参数 | 来源 | 说明 |
| --- | --- | --- |
| `DEV_TRAINING_DB_URL` | PostgreSQL 服务商 | dev 数据库连接串，放 GitHub Secrets。 |
| `DEV_TRAINING_DB_READONLY_URL` | PostgreSQL 服务商 | 可选只读连接串，放 GitHub Secrets；workflow 映射为运行时 `TRAINING_DB_READONLY_URL`，读取快照、巡检和一致性检查优先使用。 |
| `DEV_TRAINING_DB_MIGRATION_URL` | PostgreSQL 服务商 | 显式迁移连接串，放受控 Secret 或本地 `.env`；执行迁移前手动映射为 `TRAINING_DB_MIGRATION_URL`。 |
| `TRAINING_DB_TIMEOUT_MS` | 自定义 | 连接超时，放 GitHub Variables。 |
| `DEV_TRAINING_DB_APP_NAME` | 自定义 | DB 连接名，便于排查。 |
| `TRAINING_DB_SCHEMA_PREFLIGHT_ENABLED` | 自定义 | 默认 `false`；只有显式迁移兜底时才临时打开。 |
| `TRAINING_SNAPSHOT_SOURCE` | 自定义 | 建议 dev 使用 `database`。 |

数据库 schema 以 `sql/pgsql17.sql` 和当前显式建表脚本为准；增量 DDL 通过 `sql/training_records/migrations/` 显式执行，不走日常 `DEV_TRAINING_DB_URL` 映射后的默认路径。Action 监控当前在同一个 dev PostgreSQL 中写入 `monitor.github_action_runs/jobs/steps/failures`，参数有效期 audit 写入 `monitor.system_config_parameters` 和 `monitor.system_config_parameter_checks`。

`Report Action Status` step 会把 `DEV_TRAINING_DB_URL` 映射为运行时 `TRAINING_DB_URL`，把 `DEV_TRAINING_DB_APP_NAME` 映射为 `TRAINING_DB_APP_NAME`，并使用 `github.token` 读取 GitHub Actions run/jobs/steps 后直写 `monitor.*`。只有当分支 DB URL 不可用时，才使用 `GITHUB_ACTION_MONITOR_REPORT_URL_DEV` / `GITHUB_ACTION_MONITOR_REPORT_URL` 走 HTTP 兜底。

参数有效期元数据维护在 `config/parameter-validity/dev.json`。当前 registry 只登记第一批高风险 Secret 名称和来源，不保存实际值；没有填写 `expiresAt` 或 `reviewAfterAt` 的参数会在 `/action-monitor/` 中显示为 `unknown`。

`/action-monitor/` 页面在 dev Pages 构建时由 `build:data` 生成。构建 job 设置 `TRAINING_DB_ENABLED=true`，优先用 `DEV_TRAINING_DB_READONLY_URL` 映射后的 `TRAINING_DB_READONLY_URL` 读取 `monitor.*`；未配置只读连接时回退 `DEV_TRAINING_DB_URL`。共享 site-build action 会注入 `GITHUB_TOKEN`，用于通过 GitHub Actions API 补齐当前 dev 分支漏报或滞后的 runs，并读取最新参数有效期检查结果。

### 3.5 COS 图片存储

dev 只有在 `DEV_COS_ENABLED=true` 时才需要配置 COS。

| 参数 | 来源 | 说明 |
| --- | --- | --- |
| `DEV_COS_SECRET_ID` / `DEV_COS_SECRET_KEY` | 腾讯云 CAM 密钥 | 放 GitHub Secrets。 |
| `DEV_COS_BUCKET` | 腾讯云 COS bucket | dev bucket，必须和 main 不同。 |
| `DEV_COS_REGION` | COS bucket 地域 | 例如 `ap-guangzhou`。 |
| `DEV_COS_DOMAIN` | COS 默认域名或自定义域名 | dev domain，必须和 main 不同。 |
| `DEV_COS_PATH_PREFIX` | 自定义 | dev 图片路径前缀。 |

dev workflow 会检查 `DEV_COS_BUCKET` / `DEV_COS_DOMAIN` 不能和 main 的 `COS_BUCKET` / `COS_DOMAIN` 相同。

### 3.6 Cloudflare

| 参数 | 来源 | 说明 |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Dashboard | GitHub Secret。部署 Worker 和 Pages 时使用。 |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Tokens | GitHub Secret。需要 Workers / Pages 编辑权限。 |
| `CLOUDFLARE_PAGES_API_TOKEN` | Cloudflare API Tokens | 可选 Secret，专门用于 Pages 部署。 |
| `CLOUDFLARE_PAGES_DEV_PROJECT_NAME` | Cloudflare Pages 项目 | GitHub Variable。 |
| `CLOUDFLARE_PAGES_DEV_BASE_URL` | dev Pages 访问地址 | GitHub Variable。用于部署后验证。 |

## 4. 部署和验收顺序

1. 在 GitHub Settings 填完 dev Secrets 和 Variables。
2. 在 Cloudflare 写入 dev Worker Secrets。
3. 运行 `Deploy Cloudflare Worker (Dev)`，确认 Worker 部署成功并刷新 Telegram webhook。
4. 运行 `Deploy Cloudflare Pages (Dev)`，确认 dev 站点能构建和部署。
5. 给 dev Telegram bot 或 dev 飞书应用发测试消息，确认 `Sync (Dev)` 被触发。
6. 检查 GitHub Actions summary：同步结果、数据库写入、图片上传、站点部署都应成功。
7. 手动运行 `Parameter Validity Audit`，确认 Step Summary 出现 dev 参数有效期计数，并且 workflow 触发 dev Pages 刷新。
8. 打开 dev 站点 `/action-monitor/`，确认新 run 出现在 Action 日志里，且“系统参数有效期”展示 dev registry 中的参数状态；如果只有顶层 run 没有 job/step 明细，先回看该 run 的 `Report Action Status` step 是否成功写入 `monitor.*`。

## 5. 不需要配置 Docker

当前仓库没有 `Dockerfile` 或 `docker-compose` 入口。dev 环境由 GitHub Actions、Cloudflare Worker、Cloudflare Pages、Node scripts 和 PostgreSQL 组成，不需要 Docker 参数。
