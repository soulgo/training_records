# GitHub Settings 配置维护清单

这份文档专门记录当前仓库在 GitHub Settings 中需要配置的 Secrets 和 Variables，避免配置项散落在 workflow、README 和临时聊天记录里。

## 适用工作流

- `.github/workflows/deploy-pages.yml`
- `.github/workflows/telegram-sync.yml`

## GitHub Secrets

### `TELEGRAM_BOT_TOKEN`

- 用途：Telegram Bot 轮询消息所需的访问令牌。
- 是否必填：对 `telegram-sync.yml` 必填。
- 使用工作流：`telegram-sync.yml`
- 推荐值示例：`1234567890:AA...`
- 风险说明：泄露后他人可调用你的 Bot API，必须放在 Secret。

### `AI_API_KEY`

- 用途：截图识别所用 AI 服务的鉴权密钥。
- 是否必填：对 `telegram-sync.yml` 必填。
- 使用工作流：`telegram-sync.yml`
- 推荐值示例：由你的 AI 服务商分配。
- 风险说明：泄露后可能造成额度滥用，必须放在 Secret。

### `TRAINING_DB_URL`

- 用途：训练解析结果旁路写入 PostgreSQL 的连接串。
- 是否必填：仅当 `TRAINING_DB_ENABLED=true` 时必填。
- 使用工作流：`deploy-pages.yml`
- 推荐值示例：`postgresql://training_writer:你的强密码@db.example.com:5432/training_records`
- 风险说明：连接串包含账号密码，必须放在 Secret，不能放在 Variable。
- 如果你的 PostgreSQL 是自建云服务器，且当前没有启用 SSL，就不要追加 `?sslmode=require`，否则 GitHub Actions 会报 `The server does not support SSL connections`。
- 如果你后续给 PostgreSQL 开启了 SSL，再按实际情况改成 `?sslmode=require` 或更严格的 SSL 配置。

## GitHub Variables

### `AI_BASE_URL`

- 用途：AI 服务基础地址。
- 是否必填：对 `telegram-sync.yml` 必填。
- 使用工作流：`telegram-sync.yml`
- 推荐值示例：`https://api.openai.com/v1`
- 风险说明：通常不含敏感凭据，适合放 Variable。

### `AI_MODEL`

- 用途：截图识别模型名。
- 是否必填：对 `telegram-sync.yml` 必填。
- 使用工作流：`telegram-sync.yml`
- 推荐值示例：`gpt-4.1`
- 风险说明：模型名本身不敏感，但改错会导致识别失败。

### `AI_CONCURRENCY`

- 用途：单次 Telegram 同步中并发识别图片的数量。
- 是否必填：否。
- 使用工作流：`telegram-sync.yml`
- 推荐值示例：`3`
- 风险说明：过高会放大调用成本和限流风险。

### `TELEGRAM_ALLOWED_CHAT_IDS`

- 用途：允许被自动处理的 Telegram chat id 白名单。
- 是否必填：对 `telegram-sync.yml` 必填。
- 使用工作流：`telegram-sync.yml`
- 推荐值示例：`123456789,987654321`
- 风险说明：配置错误会导致合法消息被忽略，或错误接收外部消息。

### `TELEGRAM_POLL_LIMIT`

- 用途：每轮轮询 Telegram 更新时的最大拉取条数。
- 是否必填：否。
- 使用工作流：`telegram-sync.yml`
- 推荐值示例：`20`
- 风险说明：过高会增加单轮处理耗时。

### `TRAINING_DB_ENABLED`

- 用途：控制 GitHub Actions 构建时是否尝试写 PostgreSQL。
- 是否必填：否。
- 使用工作流：`deploy-pages.yml`
- 推荐值示例：`false` 或 `true`
- 风险说明：建议初期设为 `false`，待本地验证通过后再打开。

### `TRAINING_DB_TIMEOUT_MS`

- 用途：数据库连接超时时间，单位毫秒。
- 是否必填：否。
- 使用工作流：`deploy-pages.yml`
- 推荐值示例：`3000`
- 风险说明：过高会拖长 CI 构建等待时间。

### `TRAINING_DB_APP_NAME`

- 用途：PostgreSQL 连接的应用名，便于数据库侧审计。
- 是否必填：否。
- 使用工作流：`deploy-pages.yml`
- 推荐值示例：`training-records-dashboard`
- 风险说明：不敏感，但建议固定，方便排查来源。

## 数据库配置说明

