# GitHub + Cloudflare 统一配置清单

本文件合并原 `github-settings.md` 与 `telegram-webhook-cloudflare.md`，用于一次性配置 GitHub Settings、GitHub Actions 和 Cloudflare Worker。

## 适用工作流

- `.github/workflows/deploy-pages.yml`
- `.github/workflows/deploy-cloudflare-pages-dev.yml`
- `.github/workflows/telegram-sync.yml`
- `.github/workflows/deploy-cloudflare-worker.yml`
- `.github/workflows/refresh-telegram-webhook.yml`

## 1. GitHub Settings

### Secrets

#### `TELEGRAM_BOT_TOKEN`

- 用途：Telegram Bot 轮询消息
- 使用工作流：`telegram-sync.yml`
- 是否必填：是

#### `AI_API_KEY`

- 用途：截图识别和 Telegram `/analysis` 训练分析所用 AI 服务鉴权
- 使用工作流：`telegram-sync.yml`
- 是否必填：是

#### `TELEGRAM_RECOGNITION_FALLBACK_API_KEY`

- 用途：Telegram 图片识别备用 AI 服务鉴权；主 AI timeout、HTTP 429/5xx、空内容或网络失败时使用
- 使用工作流：`telegram-sync.yml`、`telegram-sync-dev.yml`
- 是否必填：否；只有同时配置 `TELEGRAM_RECOGNITION_FALLBACK_BASE_URL` 和 `TELEGRAM_RECOGNITION_FALLBACK_MODEL` 时才启用

#### `TRAINING_DB_URL`

- 用途：PostgreSQL 连接串
- 使用工作流：`deploy-pages.yml`、`telegram-sync.yml`
- 是否必填：当 `TRAINING_DB_ENABLED=true` 时必填
- 推荐格式：

```text
postgresql://training_writer:你的数据库密码@你的数据库公网IP或域名:5432/training_records
```

- 如果数据库启用了 SSL，再按实际情况追加 `?sslmode=require`

#### `CLOUDFLARE_API_TOKEN`

- 用途：让 GitHub Actions 调用 Wrangler 部署 Cloudflare Worker
- 使用工作流：`deploy-cloudflare-worker.yml`
- 是否必填：使用 Telegram webhook + Cloudflare Worker 时必填
- 权限建议：至少能编辑当前账号下的 Workers Scripts

#### `CLOUDFLARE_ACCOUNT_ID`

- 用途：指定 Wrangler 要部署到哪个 Cloudflare 账号
- 使用工作流：`deploy-cloudflare-worker.yml`
- 是否必填：使用 Telegram webhook + Cloudflare Worker 时必填
- 获取位置：Cloudflare Dashboard 右侧账号信息里的 Account ID

#### `TELEGRAM_SECRET_TOKEN`

- 用途：设置 Telegram webhook 时写入 `secret_token`，必须与 Cloudflare Worker 的 `TELEGRAM_SECRET_TOKEN` 一致
- 使用工作流：`deploy-cloudflare-worker.yml`、`refresh-telegram-webhook.yml`
- 是否必填：使用 Telegram webhook + Cloudflare Worker 时必填
- 注意：这个值需要同时配置到 GitHub Actions Secret 和 Cloudflare Worker Secret；GitHub Actions 无法从 Cloudflare 反向读取 Secret 明文

### Variables

#### `AI_BASE_URL`

- 用途：截图识别和 Telegram `/analysis` 训练分析的 AI 服务基础地址
- 使用工作流：`telegram-sync.yml`、`telegram-sync-dev.yml`
- 是否必填：是
- 推荐值：

```text
https://api.openai.com/v1
```

#### `AI_MODEL`

- 用途：截图识别和 Telegram `/analysis` 训练分析模型名
- 使用工作流：`telegram-sync.yml`、`telegram-sync-dev.yml`
- 是否必填：是
- 推荐值：

```text
gpt-4.1
```

#### `AI_PROVIDER`

- 用途：选择 AI provider adapter
- 使用工作流：`telegram-sync.yml`、`telegram-sync-dev.yml`
- 是否必填：否
- 默认值：`openai-compatible`
- 说明：当前只实现 OpenAI-compatible Chat Completions 协议

#### `AI_TIMEOUT_MS`

- 用途：AI 请求超时时间，单位毫秒
- 使用工作流：`telegram-sync.yml`、`telegram-sync-dev.yml`
- 是否必填：否
- 说明：未配置时沿用 provider 默认超时语义

