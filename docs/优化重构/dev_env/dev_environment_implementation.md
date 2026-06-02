# Dev 环境搭建步骤

> 仅包含推荐方案。按顺序执行，预计 15-20 分钟完成全部配置。

---

## 前置准备

开始前确认以下信息已就绪：

- 已登录 @BotFather（Telegram 内搜索）
- 已登录 Cloudflare Dashboard
- 已登录 GitHub 仓库 Settings 页面
- 已连接到生产 PostgreSQL 实例（`psql` 或数据库管理工具）
- Cloudflare 账号 ID（Dashboard 右侧 `Account ID`）

---

## 步骤 1：创建 Dev Telegram Bot

1. 在 Telegram 中打开 @BotFather，发送 `/newbot`
2. 按提示设置 Bot 名称（建议：`训练记录DevBot`）和用户名（建议：`training_records_dev_bot`）
3. 创建成功后 @BotFather 返回 Bot Token，格式类似 `1234567890:ABCdefGHIjklMNOpqrsTUVwxyz`
4. 保存此 Token，后续记为 **`DEV_TELEGRAM_BOT_TOKEN`**

---

## 步骤 2：创建 Dev PostgreSQL 数据库

连接到生产 PostgreSQL 实例（使用管理员账号），执行：

```sql
CREATE DATABASE training_records_dev OWNER training_writer;
```

然后连接到 `training_records_dev` 数据库，执行仓库中的建表脚本：

```bash
psql -U training_writer -d training_records_dev -f sql/pgsql17.sql
```

验证数据库是否可连接，记下连接串，后续记为 **`DEV_TRAINING_DB_URL`**：

```
postgresql://training_writer:<密码>@<主机>:5432/training_records_dev
```

如需 SSL：在末尾追加 `?sslmode=require`

---

## 步骤 3：配置 GitHub Actions Secrets 和 Variables

进入仓库 `Settings → Secrets and variables → Actions`：

### Secrets 新增

| Name | Value |
| --- | --- |
| `DEV_TELEGRAM_BOT_TOKEN` | 步骤 1 获取的 Dev Bot Token |
| `DEV_TRAINING_DB_URL` | 步骤 2 的 Dev 数据库连接串 |
| `DEV_GITHUB_TOKEN` | Dev Worker 使用的 GitHub PAT（见下方说明） |
| `DEV_TELEGRAM_SECRET_TOKEN` | 随机字符串（见下方说明） |

`DEV_GITHUB_TOKEN`（Fine-grained Personal Access Token）：
- 进入 GitHub `Settings → Developer settings → Personal access tokens → Fine-grained tokens`
- 点击 `Generate new token`
- Repository access：选择 `soulgo/training_records`
- Permissions：`Contents: Read and write`
- 生成后保存，Token 格式为 `github_pat_...`

`DEV_TELEGRAM_SECRET_TOKEN`：
- 通过以下命令生成：
  ```powershell
  [guid]::NewGuid().ToString('N')
  ```
- 这是 Worker 校验 webhook 请求合法性的凭证，需与 Dev Worker 的 `TELEGRAM_SECRET_TOKEN` 一致

### Variables 新增

| Name | Value |
| --- | --- |
| `DEV_TELEGRAM_WEBHOOK_URL` | `https://telegram-sync-dispatch-dev.<你的Cloudflare账号ID>.workers.dev/` |
| `DEV_TRAINING_DB_APP_NAME` | `training-records-dev` |

<你的Cloudflare账号ID> 替换为实际 Account ID（在 Cloudflare Dashboard 右侧可见）。

---

## 步骤 4：修改 Worker 源码 + 创建部署配置文件

这一步做两件事：修改 Worker 源码让同一份代码可同时服务生产和开发；创建 Dev Worker 的 Wrangler 部署配置。

### 4.1 修改 Worker 源码（让 event_type 可配置）

打开 `cloudflare/telegram-sync-dispatch-worker.mjs`，找到 `dispatchTelegramUpdates` 函数中这一行（约第 336 行）：

```javascript
event_type: 'telegram_update',
```