- `TRAINING_DB_URL` 必须放 Secret，因为其中包含数据库主机、用户名和密码。
- `TRAINING_DB_ENABLED` 适合放 Variable，因为它只是一个开关，不包含敏感信息。
- CI 写库失败不阻断构建，是为了保证 GitHub Pages 发布仍以 `training.json` 主链路为准，不被云数据库波动拖垮。

## 本地与 CI 的差异

- 本地运行可以先手工设置环境变量并执行 `npm run build:data` 或 `npm run build` 验证写库。
- GitHub Actions 运行依赖 GitHub Secrets / Variables 注入，不会读取你本机的环境变量。
- 本地与 CI 都是旁路写库，站点展示仍只读取 `source/_data/training.json`。

## 推荐上线顺序

1. 在本地设置 `TRAINING_DB_ENABLED=true` 和 `TRAINING_DB_URL`，先执行 `npm run build:data` 验证 PostgreSQL 可写。
2. 本地验证通过后，在 GitHub Settings 中补齐 `TRAINING_DB_URL` Secret 和 `TRAINING_DB_*` Variables。
3. 把 `TRAINING_DB_ENABLED` 从 `false` 改为 `true`，再观察 `deploy-pages.yml` 的构建日志。

## 当前配置总表

### Secrets

- `TELEGRAM_BOT_TOKEN`
- `AI_API_KEY`
- `TRAINING_DB_URL`

### Variables

- `AI_BASE_URL`
- `AI_MODEL`
- `AI_CONCURRENCY`
- `TELEGRAM_ALLOWED_CHAT_IDS`
- `TELEGRAM_POLL_LIMIT`
- `TRAINING_DB_ENABLED`
- `TRAINING_DB_TIMEOUT_MS`
- `TRAINING_DB_APP_NAME`

## 最终需要在 GitHub 里配置的参数

下面这部分不是说明，而是你最终要在 GitHub 仓库里实际创建的配置清单。

### 最终必须创建的 Secrets

进入仓库：

- `Settings`
- `Secrets and variables`
- `Actions`
- `Secrets`
- `New repository secret`

你需要创建这 3 个 Secret：

#### 1. `TELEGRAM_BOT_TOKEN`