#### `AI_CONCURRENCY`

- 用途：并发识别数量
- 使用工作流：`telegram-sync.yml`、`telegram-sync-dev.yml`
- 是否必填：否
- 推荐值：

```text
3
```

#### `TRAINING_ANALYSIS_GOAL`

- 用途：覆盖 Telegram `/analysis` / `/分析` 的长期训练目标
- 使用工作流：`telegram-sync.yml`、`telegram-sync-dev.yml`
- 是否必填：否
- 默认值：未配置时使用“增肌减腹：优先增加或保住骨骼肌/瘦体重，同时通过整体减脂降低腰围和腹部脂肪；不追求单纯掉体重或局部减脂。”
- 推荐值：

```text
增肌减腹：优先增加或保住骨骼肌/瘦体重，同时通过整体减脂降低腰围和腹部脂肪；不追求单纯掉体重或局部减脂。
```

#### `TELEGRAM_ALLOWED_CHAT_IDS`

- 用途：允许自动处理的 Telegram chat id 白名单
- 使用工作流：`telegram-sync.yml`、`telegram-sync-dev.yml`
- 是否必填：是

#### `TELEGRAM_POLL_LIMIT`

- 用途：每轮轮询最多拉取多少条消息
- 使用工作流：`telegram-sync.yml`、`telegram-sync-dev.yml`
- 是否必填：否
- 推荐值：

```text
20
```

#### `TRAINING_SNAPSHOT_SOURCE`

- 用途：控制 Pages 构建时站点数据来自 `markdown` 还是 `database`
- 使用工作流：`deploy-pages.yml`、`deploy-cloudflare-pages-dev.yml`
- 是否必填：否
- 首次接入安全值：

```text
markdown
```

- 生产稳态推荐值：

```text
database
```

- 说明：`markdown` 只适合首次 bootstrap、本地兼容构建或数据库尚未接通时使用。当前线上长期口径是 PostgreSQL `core.*` 作为唯一事实源。

#### `TRAINING_DB_ENABLED`

- 用途：控制 GitHub Actions 是否启用 PostgreSQL 主链路
- 使用工作流：`deploy-pages.yml`、`deploy-cloudflare-pages-dev.yml`、`telegram-sync.yml`、`telegram-sync-dev.yml`
- 是否必填：否
- 首次接入安全值：

```text
false
```

- 生产稳态推荐值：

```text
true
```

- 说明：`false` 用于避免未配置数据库时误写或误读；正式 Telegram 同步、页面数据库构建和 DB-only 部署需要启用 PostgreSQL。

#### `TRAINING_DB_TIMEOUT_MS`

- 用途：数据库连接超时时间，单位毫秒
- 使用工作流：`deploy-pages.yml`、`deploy-cloudflare-pages-dev.yml`、`telegram-sync.yml`、`telegram-sync-dev.yml`
- 是否必填：否
- 推荐值：

```text
3000
```

#### `TRAINING_DB_APP_NAME`

- 用途：PostgreSQL 连接应用名
- 使用工作流：`deploy-pages.yml`、`deploy-cloudflare-pages-dev.yml`、`telegram-sync.yml`、`telegram-sync-dev.yml`
- 是否必填：否
- 推荐值：

```text
training-records-dashboard
```

#### `TELEGRAM_RECOGNITION_MODEL`

- 用途：只覆盖 Telegram 图片识别模型
- 使用工作流：`telegram-sync.yml`、`telegram-sync-dev.yml`
- 是否必填：否
- 默认值：未配置时使用 `AI_MODEL`

#### `TELEGRAM_RECOGNITION_FALLBACK_BASE_URL`

- 用途：Telegram 图片识别备用 AI 服务基础地址
- 使用工作流：`telegram-sync.yml`、`telegram-sync-dev.yml`
- 是否必填：否；启用备用 AI 时必填
- 推荐格式：

```text
https://api.openai.com/v1
```

#### `TELEGRAM_RECOGNITION_FALLBACK_MODEL`

- 用途：Telegram 图片识别备用 AI 模型名
- 使用工作流：`telegram-sync.yml`、`telegram-sync-dev.yml`
- 是否必填：否；启用备用 AI 时必填

#### `TELEGRAM_RECOGNITION_FALLBACK_TIMEOUT_MS`

