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
| `TRAINING_DB_URL` | 必填 | 使用与 dev 相同 `training_writer` 账号、但指向 main 数据库的 PostgreSQL 连接串；workflow 从 GitHub Secret 注入。 |
| `TRAINING_DB_READONLY_URL` | 建议填 | main 只读 PostgreSQL 连接串；只读账号名只存在于该 GitHub Secret 的 URL 中，读取任务优先使用；运行时代码在空值时回退 `TRAINING_DB_URL`。当前 GitHub Settings 清单中缺少此项，应补齐或从 workflow 移除其读取。 |
| `AI_API_KEY` | 必填 | AI 服务鉴权。 |
| `AI_BASE_URL` | 必填 | OpenAI-compatible base URL。 |
| `TELEGRAM_BOT_TOKEN` | 必填 | 生产 Telegram Bot token，用于拉取消息、下载图片、通知结果、刷新 webhook。 |
| `TELEGRAM_SECRET_TOKEN` | 必填 | 生产 Telegram webhook secret。必须和 Cloudflare Worker Secret `TELEGRAM_SECRET_TOKEN` 的值一致。 |
| `FEISHU_APP_ID` | 必填 | 生产飞书应用 App ID。 |
| `FEISHU_APP_SECRET` | 必填 | 生产飞书应用 App Secret。 |
| `TELEGRAM_ALLOWED_CHAT_IDS` | 必填 | Telegram 白名单，多个 id 用逗号分隔。 |
| `FEISHU_ALLOWED_CHAT_IDS` | 必填 | 飞书白名单。 |
| `COS_SECRET_ID` | 启用 COS 时必填 | 生产腾讯云 COS SecretId。 |
| `COS_SECRET_KEY` | 启用 COS 时必填 | 生产腾讯云 COS SecretKey。 |
| `COS_BUCKET` | 启用 COS 时必填 | 生产 COS bucket。 |
| `COS_DOMAIN` | 启用 COS 时必填 | 生产 COS 访问域名。 |
| `COS_PATH_PREFIX` | 启用 COS 时必填 | 生产图片对象前缀。 |
| `CLOUDFLARE_ACCOUNT_ID` | 部署 Cloudflare Worker 时必填 | Cloudflare account id。 |
| `CLOUDFLARE_API_TOKEN` | 部署 Worker 或清理缓存时必填 | 部署 Worker、清理 Cloudflare 缓存；也可作为 Pages 部署 token。 |
| `CLOUDFLARE_PAGES_API_TOKEN` | 可选 | Pages / cache purge 专用 token；不填时使用 `CLOUDFLARE_API_TOKEN`。 |
| `CLOUDFLARE_ZONE_ID` | 清理 Cloudflare 缓存时必填 | 生产站点发布后清理 Cloudflare 缓存。 |
| `STANDBY_AI_API_KEY` | 备用服务商不同时必填 | Telegram/飞书共用的备用 AI key；配置后优先于旧 fallback key。 |
| `STANDBY_AI_BASE_URL` | 备用服务商不同时必填 | 备用 AI 的 OpenAI-compatible base URL；Kimi 与主 GPT 不在同一服务时必须指向提供 Kimi 的渠道。 |
| `TELEGRAM_RECOGNITION_FALLBACK_API_KEY` | 兼容可选 | 旧备用 key 名；仅在 `STANDBY_AI_API_KEY` 为空时读取，均为空才继承 `AI_API_KEY`。 |
| `TELEGRAM_RECOGNITION_FALLBACK_BASE_URL` | 兼容可选 | 旧备用 base URL 名；仅在 `STANDBY_AI_BASE_URL` 为空时读取，均为空才继承 `AI_BASE_URL`。 |

### 1.2 Variables

