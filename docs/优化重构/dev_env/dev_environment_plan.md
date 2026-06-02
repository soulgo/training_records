# Dev 环境方案

> 基于2026-06-02仓库代码和文档静态分析。目标是为后续新版本开发和测试建立最小化维护成本的 Dev 环境。
>
> 核心原则：最小化配置、最大复用现有基础设施、不影响生产环境。

---

## 1. 当前架构分析

### 1.1 Telegram 链路

```
用户 → Telegram Bot → Cloudflare Worker (webhook)
       → GitHub repository_dispatch (event_type: telegram_update)
       → .github/workflows/telegram-sync.yml (main 分支)
       → tools/telegram-sync.mjs → AI识别 → PostgreSQL写入 / Markdown回退
```

关键约束：

- Cloudflare Worker 硬编码分派到 `soulgo/training_records`，事件类型 `telegram_update`
- `telegram-sync.yml` 配置 `TELEGRAM_SYNC_TRANSPORT=webhook`，直接消费 dispatch payload
- `repository_dispatch` 要求触发的工作流文件必须存在于仓库 **默认分支**（main）
- Worker 通过 `X-Telegram-Bot-Api-Secret-Token` 头校验请求合法性
- 帮助消息（/help、帮助等）由 Worker 直接回复，不触发 GitHub Actions

### 1.2 Cloudflare 配置

- 单个 Worker `telegram-sync-dispatch`，使用 Durable Object `TELEGRAM_ALBUM_BUFFER` 聚合相册
- 无 KV、无 D1、无 Pages（站点由 GitHub Pages 托管）
- Worker 部署通过 `deploy-cloudflare-worker.yml` + Wrangler
- Worker secrets: `GITHUB_TOKEN`、`TELEGRAM_BOT_TOKEN`、`TELEGRAM_SECRET_TOKEN`
- Worker variables: `GITHUB_OWNER`（默认 `soulgo`）、`GITHUB_REPO`（默认 `training_records`）

### 1.3 PostgreSQL

- 数据库 `training_records`，用户 `training_writer`
- 三个 schema：`ingest`（原始接入）、`core`（主数据）、`archive`（构建快照）
- 连接通过 `TRAINING_DB_URL`（Secret）、`TRAINING_DB_ENABLED`（Variable）
- 数据库写入包含幂等保护（payload hash、message_id 主键、batch_id 主键）
- 失败回退：训练数据写 `训练记录.md`，随想保留 `source/_posts`，追加 `runtime/telegram-sync-pending.ndjson`

### 1.4 GitHub 部署

- **CI Tests** (`ci-tests.yml`)：push/PR 到 main，运行 `npm run test:fast`
- **Deploy Pages** (`deploy-pages.yml`)：push 到 main 且站点文件变更，构建并部署到 GitHub Pages（`soulgo.chat`）
- **Telegram Sync** (`telegram-sync.yml`)：`repository_dispatch: telegram_update`、push `训练记录.md`、手动触发
- **Deploy Worker** (`deploy-cloudflare-worker.yml`)：push main 的 Worker 相关文件
- **Refresh Webhook** (`refresh-telegram-webhook.yml`)：每6小时自动刷新 + 手动触发
- 共享 composite action：`.github/actions/site-build/action.yml`

---

## 2. Dev 环境设计方案

### 2.1 Telegram Bot：推荐单独创建 Dev Bot

#### 方案一：共用一个 Bot（不推荐）

| 维度 | 分析 |
| --- | --- |
| 优点 | 零新配置；无需额外 BotFather 操作 |
| 缺点 | Telegram `getUpdates` 的 offset 机制导致一条消息只能被一个消费者处理。Webhook 模式下，dispatch 始终触发 main 分支的工作流（`repository_dispatch` 只能触发默认分支上的工作流文件）。Dev 无法独立接收和处理消息 |
| 风险 | Dev 测试会直接触发生产同步，污染生产数据 |

结论：共用 Bot 在 `repository_dispatch` 机制下**不可行**。

#### 方案二：单独创建 Dev Bot（推荐）

| 维度 | 分析 |
| --- | --- |
| 优点 | 完全隔离生产数据；可独立测试 webhook → Worker → dispatch → sync 全链路；Prompt 调优和生产互不影响 |
| 缺点 | 需在 @BotFather 创建一个新 Bot（2 分钟）；需额外配置 1 组 Worker secrets 和 GitHub secrets |
| 风险 | 低。Dev Bot 仅开发者本人使用，范围可控 |