- 用途：Telegram 图片识别备用 AI 请求超时时间，单位毫秒
- 使用工作流：`telegram-sync.yml`、`telegram-sync-dev.yml`
- 是否必填：否；未配置时沿用 `AI_TIMEOUT_MS`
- 推荐值：

```text
30000
```

#### `TELEGRAM_RECOGNITION_CACHE_ENABLED`

- 用途：控制 Telegram 图片识别是否读取数据库识别缓存
- 使用工作流：`telegram-sync.yml`、`telegram-sync-dev.yml`
- 是否必填：否
- 推荐值：按线上缓存命中率观察决定；本轮不强制默认开启

#### `TRAINING_BUILD_ARCHIVE_WRITE`

- 用途：控制 `npm run build:data` 是否写入 `archive.*`
- 使用工作流：`deploy-pages.yml`、`deploy-cloudflare-pages-dev.yml`
- 是否必填：否
- 可选值：`auto`、`true`、`false`
- 当前 workflow 行为：两个 deploy workflow 固定设置为 `false`，避免站点部署构建重复写 archive；本地默认 `auto`

#### `TELEGRAM_WEBHOOK_URL`

- 用途：Telegram webhook 目标地址
- 使用工作流：`deploy-cloudflare-worker.yml`、`refresh-telegram-webhook.yml`
- 是否必填：使用 Telegram webhook + Cloudflare Worker 时必填
- 当前默认 Worker URL：

```text
https://telegram-sync-dispatch.1406221797.workers.dev/
```

其中 `1406221797` 是 Cloudflare Workers 子域名，不是 `CLOUDFLARE_ACCOUNT_ID`。不要把 Dashboard 右侧的 32 位十六进制 Account ID 填到 `workers.dev` URL 中。

#### `CLOUDFLARE_PAGES_DEV_PROJECT_NAME`

- 用途：Dev 分支 Cloudflare Pages 预览项目名
- 使用工作流：`deploy-cloudflare-pages-dev.yml`
- 是否必填：否；未设置时使用 `training-records-dev`
- 默认访问地址：

```text
https://training-records-dev.pages.dev
```

### 建议的初始值

#### Secrets 模板

```text
TELEGRAM_BOT_TOKEN=你的 Telegram Bot Token
AI_API_KEY=你的 AI 平台 API Key
TELEGRAM_RECOGNITION_FALLBACK_API_KEY=你的备用 AI 平台 API Key
TRAINING_DB_URL=postgresql://training_writer:你的数据库密码@你的数据库公网IP或域名:5432/training_records
CLOUDFLARE_API_TOKEN=你的 Cloudflare API Token
CLOUDFLARE_ACCOUNT_ID=你的 Cloudflare Account ID
TELEGRAM_SECRET_TOKEN=你配置到 Cloudflare 的 TELEGRAM_SECRET_TOKEN
```

#### Variables 模板

```text
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4.1
AI_PROVIDER=openai-compatible
AI_TIMEOUT_MS=
AI_CONCURRENCY=3
TRAINING_ANALYSIS_GOAL=增肌减腹：优先增加或保住骨骼肌/瘦体重，同时通过整体减脂降低腰围和腹部脂肪；不追求单纯掉体重或局部减脂。
TELEGRAM_ALLOWED_CHAT_IDS=你的 Telegram Chat ID
TELEGRAM_POLL_LIMIT=20
TELEGRAM_RECOGNITION_MODEL=
TELEGRAM_RECOGNITION_FALLBACK_BASE_URL=
TELEGRAM_RECOGNITION_FALLBACK_MODEL=
TELEGRAM_RECOGNITION_FALLBACK_TIMEOUT_MS=
TELEGRAM_RECOGNITION_CACHE_ENABLED=
TRAINING_SNAPSHOT_SOURCE=markdown
TRAINING_DB_ENABLED=false
TRAINING_DB_TIMEOUT_MS=3000
TRAINING_DB_APP_NAME=training-records-dashboard
TRAINING_BUILD_ARCHIVE_WRITE=auto
TELEGRAM_WEBHOOK_URL=https://telegram-sync-dispatch.1406221797.workers.dev/
CLOUDFLARE_PAGES_DEV_PROJECT_NAME=training-records-dev
```

上面的 Variables 模板是首次 bootstrap 的安全起点。生产稳态确认 PostgreSQL 可读写后，应至少调整为：