改为：

```javascript
event_type: env.GITHUB_DISPATCH_EVENT_TYPE?.trim() || 'telegram_update',
```

> **为什么改这一行：** 当前代码把 GitHub Dispatch 的事件类型写死为 `telegram_update`。生产 Worker 会触发 `telegram-sync.yml`，Dev Worker 需要触发不同的 `telegram-sync-dev.yml`，所以事件类型必须可配置。改完之后，不设置 `GITHUB_DISPATCH_EVENT_TYPE` 变量时行为不变（默认 `telegram_update`），向后兼容。

### 4.2 创建 `wrangler.dev.toml`

在仓库根目录新建文件 `wrangler.dev.toml`，内容如下：

```toml
name = "telegram-sync-dispatch-dev"
main = "cloudflare/telegram-sync-dispatch-worker.mjs"
compatibility_date = "2026-05-14"

[[durable_objects.bindings]]
name = "TELEGRAM_ALBUM_BUFFER"
class_name = "TelegramAlbumBuffer"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["TelegramAlbumBuffer"]
```

> 与 `wrangler.toml` 的唯一区别是 `name` 改为了 `telegram-sync-dispatch-dev`。`main`、`compatibility_date`、Durable Object 绑定与生产 Worker 完全一致。

### 4.3 提交代码

这两处改动（`telegram-sync-dispatch-worker.mjs` + `wrangler.dev.toml`）需要先提交到仓库：

```powershell
git add cloudflare/telegram-sync-dispatch-worker.mjs wrangler.dev.toml
git commit -m "feat: make Worker dispatch event_type configurable via env var"
```

暂时不需要 push，等步骤 8 的 workflow 文件也创建好后一起提交。

---

## 步骤 5：部署 Dev Worker 到 Cloudflare 并配置凭证

### 5.1 通过 Wrangler CLI 部署到 Cloudflare

在本机执行（需要已登录 Wrangler，如果未登录先执行 `npx wrangler login`）：

```powershell
npx wrangler deploy -c wrangler.dev.toml
```

部署成功后终端输出类似：

```
Uploaded telegram-sync-dispatch-dev (xx sec)
Deployed telegram-sync-dispatch-dev triggers
  https://telegram-sync-dispatch-dev.<你的Cloudflare账号ID>.workers.dev
```

记下这个 URL——这就是 Dev Bot 的 webhook 地址，步骤 6 要用。

### 5.2 在 Cloudflare Dashboard 为 Dev Worker 注入凭证

Worker 代码已部署，但运行所需的 Bot Token、GitHub Token 等凭证还需在 Cloudflare 控制台手动注入。

**操作路径：**

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com)（如未登录先登录）
2. 左侧菜单点击 **Workers & Pages**
3. 在列表中找到并点击 **telegram-sync-dispatch-dev**
4. 顶部 Tab 栏选择 **Settings**
5. 向下滚动找到 **Variables and Secrets** 区域

### 5.3 添加 3 个 Secrets（加密存储）

在 Variables and Secrets 区域点击 **Add** 按钮，选择 **Type: Secret**，依次添加：

| Name | Value | 说明 |
| --- | --- | --- |
| `GITHUB_TOKEN` | 步骤 3 创建的 `DEV_GITHUB_TOKEN` | 调用 GitHub API dispatch |
| `TELEGRAM_BOT_TOKEN` | 步骤 1 获取的 `DEV_TELEGRAM_BOT_TOKEN` | Dev Bot 的 token |
| `TELEGRAM_SECRET_TOKEN` | 步骤 3 生成的 `DEV_TELEGRAM_SECRET_TOKEN` | 用于校验 webhook 请求合法性 |

> **注意：** 每添加一个 Secret，填写 Name 和 Value 后点击 **"Save and deploy"**（或页面右上角的蓝色 **"Deploy"** 按钮）。不要在添加多个之后再一次性部署，否则前面的会丢失。
>
> **注意：** Secrets 添加后无法再次查看明文值，只能覆盖或删除。确保填写的值与步骤 3 中 GitHub Secrets 里对应的值**完全一致**。尤其是 `TELEGRAM_SECRET_TOKEN`，Worker 和 Telegram webhook 两边必须相同，否则请求会被 401 拒绝。