| Variable 名称 | 建议值 / 示例 | 是否必填 | 用途 |
| --- | --- | --- | --- |
| `TRAINING_DB_ENABLED` | `true` | 必填 | 是否启用生产 PostgreSQL。 |
| `TRAINING_DB_TIMEOUT_MS` | `5000` | 建议填 | 数据库连接超时；不同运行路径的未配置默认值不同，建议显式配置。 |
| `TRAINING_DB_APP_NAME` | `sync-main` | 建议填 | PostgreSQL `application_name`，便于在 DB 侧区分来源。 |
| `GITHUB_ACTION_MONITOR_REPORT_URL_MAIN` | main 监控 API base URL | 可选 | 本地或旧 workflow 使用 HTTP monitor server 时的兜底地址；当前 `Action Monitor Report` 直接写生产 PostgreSQL。当前 GitHub Settings 清单中缺少该项。 |
| `GITHUB_ACTION_MONITOR_REPORT_URL` | 共享监控 API base URL | 可选 | main/dev 专用 URL 未配置时的共享兜底地址。当前 GitHub Settings 清单中缺少该项。 |
| `GITHUB_ACTION_MONITOR_REPORT_URL_DEV` | dev 监控 API base URL | 可选 | 所有 workflow 都注入该变量；main 分支不会优先使用它。当前 GitHub Settings 清单中缺少该项。 |
| `TRAINING_SNAPSHOT_SOURCE` | `database` | 建议填 | 构建站点时从数据库还是 Markdown 生成快照。 |
| `AI_PROVIDER` | `openai-compatible` | 建议填 | 当前代码支持 OpenAI-compatible provider；当前 GitHub Settings 清单中缺少该项，因此 workflow 使用 `openai-compatible` 默认值。 |
| `AI_API_PROTOCOL` | `chat_completions` / `responses` | 建议填 | 未配置时 workflow 和运行时代码默认 `chat_completions`；需要 Responses API 时设为 `responses`，且必须与 `AI_MODEL` 实际支持的协议一致。 |
| `AI_MODEL` | 例如 `gpt-4.1-mini` | 必填 | 默认 AI 模型。 |
| `AI_TIMEOUT_MS` | `60000` | 建议填 | AI 请求超时。 |
| `AI_CONCURRENCY` | `3` | 建议填 | 图片识别并发数。 |
| `AI_SUPPORTS_VISION` / `AI_SUPPORTS_JSON_SCHEMA` / `AI_SUPPORTS_JSON_OBJECT` / `AI_SUPPORTS_TEXT_JSON` | `true` / `false` | 按模型配置 | 显式声明默认 AI 模型的图片与结构化输出能力；不填均默认 `true`。 |
| `AI_OCR_ENABLED` | `false` / `true` | 按需 | 是否启用 OCR 文本与坐标提取。当前 GitHub Settings 清单中缺少该项。 |
| `AI_OCR_FAILURE_MODE` | `best_effort` | 建议填 | OCR 失败时继续视觉识别或终止处理。当前 GitHub Settings 清单中缺少该项。 |
| `TELEGRAM_RECOGNITION_MODEL` | 识别模型名 | 可选 | 只覆盖 Telegram/飞书图片识别模型；不填用 `AI_MODEL`。当前 GitHub Settings 清单中缺少该项。 |
| `TELEGRAM_RECOGNITION_CACHE_ENABLED` | `true` | 建议填 | 是否启用识别结果缓存。 |
| `TELEGRAM_RECOGNITION_FALLBACK_API_PROTOCOL` | `chat_completions` / `responses` | 主备协议不同时必填 | 备用图片识别协议；不填继承 `AI_API_PROTOCOL`。当前主模型使用 `responses`、备用 Kimi 使用 `chat_completions`，因此生产配置必须显式设为 `chat_completions`。 |
| `TELEGRAM_RECOGNITION_FALLBACK_MODEL` | 模型名 | 可选 | 备用 AI provider 模型。 |
| `TELEGRAM_RECOGNITION_FALLBACK_TIMEOUT_MS` | `90000` | 可选 | 备用 AI 请求超时。备 AI 作为主 AI 故障与业务补全的最后防线，超时不应短于主 AI；睡眠等字段密集截图生成较慢，建议 90s。 |
| `TELEGRAM_POLL_LIMIT` | `20` | 当前 workflow 无需配置 | poll 模式拉取数量；main workflow 当前固定 webhook 模式，因此该值不会影响当前 GitHub 同步。 |
| `TELEGRAM_WEBHOOK_URL` | `https://feishu.soulgo.chat/telegram` | 必填 | 刷新生产 Telegram webhook 的目标 URL。 |
| `COS_ENABLED` | `true` / `false` | 按需 | 是否把随想图片上传生产 COS。 |
| `COS_PROVIDER` | `tencent_cos` | 启用 COS 时填 | 图片存储 provider。 |
| `COS_REGION` | 例如 `ap-guangzhou` | 启用 COS 时填 | 生产 COS 地域。 |
| `CLOUDFLARE_PAGES_BASE_URL` | `https://soulgo.chat` | 建议填 | 部署后页面验证使用；不填时 workflow 默认 `https://soulgo.chat`。 |
| `MARKDOWN_BACKUP_ENABLED` | `true` / `false` | 可选 | 是否启用定时 Markdown 备份。 |
| `MARKDOWN_BACKUP_FREQUENCY` | `daily` / `weekly` | 可选 | 定时备份频率。 |
| `MARKDOWN_BACKUP_BRANCH` | `main` | 可选 | Markdown 备份目标分支；只影响 checkout/push 目标，备份数据源仍固定为生产 `TRAINING_DB_*`。 |
| `MARKDOWN_BACKUP_COMMIT` | `true` | 可选 | 备份有变更时是否自动提交；当前 GitHub Settings 清单中缺少该项，workflow 默认 `true`。 |
| `TRAINING_ANALYSIS_GOAL` | 自定义分析目标 | 可选 | 训练分析提示词目标；当前 GitHub Settings 清单中缺少该项，运行时代码使用内置的“增肌减腹”目标。 |

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
| `TELEGRAM_ALLOWED_CHAT_IDS` | 必填 | 生产 Telegram 白名单 | Worker 在进入 Durable Object 缓冲和触发 GitHub Actions 前校验；需单独写入 Cloudflare Worker Secret，不能仅依赖 GitHub Secret `TELEGRAM_ALLOWED_CHAT_IDS`。 |
| `FEISHU_ENCRYPT_KEY` | 必填 | 飞书开放平台事件订阅配置 | 解密和校验飞书事件。 |
| `FEISHU_VERIFICATION_TOKEN` | 必填 | 飞书开放平台事件订阅配置 | 校验飞书事件 token。 |
| `FEISHU_APP_ID` | 建议填 | 生产飞书应用凭证 | Worker 需要直接回飞书时使用。 |
| `FEISHU_APP_SECRET` | 建议填 | 生产飞书应用凭证 | Worker 需要直接回飞书时使用。 |
| `FEISHU_ALLOWED_CHAT_IDS` | 必填 | 生产飞书白名单 | Worker 在进入 Durable Object 缓冲和触发 GitHub Actions 前校验；需单独写入 Cloudflare Worker Secret，不能仅依赖 GitHub Secret `FEISHU_ALLOWED_CHAT_IDS`。 |