```text
TRAINING_SNAPSHOT_SOURCE=database
TRAINING_DB_ENABLED=true
```

## 2. Cloudflare Worker

### 需要配置的变量与 Secret

在 Cloudflare Worker 的 `Settings -> Variables and Secrets` 中配置：

- Secret: `GITHUB_TOKEN`
- Secret: `TELEGRAM_BOT_TOKEN`
- Secret: `TELEGRAM_SECRET_TOKEN`
- Variable: `GITHUB_OWNER`（可选；默认 `soulgo`）
- Variable: `GITHUB_REPO`（可选；默认 `training_records`）
- Durable Object binding: `TELEGRAM_ALBUM_BUFFER`

当前仓库对应值：

- `GITHUB_OWNER=soulgo`
- `GITHUB_REPO=training_records`

如果这两个变量未配置，当前 Worker 会回落到上述仓库默认值，避免 Telegram webhook 因变量缺失直接返回 500。若后续复制到其他仓库，必须显式配置这两个变量。

`TELEGRAM_SECRET_TOKEN` 建议使用随机字符串，例如 PowerShell：

```powershell
[guid]::NewGuid().ToString('N')
```

说明：`/help`、`帮助` 等帮助消息只依赖 `TELEGRAM_SECRET_TOKEN` 和 `TELEGRAM_BOT_TOKEN`；普通同步消息仍依赖 `GITHUB_TOKEN` 才能 dispatch 到 GitHub Actions。如果缺少 `GITHUB_TOKEN` 或 GitHub dispatch 失败，Worker 会尽量用 `TELEGRAM_BOT_TOKEN` 回复原消息，说明“GitHub Action 未能启动”。

### Worker 代码

- 仓库内示例文件：[cloudflare/telegram-sync-dispatch-worker.mjs](../../cloudflare/telegram-sync-dispatch-worker.mjs)

它会：

1. 校验 Telegram webhook 请求头 `X-Telegram-Bot-Api-Secret-Token`
2. 对 `/help`、`帮助`、`命令`、`指令`、`使用说明` 直接调用 Telegram `sendMessage` 回发命令清单，不触发 GitHub Actions
3. 普通单条消息立即转发为 GitHub `repository_dispatch`
4. 相册消息按 `chat_id + media_group_id` 进入 `TelegramAlbumBuffer`，缓冲 3 秒后再合并派发
5. 触发类型固定为 `telegram_update`，payload 使用 `client_payload.telegram_updates`
6. GitHub dispatch 失败时直接回发 Telegram，不会误报为系统写入成功

如果没有配置 `TELEGRAM_ALBUM_BUFFER` 绑定，Worker 仍然会继续工作，但相册不会聚合，行为会退回为逐条 dispatch。

排查信号：如果 Cloudflare 对一次“合并发送”的相册显示多条 POST，同时 GitHub Actions 里出现多次 `Telegram Sync`，并且日志里的 `batchId` 相同，通常就是 `TELEGRAM_ALBUM_BUFFER` Durable Object 绑定没有在已部署的 Worker 上生效。

### Wrangler 配置

仓库根目录已经提供 [`wrangler.toml`](../../wrangler.toml)，核心绑定长这样：

```toml
[[durable_objects.bindings]]
name = "TELEGRAM_ALBUM_BUFFER"
class_name = "TelegramAlbumBuffer"
```

并在迁移里声明新 class：

```toml
[[migrations]]
tag = "v1"
new_sqlite_classes = ["TelegramAlbumBuffer"]
```

其中 `compatibility_date` 是 Cloudflare Workers 运行时兼容日期，不是训练记录日期，也不会参与图片日期识别。训练归档日期仍由 Telegram caption/text、截图 OCR 和同步逻辑自动决定。

把 `wrangler.toml` push 到 GitHub 只会更新仓库文件，不会自动修改 Cloudflare 控制台。Cloudflare 上的 Worker、变量和 Durable Object binding 只有在 Wrangler 部署成功后才会变化。

当前仓库已经提供 [`deploy-cloudflare-worker.yml`](../../.github/workflows/deploy-cloudflare-worker.yml)，它会在以下文件推到 `main` 后自动运行 `wrangler deploy`：

- `wrangler.toml`
- `cloudflare/**`
- `.github/workflows/deploy-cloudflare-worker.yml`

第一次使用前，需要先在 GitHub 仓库 `Settings -> Secrets and variables -> Actions -> Secrets` 添加：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

