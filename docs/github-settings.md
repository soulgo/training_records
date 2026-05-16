# GitHub Settings 配置维护清单

这份文档记录当前仓库在 GitHub Settings 中需要配置的 Secrets 和 Variables。

## 适用工作流

- `.github/workflows/deploy-pages.yml`
- `.github/workflows/telegram-sync.yml`
- `.github/workflows/deploy-cloudflare-worker.yml`

## Secrets

### `TELEGRAM_BOT_TOKEN`

- 用途：Telegram Bot 轮询消息
- 使用工作流：`telegram-sync.yml`
- 是否必填：是

### `AI_API_KEY`

- 用途：截图识别和 Telegram `/analysis` 训练分析所用 AI 服务鉴权
- 使用工作流：`telegram-sync.yml`
- 是否必填：是

### `TRAINING_DB_URL`

- 用途：PostgreSQL 连接串
- 使用工作流：`deploy-pages.yml`、`telegram-sync.yml`
- 是否必填：当 `TRAINING_DB_ENABLED=true` 时必填
- 推荐格式：

```text
postgresql://training_writer:你的数据库密码@你的数据库公网IP或域名:5432/training_records
```

- 如果你的数据库启用了 SSL，再按实际情况追加 `?sslmode=require`

### `CLOUDFLARE_API_TOKEN`

- 用途：让 GitHub Actions 调用 Wrangler 部署 Cloudflare Worker
- 使用工作流：`deploy-cloudflare-worker.yml`
- 是否必填：使用 Telegram webhook + Cloudflare Worker 时必填
- 权限建议：Cloudflare API Token 至少需要能编辑当前账号下的 Workers Scripts

### `CLOUDFLARE_ACCOUNT_ID`

- 用途：指定 Wrangler 要部署到哪个 Cloudflare 账号
- 使用工作流：`deploy-cloudflare-worker.yml`
- 是否必填：使用 Telegram webhook + Cloudflare Worker 时必填
- 获取位置：Cloudflare Dashboard 右侧账号信息里的 Account ID

## Variables

### `AI_BASE_URL`

- 用途：截图识别和 Telegram `/analysis` 训练分析的 AI 服务基础地址
- 使用工作流：`telegram-sync.yml`
- 是否必填：是
- 推荐值：

```text
https://api.openai.com/v1
```

### `AI_MODEL`

- 用途：截图识别和 Telegram `/analysis` 训练分析模型名
- 使用工作流：`telegram-sync.yml`
- 是否必填：是
- 推荐值：

```text
gpt-4.1
```

### `AI_CONCURRENCY`

- 用途：并发识别数量
- 使用工作流：`telegram-sync.yml`
- 是否必填：否
- 推荐值：

```text
3
```

### `TRAINING_ANALYSIS_GOAL`

- 用途：覆盖 Telegram `/analysis` / `/分析` 的长期训练目标
- 使用工作流：`telegram-sync.yml`
- 是否必填：否
- 默认值：未配置时使用“增肌减腹：优先增加或保住骨骼肌/瘦体重，同时通过整体减脂降低腰围和腹部脂肪；不追求单纯掉体重或局部减脂。”
- 推荐值：

```text
增肌减腹：优先增加或保住骨骼肌/瘦体重，同时通过整体减脂降低腰围和腹部脂肪；不追求单纯掉体重或局部减脂。
```

### `TELEGRAM_ALLOWED_CHAT_IDS`

- 用途：允许自动处理的 Telegram chat id 白名单
- 使用工作流：`telegram-sync.yml`
- 是否必填：是

### `TELEGRAM_POLL_LIMIT`

- 用途：每轮轮询最多拉取多少条消息
- 使用工作流：`telegram-sync.yml`
- 是否必填：否
- 推荐值：

```text
20
```

### `TRAINING_SNAPSHOT_SOURCE`

- 用途：控制 Pages 构建时站点数据来自 `markdown` 还是 `database`
- 使用工作流：`deploy-pages.yml`
- 是否必填：否
- 推荐值：

```text
markdown
```

- 如果你确认页面构建直接读取 PostgreSQL，再改成：

```text
database
```

### `TRAINING_DB_ENABLED`

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

### `TRAINING_DB_TIMEOUT_MS`

- 用途：数据库连接超时时间，单位毫秒
- 使用工作流：`deploy-pages.yml`、`telegram-sync.yml`
- 是否必填：否
- 推荐值：

```text
3000
```

### `TRAINING_DB_APP_NAME`

- 用途：PostgreSQL 连接应用名
- 使用工作流：`deploy-pages.yml`、`telegram-sync.yml`
- 是否必填：否
- 推荐值：

```text
training-records-dashboard
```

## 最终需要配置的参数

### Secrets

- `TELEGRAM_BOT_TOKEN`
- `AI_API_KEY`
- `TRAINING_DB_URL`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

### Variables

- `AI_BASE_URL`
- `AI_MODEL`
- `AI_CONCURRENCY`
- `TELEGRAM_ALLOWED_CHAT_IDS`
- `TELEGRAM_POLL_LIMIT`
- `TRAINING_SNAPSHOT_SOURCE`
- `TRAINING_DB_ENABLED`
- `TRAINING_DB_TIMEOUT_MS`
- `TRAINING_DB_APP_NAME`

## 建议的初始值

### Secrets 模板

```text
TELEGRAM_BOT_TOKEN=你的 Telegram Bot Token
AI_API_KEY=你的 AI 平台 API Key
TRAINING_DB_URL=postgresql://training_writer:你的数据库密码@你的数据库公网IP或域名:5432/training_records
CLOUDFLARE_API_TOKEN=你的 Cloudflare API Token
CLOUDFLARE_ACCOUNT_ID=你的 Cloudflare Account ID
```

### Variables 模板

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

## 推荐配置顺序

1. 先配置 `TELEGRAM_BOT_TOKEN`、`AI_API_KEY`
2. 再配置 `AI_BASE_URL`、`AI_MODEL`、`AI_CONCURRENCY`、`TRAINING_ANALYSIS_GOAL`、`TELEGRAM_ALLOWED_CHAT_IDS`、`TELEGRAM_POLL_LIMIT`
3. 再配置 `TRAINING_DB_URL`、`TRAINING_SNAPSHOT_SOURCE`、`TRAINING_DB_TIMEOUT_MS`、`TRAINING_DB_APP_NAME`
4. 先把 `TRAINING_DB_ENABLED` 设成 `false`
5. 本地确认 PostgreSQL 链路和回退链路都正常后，再改成 `true`
6. 如果启用 Telegram webhook，再配置 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`

## 当前实现下的重要说明

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

## SQL 文件约定

- 仓库当前只保留新库初始化脚本：[sql/pgsql17.sql](/C:/Users/ljq90/Desktop/project_test/健身锻炼/sql/pgsql17.sql)

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