示例命令：

```bash
npx wrangler secret put GITHUB_TOKEN --config wrangler.toml
npx wrangler secret put TELEGRAM_SECRET_TOKEN --config wrangler.toml
npx wrangler secret put TELEGRAM_BOT_TOKEN --config wrangler.toml
npx wrangler secret put TELEGRAM_ALLOWED_CHAT_IDS --config wrangler.toml
npx wrangler secret put FEISHU_ENCRYPT_KEY --config wrangler.toml
npx wrangler secret put FEISHU_VERIFICATION_TOKEN --config wrangler.toml
npx wrangler secret put FEISHU_APP_ID --config wrangler.toml
npx wrangler secret put FEISHU_APP_SECRET --config wrangler.toml
npx wrangler secret put FEISHU_ALLOWED_CHAT_IDS --config wrangler.toml
```

`deploy-cloudflare-worker.yml` 当前只会自动写入 `TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_SECRET_TOKEN`。`GITHUB_TOKEN`、`TELEGRAM_ALLOWED_CHAT_IDS`、`FEISHU_ENCRYPT_KEY`、`FEISHU_VERIFICATION_TOKEN`、`FEISHU_ALLOWED_CHAT_IDS` 仍需要在 Cloudflare Worker Secret 中单独维护；两个白名单未配置时 Worker 会放行任意 chat。`FEISHU_APP_ID` / `FEISHU_APP_SECRET` 也不会自动同步，按需配置，用于 Worker 在派发失败时向飞书通知。