如果不想走 GitHub Actions，也可以在本地手动部署：

```powershell
npx wrangler deploy
```

## 3. GitHub Actions 行为

[`telegram-sync.yml`](../../.github/workflows/telegram-sync.yml) 现在支持：

- `repository_dispatch`
- `push` 到 `main` 且仅限 `训练记录.md`
- 手动 `workflow_dispatch`

并且运行时使用 `TELEGRAM_SYNC_TRANSPORT=webhook`：

- `repository_dispatch` 时直接消费 webhook payload
- `repository_dispatch` 使用快速路径：跳过全量 archive backfill、Markdown reconcile 和额外 export，只处理当前 Telegram payload、pending recognition 和 pending replay
- `push` / 手动触发时不会再调用 `getUpdates`
- `push` / 手动触发仍只执行安全数据库修复；Markdown reconcile/import/export 均为显式人工维护或备份 workflow
- 由 `github-actions[bot]` 推送出来的同步提交会跳过二次 `Telegram Sync`
- 仍然会重放待补偿批次，但不会即时刷新 Markdown
- 正常 `ready + stored` 图片批次不写 `训练记录.md`；人工账本由 DB -> Markdown 备份 workflow 导出
- Telegram main/dev workflow 会显式透传 `AI_PROVIDER`、`AI_TIMEOUT_MS`、`TELEGRAM_RECOGNITION_MODEL`、`TELEGRAM_RECOGNITION_FALLBACK_*` 和 `TELEGRAM_RECOGNITION_CACHE_ENABLED`；未配置时 provider 仍为 `openai-compatible`，图片识别模型回落到 `AI_MODEL`
- 如果完整配置了 `TELEGRAM_RECOGNITION_FALLBACK_API_KEY`、`TELEGRAM_RECOGNITION_FALLBACK_BASE_URL` 和 `TELEGRAM_RECOGNITION_FALLBACK_MODEL`，Telegram 图片识别会在主 AI timeout、HTTP 429/5xx、空内容或网络失败后自动切到备用 AI；备用 AI 只影响图片识别，不影响 `/analysis`
- 未显式开启 `TELEGRAM_SYNC_RUN_SLEEP_BACKFILL` 时，sleep backfill 只在 pending replay 或当前批次真实入库 sleep payload 后运行；非 sleep 图片不会触发
- 当同步产生文件变化或 DB-only 训练数据变化时，会异步 dispatch `deploy-pages.yml` 并启用严格数据库快照模式；站点构建结果到对应 deploy workflow 查看
- `repository_dispatch` 会写 GitHub Step Summary，按批次输出 `batchId`、`taskStatus`、`persistenceStatus`、`archivedDate`、图片计数、pending 状态、`failureDisposition` 和失败 message ids
- 成功通知步骤名是 `Notify Telegram sync result`，用于表示同步结果通知，不代表每个业务批次都一定已完整入库
- `repository_dispatch` 触发的同步如果在依赖安装、同步、测试、提交、rebase 或 push 阶段失败，会运行 `tools/telegram-action-monitor.mjs` 回发 Telegram。回复会包含失败阶段、`github_action` 分类和 GitHub Actions run URL。

[`deploy-pages.yml`](../../.github/workflows/deploy-pages.yml) 用于普通人工 push / 手动触发：

- 在 `main` 的站点相关文件真正发生 push 后再部署
- 不再因为一次 `Telegram Sync` 完成就无条件额外跑一次 Pages workflow
- 固定设置 `TRAINING_BUILD_ARCHIVE_WRITE=false`，站点构建生成数据文件但不重复写 `archive.*`

[`deploy-cloudflare-pages-dev.yml`](../../.github/workflows/deploy-cloudflare-pages-dev.yml) 用于 `dev` 分支在线预览：

- 调用共享 `site-build` 构建并运行快速测试
- 删除 `public/CNAME`，避免 dev Pages 带上生产自定义域名
- 使用固定 Wrangler 版本 direct upload `public/` 到 Cloudflare Pages
- 默认项目名为 `training-records-dev`，可用 `CLOUDFLARE_PAGES_DEV_PROJECT_NAME` 覆盖
- 固定设置 `TRAINING_BUILD_ARCHIVE_WRITE=false`，dev 预览构建不写 `archive.*`

## 4. 自动刷新 Telegram webhook