**推荐方案二。** 理由：
1. `repository_dispatch` 架构限制导致共用 Bot 不可行
2. 新增维护成本极低（一个 Bot token + 一组 secrets）
3. Prompt 调优和 Telegram Sync 测试需要完全隔离的消息流

#### 实现方式

1. 通过 @BotFather 创建 Dev Bot，获取 `TELEGRAM_BOT_TOKEN_DEV`
2. 部署一个 Dev Cloudflare Worker（见 2.2 节），设置 Dev Bot webhook 指向该 Worker
3. 在 main 分支新增 `telegram-sync-dev.yml`，监听 `repository_dispatch: telegram_update_dev`
4. Dev 工作流 checkout `dev` 分支，连接 dev 数据库

### 2.2 Cloudflare：推荐新增一个 Dev Worker，其余全部共用

| 资源 | 决策 | 理由 |
| --- | --- | --- |
| **Worker** | **新增** `telegram-sync-dispatch-dev` | Dev Bot 需要独立的 webhook 入口；代码与生产 Worker 完全相同，仅 secrets 不同 |
| **KV** | 不涉及 | 当前未使用 KV |
| **D1** | 不涉及 | 当前未使用 D1 |
| **Pages** | 不涉及 | 站点由 GitHub Pages 托管 |
| **Durable Object** | **共用** `TELEGRAM_ALBUM_BUFFER` class | DO 是 Worker 内部绑定的 class 实例，每个 Worker 独立创建；无需额外操作 |
| **域名/Route** | **共用** Cloudflare 账号下的 `workers.dev` 子域名 | 每个 Worker 自动获得独立 URL：`telegram-sync-dispatch-dev.<account>.workers.dev` |

新增一个 Worker 的维护成本：
- `wrangler.toml` 复制一份为 `wrangler.dev.toml`（仅修改 `name`）
- 新增 `deploy-cloudflare-worker-dev.yml` 工作流（或手动部署）
- 3 个 Cloudflare secrets（`GITHUB_TOKEN_DEV`、`TELEGRAM_BOT_TOKEN_DEV`、`TELEGRAM_SECRET_TOKEN_DEV`）

**不需要**创建单独的 Cloudflare 账号、单独的 KV namespace、单独的 D1 database。

### 2.3 PostgreSQL：推荐新建独立数据库

| 维度 | 分析 |
| --- | --- |
| **共用数据库 + 单独 Schema** | 维护成本低，但 schema 命名需全局修改。Dev sync 写入 `ingest_dev`、`core_dev` 等，所有 SQL 表名需参数化。代码侵入性高 |
| **共用数据库 + 共用 Schema** | 最低成本，但 dev 数据会混入生产。`core.training_day` 主键是 `archived_date`，dev 和 prod 会冲突。**不可行** |
| **单独数据库 `training_records_dev`**（推荐） | 完全隔离。零代码修改——仅需一个不同的 `TRAINING_DB_URL`。执行相同的 `pgsql17.sql` 初始化 |
| **无数据库（仅 Markdown 模式）** | 最简单，但无法测试 DB 写入、读取、缓存、pending recognition 等核心功能 |

**推荐单独数据库。** 理由：
1. 仅需一条 SQL：`CREATE DATABASE training_records_dev OWNER training_writer;`
2. 零代码修改，仅 `TRAINING_DB_URL` 指向不同库
3. Dev 可以放心执行 `backfill:core`、`export:markdown`、`reconcile:markdown` 等操作
4. 删除重建成本极低：`DROP DATABASE training_records_dev; CREATE DATABASE ...;`

### 2.4 Dev Pages：使用 Cloudflare Pages 在线预览

| 决策 | 理由 |
| --- | --- |
| GitHub Pages 只保留生产站点 | GitHub Pages 一个仓库只支持一个站点，继续由 `main` 部署到 `soulgo.chat` |
| Dev 站点部署到 Cloudflare Pages | `dev` 分支 push 后构建 `public/`，通过 Wrangler Direct Upload 发布到独立 Pages 项目，默认地址为 `https://training-records-dev.pages.dev` |
| 保留本地预览 | 本地仍可用 `npm run server` 快速调试，Cloudflare Pages 用于手机或远端浏览器验收 |