- Name：`TELEGRAM_BOT_TOKEN`
- Secret：填你的 Telegram Bot Token
- 示例：`1234567890:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

#### 2. `AI_API_KEY`

- Name：`AI_API_KEY`
- Secret：填你的 AI 平台 API Key
- 示例：`sk-xxxxxxxxxxxxxxxx`

#### 3. `TRAINING_DB_URL`

- Name：`TRAINING_DB_URL`
- Secret：填 PostgreSQL 连接串
- 推荐格式：

```text
postgresql://training_writer:你的数据库密码@你的数据库公网IP或域名:5432/training_records
```

- 如果你后续给 PostgreSQL 启用了 SSL，再改成：

```text
postgresql://training_writer:你的数据库密码@你的数据库公网IP或域名:5432/training_records?sslmode=require
```

- 如果你现在就是自建库且未启用 SSL，保持不带 `sslmode=require` 即可。

### 最终必须创建的 Variables

进入仓库：

- `Settings`
- `Secrets and variables`
- `Actions`
- `Variables`
- `New repository variable`

你需要创建这 8 个 Variable：

#### 1. `AI_BASE_URL`

- Name：`AI_BASE_URL`
- Value：你的 AI 接口基础地址
- 常见值：

```text
https://api.openai.com/v1
```

#### 2. `AI_MODEL`

- Name：`AI_MODEL`
- Value：你实际用于截图识别的模型名
- 示例：

```text
gpt-4.1
```

#### 3. `AI_CONCURRENCY`

- Name：`AI_CONCURRENCY`
- Value：并发识别数
- 推荐值：

```text
3
```

#### 4. `TELEGRAM_ALLOWED_CHAT_IDS`

- Name：`TELEGRAM_ALLOWED_CHAT_IDS`
- Value：允许同步的 Telegram chat id，多个用英文逗号分隔
- 示例：

```text
123456789,987654321
```

#### 5. `TELEGRAM_POLL_LIMIT`

- Name：`TELEGRAM_POLL_LIMIT`
- Value：每轮轮询最多拉取多少条消息
- 推荐值：

```text
20
```

#### 6. `TRAINING_DB_ENABLED`

- Name：`TRAINING_DB_ENABLED`
- Value：是否在 GitHub Actions 构建时尝试写 PostgreSQL
- 初始推荐值：

```text
false
```

- 当你本地验证没问题，并且 GitHub Secret `TRAINING_DB_URL` 也已经配置好后，再改成：

```text
true
```

#### 7. `TRAINING_DB_TIMEOUT_MS`

- Name：`TRAINING_DB_TIMEOUT_MS`
- Value：数据库连接超时毫秒数
- 推荐值：

```text
3000
```

#### 8. `TRAINING_DB_APP_NAME`

- Name：`TRAINING_DB_APP_NAME`
- Value：数据库连接应用名
- 推荐值：

```text
training-records-dashboard
```

## 建议你直接照着填的最终结果

如果你现在只是要把 GitHub Settings 一次性配完，可以直接按下面这份落：

### Secrets 最终值模板

```text
TELEGRAM_BOT_TOKEN=你的 Telegram Bot Token
AI_API_KEY=你的 AI 平台 API Key
TRAINING_DB_URL=postgresql://training_writer:你的数据库密码@你的数据库公网IP或域名:5432/training_records?sslmode=require
```

如果你当前数据库未启用 SSL，请改成：

```text
TRAINING_DB_URL=postgresql://training_writer:你的数据库密码@你的数据库公网IP或域名:5432/training_records
```

### Variables 最终值模板

```text
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4.1
AI_CONCURRENCY=3
TELEGRAM_ALLOWED_CHAT_IDS=你的 Telegram Chat ID
TELEGRAM_POLL_LIMIT=20
TRAINING_DB_ENABLED=false
TRAINING_DB_TIMEOUT_MS=3000
TRAINING_DB_APP_NAME=training-records-dashboard
```

## 配置顺序

建议按这个顺序操作：

1. 先创建 `TELEGRAM_BOT_TOKEN`、`AI_API_KEY`
2. 再创建 `AI_BASE_URL`、`AI_MODEL`、`AI_CONCURRENCY`、`TELEGRAM_ALLOWED_CHAT_IDS`、`TELEGRAM_POLL_LIMIT`
3. 再创建 `TRAINING_DB_URL`、`TRAINING_DB_TIMEOUT_MS`、`TRAINING_DB_APP_NAME`
4. 最后把 `TRAINING_DB_ENABLED` 先设成 `false`
5. 等你本地确认 PostgreSQL 写入正常后，再把 `TRAINING_DB_ENABLED` 改成 `true`

## 改完后如何检查

配置完成后，你可以这样验证：

### Telegram 配置检查

- 手动触发 `telegram-sync.yml`
- 看是否还能正常拉取并处理 Telegram 消息

### 数据库配置检查

- 先在本地执行：

```bash
npm run build:data
```

- 本地确认数据库能写入后，再把 GitHub 上的 `TRAINING_DB_ENABLED` 改成 `true`
- 然后手动触发 `deploy-pages.yml`
- 看构建日志里是否出现数据库连接或写入错误

## Action 写库频率与数据库压力

- 当前只有 `deploy-pages.yml` 会尝试写 PostgreSQL，`telegram-sync.yml` 不会直接写数据库。
- `deploy-pages.yml` 的触发条件是：
  - 推送到 `main`
  - 手动点击 `Run workflow`
- 也就是说，不是每 5 分钟都写一次数据库，只有发布站点时才写。
- 每次触发 `deploy-pages.yml`，都会尝试写一次数据库。

当前写库行为是：

- `archive.training_parse_snapshot`
  - 按 `source_hash` 做 upsert
  - 如果 `训练记录.md` 内容没变，不会新增很多重复快照，只会更新已有快照的 `last_seen_at`
- `archive.training_parse_run`
  - 每次构建成功都会新增 1 条运行记录

这意味着：

- 相同内容不会无限重复堆积整份大 JSON
- 但运行留痕表会随每次部署逐步增长

按你现在这个项目的体量，数据库压力通常很小，原因是：

- 单次写入只有 2 条 SQL 主操作
- `Deploy GitHub Pages` 触发频率本身不高
- 数据量主要集中在 1 条快照 JSON 和 1 条运行记录

真正需要关注的不是“瞬时压力”，而是长期运行记录增长。后续如果你部署很多次，可以定期清理旧的 `training_parse_run`，或者只保留最近几个月的数据。

如果你希望，我下一步可以继续帮你补一份“数据库运维建议”，包括：

- 查询最新同步结果的 SQL
- 查看最近失败记录的方法
- 定期清理 `training_parse_run` 的 SQL