当前仓库已经提供自动刷新 webhook 的脚本和工作流：

- `npm run telegram:webhook`：调用 Telegram `setWebhook`
- `deploy-cloudflare-worker.yml`：Worker 部署成功后自动刷新 webhook
- `refresh-telegram-webhook.yml`：支持手动触发，并且每 6 小时自动刷新一次 webhook

这能覆盖更换 `TELEGRAM_BOT_TOKEN` 后忘记重新调用 `setWebhook` 的问题。GitHub Secrets 被修改时不会触发 workflow，所以更新 token 后有两种方式：

1. 到 GitHub Actions 手动运行 `Refresh Telegram Webhook`
2. 等待 `Refresh Telegram Webhook` 的 6 小时定时任务自动运行

自动刷新依赖以下配置：

- GitHub Actions Secret: `TELEGRAM_BOT_TOKEN`
- GitHub Actions Secret: `TELEGRAM_SECRET_TOKEN`
- GitHub Actions Variable: `TELEGRAM_WEBHOOK_URL`

其中 `TELEGRAM_SECRET_TOKEN` 必须和 Cloudflare Worker Secret 里的同名值一致，否则 Telegram 会正常把请求发到 Worker，但 Worker 会因为 secret header 不匹配返回 `401 unauthorized`。

如果需要本地手动兜底，也可以运行：

```powershell
$env:TELEGRAM_BOT_TOKEN = "你的 Telegram Bot Token"
$env:TELEGRAM_WEBHOOK_URL = "https://telegram-sync-dispatch.1406221797.workers.dev/"
$env:TELEGRAM_SECRET_TOKEN = "你配置到 Cloudflare 的 TELEGRAM_SECRET_TOKEN"
npm run telegram:webhook
```

等价的原始 Telegram API 请求是：

```powershell
$botToken = "你的 Telegram Bot Token"
$workerUrl = "https://telegram-sync-dispatch.1406221797.workers.dev/"
$secret = "你配置到 Cloudflare 的 TELEGRAM_SECRET_TOKEN"

Invoke-RestMethod `
  -Method Post `
  -Uri "https://api.telegram.org/bot$botToken/setWebhook" `
  -ContentType "application/json" `
  -Body (@{
    url = $workerUrl
    secret_token = $secret
    allowed_updates = @("message", "edited_message")
    drop_pending_updates = $false
  } | ConvertTo-Json)
```

## 5. 推荐配置顺序