Dev Pages workflow 会在上传前删除 `public/CNAME`，避免 dev 预览携带生产域名 `soulgo.chat`。

### 2.5 GitHub 分支策略：推荐 `main` + `dev` 双分支

| 维度 | 分析 |
| --- | --- |
| 项目规模 | 单人开发，当前仅 `main` 分支，PR 极少 |
| 推荐结构 | `main`（生产）+ `dev`（开发集成） |
| 是否需 `feature/*` | 不建议。单人项目引入 feature 分支增加合并开销，收益有限。如未来需求变大可再引入 |
| 开发流程 | `dev` 分支开发 → 测试通过 → PR 合并到 `main` |
| 发布流程 | 合并到 `main` → CI 通过 → 自动部署 Pages + Worker |

`main` 分支保护建议：
- 禁止直接 push 到 main（仅通过 PR）
- PR 需 CI 通过
- 允许 `github-actions[bot]` 绕过（Telegram Sync 自动提交）

---

## 3. 配置方案

### 3.1 配置明细

| 配置项 | 生产（main） | 开发（dev） | 说明 |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | 现有 Bot | **新增** Dev Bot | 通过 @BotFather 创建 |
| `TELEGRAM_SECRET_TOKEN` | 现有值 | **新增** 随机字符串 | Worker 与 webhook 需一致 |
| `TELEGRAM_WEBHOOK_URL` | `https://telegram-sync-dispatch...workers.dev/` | **新增** Dev Worker URL | |
| `TELEGRAM_ALLOWED_CHAT_IDS` | 现有值 | **共用** | 同一用户，ID 不变 |
| `AI_API_KEY` | 现有值 | **共用** | 同一 AI 服务商 |
| `AI_BASE_URL` | 现有值 | **共用** | |
| `AI_MODEL` | 现有值 | **共用** | |
| `AI_CONCURRENCY` | 现有值 | **共用** | |
| `TRAINING_DB_URL` | 现有 prod DB | **新增** dev DB URL | `training_records_dev` |
| `TRAINING_DB_ENABLED` | `true` | `true` | Dev 也需要 DB |
| `TRAINING_DB_TIMEOUT_MS` | 现有值 | **共用** | |
| `TRAINING_DB_APP_NAME` | 现有值 | 可改为 `training-records-dev` | 方便区分连接 |
| `TRAINING_SNAPSHOT_SOURCE` | `markdown` | 按需切换 | Dev 可测试 `database` 模式 |
| `GITHUB_TOKEN`（Worker） | 现有值 | **新增** Dev GITHUB_TOKEN | Fine-grained PAT |
| `GITHUB_OWNER`（Worker） | `soulgo` | **共用** | |
| `GITHUB_REPO`（Worker） | `training_records` | **共用** | |
| `CLOUDFLARE_API_TOKEN` | 现有值 | **共用** | 同一 Cloudflare 账号 |
| `CLOUDFLARE_ACCOUNT_ID` | 现有值 | **共用** | |

### 3.2 配置管理方式

**推荐方式：GitHub Actions 变量/Secrets + 命名约定**

| 类型 | 方式 |
| --- | --- |
| 生产 Secrets | 现有的 `TELEGRAM_BOT_TOKEN`、`AI_API_KEY`、`TRAINING_DB_URL` 等保持不变 |
| 开发 Secrets | 新增 `DEV_*` 前缀的 Secrets：`DEV_TELEGRAM_BOT_TOKEN`、`DEV_TRAINING_DB_URL`、`DEV_GITHUB_TOKEN` 等 |
| 共用 Variables | 现有的 `AI_BASE_URL`、`AI_MODEL`、`TELEGRAM_ALLOWED_CHAT_IDS` 等保持不变，Dev 工作流直接引用 |

**不推荐**使用 GitHub Environments（`production` / `development`）：
- Environments 主要用于部署审批和保护规则，本项目无此需求
- Environments 的 secrets 不能在 workflow 级别直接覆盖，灵活性低于命名约定
- 增加配置复杂度，收益有限

### 3.3 工作流中的变量引用

以 `telegram-sync-dev.yml` 为例：

