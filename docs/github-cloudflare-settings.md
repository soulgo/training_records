# GitHub + Cloudflare 统一配置清单

本文件合并原 `github-settings.md` 与 `telegram-webhook-cloudflare.md`，用于一次性配置 GitHub Settings、GitHub Actions 和 Cloudflare Worker。

## 适用工作流

- `.github/workflows/deploy-pages.yml`
- `.github/workflows/telegram-sync.yml`
- `.github/workflows/deploy-cloudflare-worker.yml`

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

### Variables

#### `AI_BASE_URL`

- 用途：截图识别和 Telegram `/analysis` 训练分析的 AI 服务基础地址
- 使用工作流：`telegram-sync.yml`
- 是否必填：是
- 推荐值：

```text
https://api.openai.com/v1
```

#### `AI_MODEL`

- 用途：截图识别和 Telegram `/analysis` 训练分析模型名
- 使用工作流：`telegram-sync.yml`
- 是否必填：是
- 推荐值：

```text
gpt-4.1
```

#### `AI_CONCURRENCY`

- 用途：并发识别数量
- 使用工作流：`telegram-sync.yml`
- 是否必填：否
- 推荐值：

```text
3
```

#### `TRAINING_ANALYSIS_GOAL`

- 用途：覆盖 Telegram `/analysis` / `/分析` 的长期训练目标
- 使用工作流：`telegram-sync.yml`
- 是否必填：否
- 默认值：未配置时使用“增肌减腹：优先增加或保住骨骼肌/瘦体重，同时通过整体减脂降低腰围和腹部脂肪；不追求单纯掉体重或局部减脂。”
- 推荐值：

```text
增肌减腹：优先增加或保住骨骼肌/瘦体重，同时通过整体减脂降低腰围和腹部脂肪；不追求单纯掉体重或局部减脂。
```

#### `TELEGRAM_ALLOWED_CHAT_IDS`

- 用途：允许自动处理的 Telegram chat id 白名单
- 使用工作流：`telegram-sync.yml`
- 是否必填：是

#### `TELEGRAM_POLL_LIMIT`

- 用途：每轮轮询最多拉取多少条消息
- 使用工作流：`telegram-sync.yml`
- 是否必填：否
- 推荐值：

```text
20
```

#### `TRAINING_SNAPSHOT_SOURCE`

- 用途：控制 Pages 构建时站点数据来自 `markdown` 还是 `database`
- 使用工作流：`deploy-pages.yml`
- 是否必填：否
- 推荐值：

```text
markdown
```

- 如果确认页面构建直接读取 PostgreSQL，再改成：

```text
database
```

#### `TRAINING_DB_ENABLED`

- 用途：控制 GitHub Actions 是否启用 PostgreSQL 主链路
- 使用工作流：`deploy-pages.yml`、`telegram-sync.yml`
- 是否必填：否
- 推荐值：

```text
false
```

- 数据库链路本地和线上都确认没问题后，再改成：

```text
true
```

#### `TRAINING_DB_TIMEOUT_MS`

- 用途：数据库连接超时时间，单位毫秒
- 使用工作流：`deploy-pages.yml`、`telegram-sync.yml`
- 是否必填：否
- 推荐值：

```text
3000
```

#### `TRAINING_DB_APP_NAME`

- 用途：PostgreSQL 连接应用名
- 使用工作流：`deploy-pages.yml`、`telegram-sync.yml`
- 是否必填：否
- 推荐值：

```text
training-records-dashboard
```

### 建议的初始值

#### Secrets 模板

```text
TELEGRAM_BOT_TOKEN=你的 Telegram Bot Token
AI_API_KEY=你的 AI 平台 API Key
TRAINING_DB_URL=postgresql://training_writer:你的数据库密码@你的数据库公网IP或域名:5432/training_records
CLOUDFLARE_API_TOKEN=你的 Cloudflare API Token
CLOUDFLARE_ACCOUNT_ID=你的 Cloudflare Account ID
```

#### Variables 模板