### 5.4 添加 3 个 Variables（明文存储）

同样在 Variables and Secrets 区域，点击 **Add** 按钮，选择 **Type: Plain text**，依次添加：

| Name | Value | 说明 |
| --- | --- | --- |
| `GITHUB_DISPATCH_EVENT_TYPE` | `telegram_update_dev` | Dev Worker 分派到 dev 工作流 |
| `GITHUB_OWNER` | `soulgo` | GitHub 仓库 owner（可选，代码默认 `soulgo`） |
| `GITHUB_REPO` | `training_records` | GitHub 仓库名（可选，代码默认 `training_records`） |

> `GITHUB_OWNER` 和 `GITHUB_REPO` 如果与 Worker 代码中的默认值一致可以不添加。但显式配置更安全，避免未来默认值被修改。

### 5.5 验证配置

回到 Worker 详情页，顶部 Tab 选择 **Logs** 可实时查看 Worker 的请求日志（目前为空正常，等设置 webhook 后才有流量）。

---

## 步骤 6：设置 Dev Bot Webhook

### 6.1 获取 Dev Worker URL

Dev Worker 的 URL 格式为：

```
https://telegram-sync-dispatch-dev.<你的Cloudflare账号ID>.workers.dev/
```

如果部署时没记下，可以在 Cloudflare Dashboard → Workers & Pages → telegram-sync-dispatch-dev → 顶部 Trigger 区域查看。

### 6.2 调用 Telegram API 设置 webhook

在本机执行（替换尖括号中的占位符）：

```powershell
$env:TELEGRAM_BOT_TOKEN = "步骤1获取的DEV_TELEGRAM_BOT_TOKEN"
$env:TELEGRAM_WEBHOOK_URL = "https://telegram-sync-dispatch-dev.<Cloudflare账号ID>.workers.dev/"
$env:TELEGRAM_SECRET_TOKEN = "步骤3生成的DEV_TELEGRAM_SECRET_TOKEN"
npm run telegram:webhook
```

执行成功后会输出类似：

```json
{
  "ok": true,
  "description": "Webhook was set",
  "result": {
    "url": "https://telegram-sync-dispatch-dev.xxx.workers.dev/",
    "has_custom_certificate": false,
    "pending_update_count": 0
  },
  "webhookUrl": "https://telegram-sync-dispatch-dev.xxx.workers.dev/"
}
```

看到 `"ok": true` 即表示 webhook 设置成功。
## 步骤 7：创建 GitHub Actions 工作流文件

以下两个文件必须放在 `main` 分支（`repository_dispatch` 只能触发默认分支上的工作流文件）。

### 7.1 创建 `.github/workflows/telegram-sync-dev.yml`