```yaml
env:
  TELEGRAM_BOT_TOKEN: ${{ secrets.DEV_TELEGRAM_BOT_TOKEN }}
  AI_API_KEY: ${{ secrets.AI_API_KEY }}          # 共用
  AI_BASE_URL: ${{ vars.AI_BASE_URL }}            # 共用
  AI_MODEL: ${{ vars.AI_MODEL }}                  # 共用
  TRAINING_DB_URL: ${{ secrets.DEV_TRAINING_DB_URL }}
  TRAINING_DB_ENABLED: 'true'
  TELEGRAM_ALLOWED_CHAT_IDS: ${{ vars.TELEGRAM_ALLOWED_CHAT_IDS }}  # 共用
```

### 3.4 新增配置汇总

| 新增项 | 位置 | 数量 |
| --- | --- | --- |
| GitHub Actions Secrets | `DEV_TELEGRAM_BOT_TOKEN`、`DEV_TRAINING_DB_URL`、`DEV_GITHUB_TOKEN`、`DEV_TELEGRAM_SECRET_TOKEN` | 4 |
| GitHub Actions Variables | `DEV_TELEGRAM_WEBHOOK_URL`、`DEV_TRAINING_DB_APP_NAME` | 2 |
| Cloudflare Worker Secrets（Dev Worker） | `GITHUB_TOKEN`、`TELEGRAM_BOT_TOKEN`、`TELEGRAM_SECRET_TOKEN` | 3 |
| Cloudflare Worker Variables（Dev Worker） | `GITHUB_OWNER`、`GITHUB_REPO` | 2 |

**总计新增：11 个配置项。** 其中 5 个（Worker 的 Variables）可使用默认值，实际必填仅 6 个。

---

## 4. 部署方案

### 4.1 Dev 部署流程

**一次性设置（约 10 分钟）：**

1. 在 @BotFather 创建 Dev Bot → 获取 `DEV_TELEGRAM_BOT_TOKEN`
2. 在 PostgreSQL 执行：`CREATE DATABASE training_records_dev OWNER training_writer;`，连接后运行 `pgsql17.sql`
3. 在 GitHub 仓库 Settings 添加 Dev Secrets 和 Variables
4. 部署 Dev Cloudflare Worker：
   - 复制 `wrangler.toml` → `wrangler.dev.toml`，修改 `name = "telegram-sync-dispatch-dev"`
   - 在 Cloudflare Dashboard 配置 Dev Worker 的 Secrets
   - 运行 `npx wrangler deploy -c wrangler.dev.toml`
5. 在 Cloudflare Dashboard 为 Dev Worker 配置 Secrets：`GITHUB_TOKEN`（Dev PAT）、`TELEGRAM_BOT_TOKEN`（Dev Bot）、`TELEGRAM_SECRET_TOKEN`
6. 设置 Dev Bot webhook 指向 Dev Worker：
   ```powershell
   $env:TELEGRAM_BOT_TOKEN = "dev_bot_token"
   $env:TELEGRAM_WEBHOOK_URL = "https://telegram-sync-dispatch-dev.<account>.workers.dev/"
   $env:TELEGRAM_SECRET_TOKEN = "your_random_secret"
   npm run telegram:webhook
   ```
7. 创建 `dev` 分支：`git checkout -b dev && git push -u origin dev`

**日常 Dev 同步流程：**

```
Dev Bot 收到消息 → Dev Cloudflare Worker
  → GitHub repository_dispatch (event_type: telegram_update_dev)
  → telegram-sync-dev.yml (main分支上的工作流文件)
  → checkout dev 分支
  → npm run sync:telegram (webhook模式)
  → 写入 training_records_dev 数据库
```

### 4.2 Prod 部署流程（保持不变）

```
生产 Bot 收到消息 → 生产 Cloudflare Worker
  → GitHub repository_dispatch (event_type: telegram_update)
  → telegram-sync.yml (main分支)
  → checkout main 分支
  → npm run sync:telegram (webhook模式)
  → 写入 training_records 数据库
```

### 4.3 需要新增的 GitHub Actions 工作流文件

#### `telegram-sync-dev.yml`（放在 main 分支）

触发条件：`repository_dispatch: telegram_update_dev`、`workflow_dispatch`

关键差异（与 prod 版本对比）：
- `ref: dev`（checkout dev 分支）
- 使用 `DEV_*` 前缀的 secrets
- 不提交到 `main` 分支，而是提交到 `dev` 分支
- 不部署到 GitHub Pages（或部署到不同的 Pages source）
- 保留失败通知功能

#### `deploy-cloudflare-worker-dev.yml`（放在 main 分支，手动触发）