## 3. 参数从哪里查

### 3.1 AI

| 参数 | 来源 | 说明 |
| --- | --- | --- |
| `AI_API_KEY` | AI 服务商控制台 | Secret。只放 GitHub Secrets。 |
| `AI_BASE_URL` | AI 服务商文档 | Secret。OpenAI-compatible base URL，通常以 `/v1` 结尾。 |
| `STANDBY_AI_API_KEY` / `STANDBY_AI_BASE_URL` | 备用 AI 服务商控制台与 API 文档 | Secrets；备用模型与主模型来自不同服务或分组时必须配置。 |
| `AI_API_PROTOCOL` | AI 服务商模型/API 文档 | Variable；未填默认 `chat_completions`；`chat_completions` 请求 `/chat/completions`，`responses` 请求 `/responses`。 |
| `TELEGRAM_RECOGNITION_FALLBACK_API_PROTOCOL` | 备用 AI 服务商 API 文档 | Variable；备用服务协议与主服务不同时必填，`sync.yml`、`sync-dev.yml` 和 `pending-replay.yml` 均会注入。 |
| `AI_MODEL` | AI 服务商模型列表 | Variable。默认识别和分析模型。 |
| `TELEGRAM_RECOGNITION_MODEL` | AI 服务商模型列表 | Variable。只想让图片识别用另一个模型时再填；当前 GitHub Settings 清单中缺少该项。 |
| `AI_SUPPORTS_VISION` / `AI_SUPPORTS_JSON_SCHEMA` / `AI_SUPPORTS_JSON_OBJECT` / `AI_SUPPORTS_TEXT_JSON` | AI 服务商能力说明 | 默认都为 `true`；`sync.yml`、`sync-dev.yml` 与 `pending-replay.yml` 均注入这些变量，应按模型真实能力显式覆盖。 |

当前代码读取位置：`src/adapters/ai/openai-compatible.adapter.mjs`、`src/app/use-cases/message-sync.use-case.mjs`。

图片识别完整性门禁始终启用（无功能开关）：主识别业务字段完整时不调用备 AI；`incomplete`/`needs_review` 且已配置 `TELEGRAM_RECOGNITION_FALLBACK_MODEL` 时才调用备 AI 尽量补全图片可见字段。备用连接按 `STANDBY_AI_*` → 旧 `TELEGRAM_RECOGNITION_FALLBACK_*` → 主 `AI_*` 取首个非空值；Kimi 与 GPT 不同服务时必须配置 `STANDBY_AI_*`。业务补全失败会保留主结果，主 AI 技术失败时备用也失败才判技术失败。`.github/workflows/sync.yml`、`.github/workflows/sync-dev.yml` 与 `.github/workflows/pending-replay.yml` 注入同一套连接、模型和备用协议配置。

### 3.2 Telegram

| 参数 | 来源 | 说明 |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Telegram `@BotFather` | 生产 bot token。 |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Telegram 消息来源 chat id | GitHub Secret。白名单，多个 id 用逗号分隔。 |
| `TELEGRAM_SECRET_TOKEN` | 自己生成 | 用于 `setWebhook`。必须和 Cloudflare Worker Secret `TELEGRAM_SECRET_TOKEN` 一致。 |
| `TELEGRAM_WEBHOOK_URL` | 生产 Worker URL | 通常是 `https://feishu.soulgo.chat/telegram`。 |

`deploy-cloudflare-worker.yml` 和 `refresh-telegram-webhook.yml` 都会把这些参数注入 `npm run telegram:webhook`。

### 3.3 飞书