```text
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4.1
AI_CONCURRENCY=3
TRAINING_ANALYSIS_GOAL=增肌减腹：优先增加或保住骨骼肌/瘦体重，同时通过整体减脂降低腰围和腹部脂肪；不追求单纯掉体重或局部减脂。
TELEGRAM_ALLOWED_CHAT_IDS=你的 Telegram Chat ID
TELEGRAM_POLL_LIMIT=20
TRAINING_SNAPSHOT_SOURCE=markdown
TRAINING_DB_ENABLED=false
TRAINING_DB_TIMEOUT_MS=3000
TRAINING_DB_APP_NAME=training-records-dashboard
```

## 2. Cloudflare Worker

### 需要配置的变量与 Secret

在 Cloudflare Worker 的 `Settings -> Variables and Secrets` 中配置：

- Secret: `GITHUB_TOKEN`
- Secret: `TELEGRAM_SECRET_TOKEN`
- Variable: `GITHUB_OWNER`
- Variable: `GITHUB_REPO`
- Durable Object binding: `TELEGRAM_ALBUM_BUFFER`

当前仓库对应值：

- `GITHUB_OWNER=soulgo`
- `GITHUB_REPO=training_records`

`TELEGRAM_SECRET_TOKEN` 建议使用随机字符串，例如 PowerShell：

```powershell
[guid]::NewGuid().ToString('N')
```

### Worker 代码

- 仓库内示例文件：[cloudflare/telegram-sync-dispatch-worker.mjs](../cloudflare/telegram-sync-dispatch-worker.mjs)

它会：

1. 校验 Telegram webhook 请求头 `X-Telegram-Bot-Api-Secret-Token`
2. 普通单条消息立即转发为 GitHub `repository_dispatch`
3. 相册消息按 `chat_id + media_group_id` 进入 `TelegramAlbumBuffer`，缓冲 3 秒后再合并派发
4. 触发类型固定为 `telegram_update`，payload 使用 `client_payload.telegram_updates`

如果没有配置 `TELEGRAM_ALBUM_BUFFER` 绑定，Worker 仍然会继续工作，但相册不会聚合，行为会退回为逐条 dispatch。

排查信号：如果 Cloudflare 对一次“合并发送”的相册显示多条 POST，同时 GitHub Actions 里出现多次 `Telegram Sync`，并且日志里的 `batchId` 相同，通常就是 `TELEGRAM_ALBUM_BUFFER` Durable Object 绑定没有在已部署的 Worker 上生效。

### Wrangler 配置

仓库根目录已经提供 [`wrangler.toml`](../wrangler.toml)，核心绑定长这样：

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

当前仓库已经提供 [`deploy-cloudflare-worker.yml`](../.github/workflows/deploy-cloudflare-worker.yml)，它会在以下文件推到 `main` 后自动运行 `wrangler deploy`：

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

[`telegram-sync.yml`](../.github/workflows/telegram-sync.yml) 现在支持：

- `repository_dispatch`
- `push` 到 `main` 且仅限 `训练记录.md`
- 手动 `workflow_dispatch`

并且运行时使用 `TELEGRAM_SYNC_TRANSPORT=webhook`：

- `repository_dispatch` 时直接消费 webhook payload
- `repository_dispatch` 使用快速路径：跳过全量 archive backfill、Markdown reconcile 和额外 export，只处理当前 Telegram payload 与 pending fallback
- `push` / 手动触发时不会再调用 `getUpdates`
- `push` / 手动触发仍会执行完整 backfill、reconcile 和 export，用于维护或修复主数据
- 由 `github-actions[bot]` 推送出来的同步提交会跳过二次 `Telegram Sync`
- 仍然会重放待补偿批次并在需要时刷新 Markdown
- 当同步提交了新的 `训练记录.md` 后，会在同一个 workflow 里直接构建并部署 GitHub Pages；不能依赖 bot push 再触发独立的 Pages workflow

[`deploy-pages.yml`](../.github/workflows/deploy-pages.yml) 用于普通人工 push / 手动触发：

- 在 `main` 的站点相关文件真正发生 push 后再部署
- 不再因为一次 `Telegram Sync` 完成就无条件额外跑一次 Pages workflow

## 4. 设置 Telegram webhook