用于部署 Dev Worker：
- 使用 `wrangler.dev.toml`
- 触发条件：`workflow_dispatch` 或 push 到 main 的 dev Worker 相关文件
- 部署后自动刷新 Dev Bot webhook

#### `deploy-cloudflare-pages-dev.yml`（放在 main 分支）

用于部署 Dev 站点预览：
- 触发条件：push 到 `dev` 的站点相关路径、`workflow_dispatch`
- checkout `dev` 分支
- 使用 `DEV_TRAINING_DB_URL` 和 `DEV_TRAINING_DB_APP_NAME`
- 调用共享 `site-build` action 构建和测试，但不部署 GitHub Pages
- 删除 `public/CNAME`
- 通过 `wrangler pages deploy public --project-name ... --branch dev` 发布 Cloudflare Pages

### 4.4 Dev 同步流程详情

`telegram-sync-dev.yml` 核心步骤：

1. Checkout `dev` 分支
2. Setup Node.js 22
3. `npm ci`
4. `npm run sync:telegram`（使用 Dev secrets）
5. 检测变更（仅 `dev` 分支文件）
6. 如有变更：commit + push 到 `dev` 分支（触发 CI）
7. Dev 同步结果通知 Dev Bot（可选）

Dev 同步**不包含** backfill/reconcile/export（这些操作如需要可在 dev 分支手动触发）。

---

## 5. 分支管理方案

### 5.1 推荐分支结构

```
main  --- * ------------ * ---------- *  (生产)
           ^               ^
           |               | PR merge
           |               |
dev   --- * --- * -- * -- *  (开发集成)
                 ^     ^
                 |     | sync commit (bot)
                 |     |
                 |  Telegram dev sync 自动提交
                 |
            功能开发 + Prompt调优
```

### 5.2 开发流程

1. 日常开发在 `dev` 分支进行（代码修改、重构、新功能）
2. Prompt 调优：修改 `prompts/` 文件，在 dev 分支通过 Dev Bot 发送测试截图，观察识别效果
3. Telegram Sync 测试：通过 Dev Bot 发送训练截图、随想命令、分析命令等，验证完整链路
4. 数据库测试：Dev sync 自动写入 `training_records_dev`，可执行回填、导出、对账操作
5. `npm test` 在 dev 分支的 CI 中运行

### 5.3 发布流程

1. Dev 分支测试通过（CI 绿灯 + 手动验证 Dev Bot 功能正常）
2. 创建 PR：`dev` → `main`
3. CI 在 PR 上运行
4. 合并到 `main`（Squash merge 或 Merge commit）
5. 合并后自动触发：
   - `deploy-pages.yml`：构建并部署生产站点
   - `deploy-cloudflare-worker.yml`：如 Worker 代码有变更，部署生产 Worker
6. Telegram webhook 每 6 小时自动刷新，或手动触发

### 5.4 同步提交管理

- Prod sync 自动提交到 `main`（由 `github-actions[bot]` 执行）
- Dev sync 自动提交到 `dev`（由 `github-actions[bot]` 执行）
- 合并 `dev` → `main` 时，`训练记录.md`、`source/_posts`、`source/images` 的 dev 测试数据**不应**合并到 main
- 建议：dev 分支的 sync 产物体现在 dev 分支，合并 PR 时排除测试数据文件

---

## 6. 成本评估

### 6.1 新增维护成本

| 项目 | 一次性设置 | 日常维护 |
| --- | --- | --- |
| Dev Bot 创建 | ~2 分钟 | 无 |
| Dev PostgreSQL 数据库 | ~2 分钟（CREATE DATABASE + 执行 SQL） | 无（偶尔 drop/recreate 清理测试数据） |
| Dev Cloudflare Worker | ~5 分钟（部署 + Secrets 配置） | 代码与生产 Worker 相同，无额外维护 |
| GitHub Secrets/Variables | ~5 分钟 | 无 |
| Dev 工作流文件 | 一次性编写 2 个 yml 文件 | 偶尔同步 prod 工作流的改动 |

**总计一次性设置：约 15 分钟。日常额外维护：几乎为零。**

### 6.2 新增配置数量

| 类别 | 新增数量 |
| --- | --- |
| GitHub Actions Secrets | 4 |
| GitHub Actions Variables | 2 |
| Cloudflare Worker Secrets | 3 |
| Cloudflare Worker Variables | 2（可用默认值） |
| **总计** | **11（必填 6）** |