```yaml
name: Telegram Sync (Dev)

on:
  workflow_dispatch:
  repository_dispatch:
    types:
      - telegram_update_dev

permissions:
  contents: write
  pages: write
  id-token: write

concurrency:
  group: telegram-sync-dev
  cancel-in-progress: false

jobs:
  sync:
    if: github.event_name != 'push' || github.actor != 'github-actions[bot]'
    runs-on: ubuntu-latest
    env:
      TRAINING_DB_ENABLED: 'true'
      TRAINING_DB_URL: ${{ secrets.DEV_TRAINING_DB_URL }}
      TRAINING_DB_TIMEOUT_MS: ${{ vars.TRAINING_DB_TIMEOUT_MS }}
      TRAINING_DB_APP_NAME: ${{ vars.DEV_TRAINING_DB_APP_NAME }}
      TRAINING_SNAPSHOT_SOURCE: ${{ vars.TRAINING_SNAPSHOT_SOURCE }}
    steps:
      - name: Checkout dev branch
        uses: actions/checkout@v4
        with:
          ref: dev
          fetch-depth: 0

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        id: install
        run: npm ci

      - name: Sync Telegram updates
        id: sync
        env:
          TELEGRAM_BOT_TOKEN: ${{ secrets.DEV_TELEGRAM_BOT_TOKEN }}
          AI_API_KEY: ${{ secrets.AI_API_KEY }}
          AI_BASE_URL: ${{ vars.AI_BASE_URL }}
          AI_MODEL: ${{ vars.AI_MODEL }}
          AI_CONCURRENCY: ${{ vars.AI_CONCURRENCY }}
          TRAINING_ANALYSIS_GOAL: ${{ vars.TRAINING_ANALYSIS_GOAL }}
          TELEGRAM_ALLOWED_CHAT_IDS: ${{ vars.TELEGRAM_ALLOWED_CHAT_IDS }}
          TELEGRAM_POLL_LIMIT: ${{ vars.TELEGRAM_POLL_LIMIT }}
          TELEGRAM_SYNC_TRANSPORT: webhook
          TELEGRAM_SYNC_NOTIFY_STAGE: after_action
          TELEGRAM_SYNC_RESULT_PATH: ${{ runner.temp }}/telegram-sync-result.json
        run: npm run sync:telegram

      - name: Detect changes
        id: detect
        run: |
          if [ -z "$(git status --porcelain -- 训练记录.md source/_posts source/images)" ]; then
            echo "repo_changed=false" >> "$GITHUB_OUTPUT"
          else
            echo "repo_changed=true" >> "$GITHUB_OUTPUT"
          fi

      - name: Commit sync results
        id: commit
        if: steps.detect.outputs.repo_changed == 'true'
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add 训练记录.md source/_posts source/images
          git commit -m "chore(dev): sync Telegram updates"

      - name: Push changes
        id: push
        if: steps.detect.outputs.repo_changed == 'true'
        run: git push origin HEAD:dev

      - name: Notify Telegram sync success
        if: success() && github.event_name == 'repository_dispatch'
        continue-on-error: true
        env:
          TELEGRAM_BOT_TOKEN: ${{ secrets.DEV_TELEGRAM_BOT_TOKEN }}
          TELEGRAM_SYNC_NOTIFY: true
          TELEGRAM_SYNC_NOTIFY_STAGE: after_action
          TELEGRAM_SYNC_RESULT_PATH: ${{ runner.temp }}/telegram-sync-result.json
        run: node tools/telegram-sync-notify.mjs

      - name: Notify Telegram sync failure
        if: failure() && github.event_name == 'repository_dispatch'
        continue-on-error: true
        env:
          TELEGRAM_BOT_TOKEN: ${{ secrets.DEV_TELEGRAM_BOT_TOKEN }}
          STEP_INSTALL_OUTCOME: ${{ steps.install.outcome }}
          STEP_SYNC_OUTCOME: ${{ steps.sync.outcome }}
          STEP_DETECT_OUTCOME: ${{ steps.detect.outcome }}
          STEP_COMMIT_OUTCOME: ${{ steps.commit.outcome }}
          STEP_PUSH_OUTCOME: ${{ steps.push.outcome }}
        run: node tools/telegram-action-monitor.mjs
```

### 7.2 创建 `.github/workflows/deploy-cloudflare-worker-dev.yml`（可选）

```yaml
name: Deploy Cloudflare Worker (Dev)

on:
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: cloudflare-worker-dev
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Deploy Worker
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: deploy --config wrangler.dev.toml

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Refresh Dev Telegram webhook
        env:
          TELEGRAM_BOT_TOKEN: ${{ secrets.DEV_TELEGRAM_BOT_TOKEN }}
          TELEGRAM_WEBHOOK_URL: ${{ vars.DEV_TELEGRAM_WEBHOOK_URL }}
          TELEGRAM_SECRET_TOKEN: ${{ secrets.DEV_TELEGRAM_SECRET_TOKEN }}
        run: npm run telegram:webhook
```

---

## 步骤 8：创建 dev 分支

在本机执行：

```powershell
git checkout -b dev
git push -u origin dev
```

这会在 GitHub 上创建 `dev` 分支，后续 Dev Sync 的自动提交将推送到此分支。