在仓库代码和 Worker 都部署完成后，再执行：

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
2. 再配置 `AI_BASE_URL`、`AI_MODEL`、`AI_CONCURRENCY`、`TRAINING_ANALYSIS_GOAL`、`TELEGRAM_ALLOWED_CHAT_IDS`、`TELEGRAM_POLL_LIMIT`
3. 再配置 `TRAINING_DB_URL`、`TRAINING_SNAPSHOT_SOURCE`、`TRAINING_DB_TIMEOUT_MS`、`TRAINING_DB_APP_NAME`
4. 先把 `TRAINING_DB_ENABLED` 设成 `false`
5. 本地确认 PostgreSQL 链路和回退链路都正常后，再改成 `true`
6. 如果启用 Telegram webhook，再配置 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`
7. 再去 Cloudflare 配 `GITHUB_TOKEN`、`TELEGRAM_SECRET_TOKEN`、`GITHUB_OWNER`、`GITHUB_REPO` 和 `TELEGRAM_ALBUM_BUFFER`

## 6. 验证方法

1. 给 Bot 发一张新的训练/饮食/体脂截图，应触发 1 次 `Telegram Sync`
2. 给 Bot 发 2 张相册截图，应只触发 1 次 `Telegram Sync`
3. 给 Bot 发一条 `/thought 今天训练后背阔发力更明显` 或 `/随想 今天训练后背阔发力更明显`，应触发 1 次 `Telegram Sync`
4. 给 Bot 发一条 `/analysis 今天怎么练` 或 `/分析 最近饮食怎么样`，应触发 1 次 `Telegram Sync`，并收到 Bot 回发的分析建议
5. 直接编辑一条已经归档的 `/thought` / `/随想` 消息，应触发 1 次 `Telegram Sync`，并更新对应 `source/_posts` 里的正文
6. 回复原随想消息发送 `/随想删`，或单独发送 `/随想删 126`，应触发 1 次 `Telegram Sync`，并删除对应随想文件；带图时还应删除 `source/images/thoughts/` 里的图片
7. 在 Cloudflare Worker 请求日志确认收到了 `POST`
8. 在 GitHub Actions 确认 `Telegram Sync` 被 `repository_dispatch` 触发

## 7. 当前实现下的重要说明

- `telegram-sync.yml` 现在会直接访问 PostgreSQL
- Telegram `/thought` 虽然不走图片识别，但当前 `npm run sync:telegram` 入口仍会统一校验 `AI_API_KEY`、`AI_BASE_URL`、`AI_MODEL`，所以这些变量不能省
- Telegram `/analysis` / `/分析` 不走图片识别、不写数据库、不提交仓库，但会读取现有 `TrainingSnapshot` 并调用 AI 回发建议，所以同样依赖 `AI_API_KEY`、`AI_BASE_URL`、`AI_MODEL` 和 `TELEGRAM_BOT_TOKEN`
- Telegram `/analysis` / `/分析` 默认长期目标是“增肌减腹”；如果配置了 `TRAINING_ANALYSIS_GOAL`，线上回复会优先使用该变量
- `/analysis` 的数据来源跟随 `TRAINING_SNAPSHOT_SOURCE`；如果配置为 `database`，还需要保证 `TRAINING_DB_ENABLED`、`TRAINING_DB_URL` 和 PostgreSQL `core.*` 数据可用
- PostgreSQL 失败时，Telegram 同步会回退写 Markdown，并把待补偿批次写到 `runtime/telegram-sync-pending.ndjson`
- 对 `/thought` 来说，“回退写 Markdown”指的是保留已经生成在 `source/_posts/` 下的随想文件，并把待补偿入库信息写到 `runtime/telegram-sync-pending.ndjson`
- PostgreSQL 恢复后，后续同步会先重放待补偿批次
- `deploy-pages.yml` 是否依赖 PostgreSQL，取决于 `TRAINING_SNAPSHOT_SOURCE`
  - `markdown`：页面构建不依赖 PostgreSQL
  - `database`：页面构建直接依赖 PostgreSQL
- `wrangler.toml` 推送到 GitHub 后，只有 `deploy-cloudflare-worker.yml` 成功运行，Cloudflare Worker 里的 Durable Object binding 才会真正更新

## 8. SQL 文件约定

- 仓库当前只保留新库初始化脚本：[sql/pgsql17.sql](../sql/pgsql17.sql)

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