### 6.3 代码变更范围

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `.github/workflows/telegram-sync-dev.yml` | **新增** | Dev Telegram 同步工作流 |
| `.github/workflows/deploy-cloudflare-worker-dev.yml` | **新增** | Dev Worker 部署工作流 |
| `.github/workflows/deploy-cloudflare-pages-dev.yml` | **新增** | Dev Cloudflare Pages 预览部署工作流 |
| `wrangler.dev.toml` | **新增** | Dev Worker 配置（仅修改 `name`） |
| 现有源码 | **零修改** | `tools/telegram-sync.mjs`、`cloudflare/telegram-sync-dispatch-worker.mjs` 等均通过环境变量切换 |

**核心结论：无需修改任何现有业务代码或配置。** 环境切换完全通过 GitHub Actions 的 secrets/variables 注入实现。

### 6.4 后续维护复杂度评估

| 场景 | 影响 |
| --- | --- |
| 新增 Telegram 命令 | 同时在 dev 和 prod 测试，无需额外配置 |
| 修改数据库 schema | 在两个数据库执行相同 DDL |
| 修改 Cloudflare Worker 逻辑 | 修改源码 → 两个 Worker 各自部署（代码相同） |
| 修改 AI prompt | dev 分支调优 → 合并到 main |
| 新增 GitHub Actions secrets | 仅需添加对应的 `DEV_*` 版本 |
| Dev 数据库重置 | `DROP DATABASE training_records_dev; CREATE DATABASE ...;` |

整体维护复杂度增长**可忽略不计**。主要开销集中在首次设置。

---

## 7. 实施清单

### 7.1 基础设施准备

- [ ] 通过 @BotFather 创建 Dev Telegram Bot
- [ ] 创建 PostgreSQL 数据库 `training_records_dev`
- [ ] 在 `training_records_dev` 执行 `sql/pgsql17.sql`

### 7.2 GitHub 配置

- [ ] 添加 Secrets：`DEV_TELEGRAM_BOT_TOKEN`、`DEV_TRAINING_DB_URL`、`DEV_GITHUB_TOKEN`、`DEV_TELEGRAM_SECRET_TOKEN`
- [ ] 添加 Variables：`DEV_TELEGRAM_WEBHOOK_URL`、`DEV_TRAINING_DB_APP_NAME`
- [ ] 可选添加 Variable：`CLOUDFLARE_PAGES_DEV_PROJECT_NAME`，默认 `training-records-dev`
- [ ] 创建 `dev` 分支并推送

### 7.3 Cloudflare 配置

- [ ] 创建 `wrangler.dev.toml`
- [ ] 部署 Dev Worker
- [ ] 配置 Dev Worker Secrets（Dashboard）
- [ ] 设置 Dev Bot webhook 指向 Dev Worker
- [ ] 创建 Cloudflare Pages 项目 `training-records-dev`

### 7.4 工作流文件

- [ ] 创建 `.github/workflows/telegram-sync-dev.yml`
- [ ] 创建 `.github/workflows/deploy-cloudflare-worker-dev.yml`（可选，可手动部署 Dev Worker）
- [ ] 创建 `.github/workflows/deploy-cloudflare-pages-dev.yml`
- [ ] 修改 `.github/workflows/ci-tests.yml` 使其在 `dev` 分支 push 时也触发

---

## 8. 风险与注意事项

1. **Dev 同步数据不应合并到 main。** 合并 `dev` → `main` 的 PR 时，需检查 `训练记录.md`、`source/_posts` 和 `source/images` 不包含 dev 测试产生的数据。
2. **Dev Bot 仅限开发者使用。** 不要将 Dev Bot token 泄露给其他用户。
3. **Dev 数据库的 `source_channel` 字段。** Dev sync 写入的数据可考虑标记 `source_channel = 'telegram_dev'` 以便区分，但这需要代码修改。当前推荐方案通过独立数据库实现物理隔离。
4. **Dev Worker 故障不影响生产。** 两个 Worker 完全独立，Dev Worker 挂掉不影响生产 Bot 正常工作。
5. **GitHub Actions 用量。** Dev sync 每次触发消耗 1 次 workflow run。私人仓库免费额度 2000 分钟/月，足够开发测试。
6. **Cloudflare Worker 免费额度。** 两个 Worker 均在免费额度内（10 万请求/天）。