---

## 步骤 9：修改 CI 工作流使其在 dev 分支也触发

编辑 `.github/workflows/ci-tests.yml`，在 `push` 的 `branches` 列表中添加 `dev`：

```yaml
on:
  push:
    branches:
      - main
      - dev
```

这样 dev 分支的 push（包括 Dev Sync 自动提交）也会运行测试。

---

## 步骤 10：验证

1. **Dev Bot 帮助消息**：在 Telegram 中给 Dev Bot 发送 `/help`，应收到命令清单（由 Worker 直接回复，不触发 GitHub Actions）
2. **Dev Bot 随想命令**：发送 `/随想 这是一条测试随想`，应触发一次 `Telegram Sync (Dev)` workflow run，并收到 Bot 回复的"随想写入成功"
3. **Dev 数据库验证**：连接 `training_records_dev`，查询 `SELECT * FROM core.thought ORDER BY updated_at DESC LIMIT 1;`，确认随想数据已入库
4. **生产环境未受影响**：确认生产数据库 `training_records` 中无测试数据，生产 Bot 功能正常

---

## 配置速查

### 所有新增配置项

| 配置项 | 位置 | 类型 |
| --- | --- | --- |
| `DEV_TELEGRAM_BOT_TOKEN` | GitHub Secrets | 必填 |
| `DEV_TRAINING_DB_URL` | GitHub Secrets | 必填 |
| `DEV_GITHUB_TOKEN` | GitHub Secrets | 必填 |
| `DEV_TELEGRAM_SECRET_TOKEN` | GitHub Secrets | 必填 |
| `DEV_TELEGRAM_WEBHOOK_URL` | GitHub Variables | 必填 |
| `DEV_TRAINING_DB_APP_NAME` | GitHub Variables | 必填 |
| `GITHUB_TOKEN` | Cloudflare Dev Worker Secrets | 必填 |
| `TELEGRAM_BOT_TOKEN` | Cloudflare Dev Worker Secrets | 必填 |
| `TELEGRAM_SECRET_TOKEN` | Cloudflare Dev Worker Secrets | 必填 |
| `GITHUB_DISPATCH_EVENT_TYPE` | Cloudflare Dev Worker Variables | 必填 |
| `GITHUB_OWNER` | Cloudflare Dev Worker Variables | 可选（默认 `soulgo`） |
| `GITHUB_REPO` | Cloudflare Dev Worker Variables | 可选（默认 `training_records`） |

### 代码变更清单

| 文件 | 变更类型 | 说明 |
| --- | --- | --- |
| `cloudflare/telegram-sync-dispatch-worker.mjs` | **修改 1 行** | 将硬编码的 `event_type` 改为从 `env.GITHUB_DISPATCH_EVENT_TYPE` 读取 |
| `wrangler.dev.toml` | **新增** | Dev Worker 部署配置 |
| `.github/workflows/telegram-sync-dev.yml` | **新增** | Dev Telegram 同步工作流 |
| `.github/workflows/deploy-cloudflare-worker-dev.yml` | **新增** | Dev Worker 自动部署工作流（可选） |
| `.github/workflows/ci-tests.yml` | **修改 1 行** | push branches 增加 `dev` |

---

## 日常使用

**开发流程：**
1. 在 `dev` 分支修改代码
2. Dev Bot 发送测试消息 → 自动触发 Dev Sync → 写入 `training_records_dev`
3. 本地运行 `npm test` 验证
4. 本地运行 `npm run server` 预览站点效果
5. Dev 分支测试通过后，创建 PR 合并到 `main`

**清理 Dev 数据库：**
```sql
DROP DATABASE training_records_dev;
CREATE DATABASE training_records_dev OWNER training_writer;
```
然后重新连接执行 `pgsql17.sql`。

**部署 Dev Worker（如代码有变更）：**
- 方式一：在 GitHub Actions 手动运行 `Deploy Cloudflare Worker (Dev)`
- 方式二：本机执行 `npx wrangler deploy -c wrangler.dev.toml`