| 参数 | 来源 | 说明 |
| --- | --- | --- |
| `FEISHU_APP_ID` | 飞书开放平台应用凭证 | GitHub Secret，用于同步 workflow 调飞书 API。 |
| `FEISHU_APP_SECRET` | 飞书开放平台应用凭证 | GitHub Secret，用于获取 tenant access token。 |
| `FEISHU_ALLOWED_CHAT_IDS` | 飞书群 / 会话 id | GitHub Secret，限制允许处理的飞书会话。 |
| `FEISHU_ENCRYPT_KEY` | 飞书事件订阅安全设置 | Cloudflare Worker Secret，用于解密和签名校验。 |
| `FEISHU_VERIFICATION_TOKEN` | 飞书事件订阅安全设置 | Cloudflare Worker Secret，用于事件 token 校验。 |

飞书事件订阅的回调 URL 应指向生产 Worker 的飞书入口，通常是 `https://feishu.soulgo.chat/feishu`。

### 3.4 PostgreSQL

| 参数 | 来源 | 说明 |
| --- | --- | --- |
| `TRAINING_DB_URL` | PostgreSQL 服务商 | `training_writer` 连接 main 数据库的 URL，放 GitHub Secrets。 |
| `TRAINING_DB_READONLY_URL` | PostgreSQL 服务商 | 可选 main 只读连接串，账号名不写入源码；读取快照、巡检和一致性检查优先使用。 |
| `TRAINING_DB_ENABLED` | 自定义 | 生产建议为 `true`。 |
| `TRAINING_DB_TIMEOUT_MS` | 自定义 | 连接超时，放 GitHub Variables。 |
| `TRAINING_DB_APP_NAME` | 自定义 | DB 连接名，便于排查。 |
| `TRAINING_SNAPSHOT_SOURCE` | 自定义 | 生产建议使用 `database`。 |

main 数据库已经与 dev 完成结构对齐，当前 schema 事实源是 `sql/main-sql/`。后续结构变更仍要先备份生产库、独立执行并验收，再重新导出 main SQL；不得用 dev 业务数据覆盖 main。

`Action Monitor Report` 在被监控 run 完成后使用 `TRAINING_DB_URL`、`TRAINING_DB_APP_NAME` 和 `github.token` 读取 GitHub run/jobs/steps，并直写生产 `monitor.*`。

`/action-monitor/` 页面在生产 Pages 构建时由 `build:data` 生成。构建 job 只有在 `TRAINING_DB_ENABLED=true` 时读取 PostgreSQL，优先使用 `TRAINING_DB_READONLY_URL`，未配置只读连接时回退 `TRAINING_DB_URL`。共享 site-build action 会注入 `GITHUB_TOKEN`，用于通过 GitHub Actions API 补齐当前 main 分支漏报或滞后的 runs。

### 3.5 COS 图片存储

main 只有在 `COS_ENABLED=true` 时才需要配置 COS。

| 参数 | 来源 | 说明 |
| --- | --- | --- |
| `COS_SECRET_ID` / `COS_SECRET_KEY` | 腾讯云 CAM 密钥 | 放 GitHub Secrets。 |
| `COS_BUCKET` | 腾讯云 COS bucket | GitHub Secret。生产 bucket。 |
| `COS_REGION` | COS bucket 地域 | 例如 `ap-guangzhou`。 |
| `COS_DOMAIN` | COS 默认域名或自定义域名 | GitHub Secret。生产图片访问域名。 |
| `COS_PATH_PREFIX` | 自定义 | GitHub Secret。生产图片路径前缀。 |

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
6. 检查 `Sync (Main)` summary：同步、数据库写入、图片上传和 deploy dispatch 应成功；站点构建、发布和缓存清理在独立 `Deploy GitHub Pages` run 中确认。
7. 如启用备份，手动运行一次 `Markdown Backup`，确认能从生产 DB 导出 Markdown。
8. 打开生产站点 `/action-monitor/`，确认 sync 与 deploy 由 `Action Monitor Report` 写入 Action 日志。

## 5. 可选 Docker 运行

main 当前默认仍由 GitHub Pages 和 Cloudflare Worker 运行；若迁移到普通云服务器、Docker 或 Kubernetes，可使用根目录 `Dockerfile`、`compose.yml` 与 `deploy/nginx.conf`。`docker compose up --build -d` 默认监听宿主机 `8080`，可通过 `SITE_PORT` 覆盖；生产 Secret 只能在构建/运行环境安全注入，不能写入镜像层。