1. 先配置 `TELEGRAM_BOT_TOKEN`、`AI_API_KEY`
2. 再配置 `AI_BASE_URL`、`AI_MODEL`、`AI_PROVIDER`、`AI_TIMEOUT_MS`、`AI_CONCURRENCY`、`TRAINING_ANALYSIS_GOAL`、`TELEGRAM_ALLOWED_CHAT_IDS`、`TELEGRAM_POLL_LIMIT`、`TELEGRAM_RECOGNITION_MODEL`、`TELEGRAM_RECOGNITION_FALLBACK_API_KEY`、`TELEGRAM_RECOGNITION_FALLBACK_BASE_URL`、`TELEGRAM_RECOGNITION_FALLBACK_MODEL`、`TELEGRAM_RECOGNITION_FALLBACK_TIMEOUT_MS`、`TELEGRAM_RECOGNITION_CACHE_ENABLED`
3. 再配置 `TRAINING_DB_URL`、`TRAINING_SNAPSHOT_SOURCE`、`TRAINING_DB_TIMEOUT_MS`、`TRAINING_DB_APP_NAME`
4. 先把 `TRAINING_DB_ENABLED` 设成 `false`
5. 本地确认 PostgreSQL 链路和 pending replay 链路都正常后，再改成 `TRAINING_DB_ENABLED=true`，并把生产构建切到 `TRAINING_SNAPSHOT_SOURCE=database`
6. 如果启用 Telegram webhook，再配置 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`
7. 再去 Cloudflare 配 `GITHUB_TOKEN`、`TELEGRAM_BOT_TOKEN`、`TELEGRAM_SECRET_TOKEN`、`GITHUB_OWNER`、`GITHUB_REPO` 和 `TELEGRAM_ALBUM_BUFFER`
8. 再在 GitHub Actions 配 `TELEGRAM_SECRET_TOKEN` Secret 和 `TELEGRAM_WEBHOOK_URL` Variable
9. 手动运行一次 `Deploy Cloudflare Worker` 或 `Refresh Telegram Webhook`

## 6. 验证方法

1. 给 Bot 发一张新的锻炼/饮食/体脂秤/睡眠截图，应触发 1 次 `Telegram Sync`
2. 给 Bot 发 2 张相册截图，应只触发 1 次 `Telegram Sync`
3. 给 Bot 发一条 `/thought 今天训练后背阔发力更明显` 或 `/随想 今天训练后背阔发力更明显`，应触发 1 次 `Telegram Sync`，并收到“随想写入成功”反馈
4. 给 Bot 发一条 `/analysis 今天怎么练` 或 `/分析 最近饮食怎么样`，应触发 1 次 `Telegram Sync`，并收到 Bot 回发的分析建议
5. 给 Bot 发一条 `/help` 或 `帮助`，应直接收到命令清单，且不触发 `Telegram Sync`
6. 直接编辑一条已经归档的 `/thought` / `/随想` 消息，应触发 1 次 `Telegram Sync`，并更新 `core.thought`
7. 回复原随想消息发送 `/随想删`，或单独发送 `/随想删 126`，应触发 1 次 `Telegram Sync`，并在 `core.thought` 中软删除
8. 在 Cloudflare Worker 请求日志确认收到了 `POST`
9. 在 GitHub Actions 确认普通同步请求被 `repository_dispatch` 触发
10. 临时使用无效的 Cloudflare `GITHUB_TOKEN` 验证时，应收到“GitHub Action 未能启动”反馈；恢复 token 后再继续测试

## 7. 当前实现下的重要说明

- `telegram-sync.yml` 现在会直接访问 PostgreSQL
- `telegram-sync.yml` 与 `telegram-sync-dev.yml` 都会透传 AI provider、timeout、识别模型、识别备用 AI 和识别缓存变量；当前 provider adapter 仍只支持 OpenAI-compatible 协议
- Telegram `/thought` 虽然不走图片识别，但当前 `npm run sync:telegram` 入口仍会统一校验 `AI_API_KEY`、`AI_BASE_URL`、`AI_MODEL`，所以这些变量不能省
- Telegram `/analysis` / `/分析` 不走图片识别、不写数据库、不提交仓库，但会读取现有 `TrainingSnapshot` 并调用 AI 回发建议，所以同样依赖 `AI_API_KEY`、`AI_BASE_URL`、`AI_MODEL` 和 `TELEGRAM_BOT_TOKEN`
- Telegram `/analysis` / `/分析` 默认长期目标是“增肌减腹”；如果配置了 `TRAINING_ANALYSIS_GOAL`，线上回复会优先使用该变量
- `/analysis` 的数据来源跟随 `TRAINING_SNAPSHOT_SOURCE`；如果配置为 `database`，还需要保证 `TRAINING_DB_ENABLED`、`TRAINING_DB_URL` 和 PostgreSQL `core.*` 数据可用
- PostgreSQL 失败时，Telegram 同步不会写 Markdown；会把待补偿批次写到 `runtime/telegram-sync-pending.ndjson`
- PostgreSQL 成功时，Telegram 图片批次只增量写入当前批次和目标日期汇总，不会删除同日其它模块，也不会每次全量覆盖 `训练记录.md`
- 对 `/thought` 来说，正文和模块信息以 `core.thought` 为准；图片只保留 `source/images/thoughts/` artifact，Markdown 文章由备份任务导出
- 随想新增、编辑、删除、移动现在会回发成功反馈；如果数据库失败，反馈会明确说明“数据库待补偿”
- 图片识别、随想和 `/analysis` 的失败反馈会尽量标注 `user_input`、`ai_service`、`telegram_api`、`database`、`github_action` 或 `system_bug`
- 睡眠截图按醒来日期减一天归档，并写入 `core.sleep` 和 `core.training_day` 睡眠汇总；`archive.training_sleep` 只作为历史回填/维护兼容层
- 默认 sleep backfill 不再由所有图片入库触发，只在真实 sleep 入库或显式 `TELEGRAM_SYNC_RUN_SLEEP_BACKFILL=true` 时运行
- PostgreSQL 恢复后，后续同步会先重放待补偿批次
- `deploy-pages.yml` 是否依赖 PostgreSQL，取决于 `TRAINING_SNAPSHOT_SOURCE`
  - `markdown`：页面构建不依赖 PostgreSQL
  - `database`：页面构建直接依赖 PostgreSQL
- `deploy-pages.yml` 与 `deploy-cloudflare-pages-dev.yml` 固定 `TRAINING_BUILD_ARCHIVE_WRITE=false`；本地 `build:data` 默认 `auto`，在 `markdown` 快照下仍可写 archive，在 `database + strict` 下会跳过 archive 写库
- `wrangler.toml` 推送到 GitHub 后，只有 `deploy-cloudflare-worker.yml` 成功运行，Cloudflare Worker 里的 Durable Object binding 才会真正更新
- GitHub Secrets 修改不会触发 workflow；更新 `TELEGRAM_BOT_TOKEN` 后，`refresh-telegram-webhook.yml` 会在 6 小时内自动刷新，也可以手动运行立即生效

## 8. Cloudflare CDN 代理（站点加速）

`soulgo.chat` 已通过 Cloudflare 代理（橙云）加速 GitHub Pages 站点访问。DNS 托管在 Cloudflare（NS: jason/gemma），CNAME 指向 `soulgo.github.io` 并开启代理。

详细方案见 [Cloudflare CDN 代理加速 v17](../优化重构/Cloudflare_CDN代理加速_v17/re_optimization_v17.md)。

### DNS 配置

| 类型 | 名称 | 目标 | 代理 | TTL |
|------|------|------|------|-----|
| CNAME | `@` | `soulgo.github.io` | **已代理（橙云）** | Auto |

- SSL/TLS 模式：**Full (Strict)**（GitHub Pages 自带 Let's Encrypt 证书）
- Always Use HTTPS：开启

### 性能开关

| 功能 | 路径 | 状态 |
|------|------|------|
| Auto Minify | Speed → Optimization | JS / CSS / HTML 已开启 |
| Brotli | Speed → Optimization | 已开启 |
| HTTP/3 (QUIC) | Network | 已开启 |
| 0-RTT Connection Resumption | Speed → Optimization | 已开启 |
| Early Hints | Speed → Optimization | 已开启 |

### 缓存规则（Cache Rules）

按优先级排列：

| 规则 | 匹配条件 | Edge TTL | Browser TTL |
|------|---------|----------|-------------|
| Font Assets Long Cache | `woff`, `woff2`, `ttf`, `otf` | 1 年 | 1 年 |
| Image Assets Long Cache | `jpg`, `jpeg`, `png`, `gif`, `webp`, `avif`, `svg`, `ico` | 30 天 | 30 天 |
| CSS and JS Medium Cache | `css`, `js` | 7 天 | 7 天 |
| HTML Short Cache SWR | `html`, `/`, 无扩展名路径 | Respect origin (10min) | 5 分钟 + `stale-while-revalidate=3600` |
| Skip Non-Page Paths | `/api/`, `/.well-known/` | Bypass | Bypass |

### Page Rules

- `soulgo.chat/*`：Cache Level = Cache Everything, Edge Cache TTL = 2 hours, Always Online = On

### 部署后清缓存

每次 GitHub Pages 部署后，Cloudflare 边缘缓存需要刷新：

- **手动方式**：Cloudflare Dashboard → Caching → Purge Everything
- **自动方式**（可选）：在 `deploy-pages.yml` 末尾调用 Cloudflare Purge Cache API，需要额外的 GitHub Secret `CLOUDFLARE_ZONE_ID` 和 API Token 的 `Zone → Cache Purge → Purge` 权限

### 回滚

如果 CDN 代理出现问题，在 Cloudflare Dashboard → DNS → 将 CNAME 代理状态切回 **DNS only（灰云）**，1 分钟内流量直接回 GitHub Pages Fastly CDN。

### 兼容性说明

- Telegram Worker (`telegram-sync-dispatch`) 部署在独立的 `workers.dev` 子域，与站点 CDN 代理互不干扰
- `source/CNAME` 中 `soulgo.chat` 保持不变，GitHub Pages 需要此文件识别自定义域名

## 9. SQL 文件约定

- 仓库当前只保留新库初始化脚本：[sql/pgsql17.sql](../../sql/pgsql17.sql)

如果你已经在现有库里手工执行过升级 SQL，那么接下来只需要保证数据库结构已经包含：

- `archive.*`
- `ingest.*`
- `core.*`

然后执行：

```bash
npm run import:markdown
```

或直接执行：

```bash
npm run sync:telegram
```

验证链路是否正常。
