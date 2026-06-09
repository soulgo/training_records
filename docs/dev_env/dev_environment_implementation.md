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
| `DEV_TELEGRAM_WEBHOOK_URL` | `https://telegram-sync-dispatch-dev.<你的Workers子域名>.workers.dev/` |
| `DEV_TRAINING_DB_APP_NAME` | `training-records-dev` |

`<你的Workers子域名>` 来自 Wrangler 部署成功后输出的 Worker URL，例如当前 Dev Worker 为 `https://telegram-sync-dispatch-dev.1406221797.workers.dev/`。不要填 Cloudflare Dashboard 右侧的 `Account ID`；Account ID 通常是 32 位十六进制字符串，不能直接作为 `workers.dev` 子域名。

---

## 步骤 4：复核 Worker 源码和 Dev 部署配置

当前仓库已经具备 Dev Worker 所需的代码和配置。首次搭建或接手维护时，只需要复核这些文件仍然满足下面的条件；不要重复创建同名文件。

### 4.1 复核 Worker event_type 可配置

打开 `cloudflare/telegram-sync-dispatch-worker.mjs`，确认 `dispatchTelegramUpdates` 使用环境变量选择 GitHub Dispatch 事件类型：

```javascript
event_type: env.GITHUB_DISPATCH_EVENT_TYPE?.trim() || 'telegram_update',
```

生产 Worker 不设置 `GITHUB_DISPATCH_EVENT_TYPE` 时仍触发 `telegram_update`；Dev Worker 需要设置为 `telegram_update_dev`。

### 4.2 复核 `wrangler.dev.toml`

仓库根目录应已有 `wrangler.dev.toml`。核心内容应保持为：

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

### 4.3 如果复核不通过

如果缺少上述代码或配置，先在本地补齐并提交，再继续部署 Dev Worker。正常接手维护时不需要执行额外提交。

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
  https://telegram-sync-dispatch-dev.<你的Workers子域名>.workers.dev
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
https://telegram-sync-dispatch-dev.<你的Workers子域名>.workers.dev/
```

如果部署时没记下，可以在 Cloudflare Dashboard → Workers & Pages → telegram-sync-dispatch-dev → 顶部 Trigger 区域查看。

### 6.2 调用 Telegram API 设置 webhook

在本机执行（替换尖括号中的占位符）：

```powershell
$env:TELEGRAM_BOT_TOKEN = "步骤1获取的DEV_TELEGRAM_BOT_TOKEN"
$env:TELEGRAM_WEBHOOK_URL = "https://telegram-sync-dispatch-dev.<你的Workers子域名>.workers.dev/"
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

## 步骤 7：复核 GitHub Actions 工作流文件

相关 workflow 文件必须放在 `main` 分支（`repository_dispatch` 只能触发默认分支上的工作流文件）。

### 7.1 确认 `.github/workflows/telegram-sync-dev.yml`

当前仓库已经包含 `.github/workflows/telegram-sync-dev.yml`。如果需要重建或审查 Dev Sync workflow，至少确认这些关键点：

- `repository_dispatch.types` 使用 `telegram_update_dev`。
- checkout 固定 `ref: dev`，自动提交 push 到 `dev`。
- `TELEGRAM_BOT_TOKEN` 使用 `secrets.DEV_TELEGRAM_BOT_TOKEN`，数据库使用 `secrets.DEV_TRAINING_DB_URL`。
- `Detect changes` 同时输出文件变化和 DB-only `ready + stored` 图片批次数；即使仓库文件无变化，数据库有新增训练数据也会构建 dev 站点。
- 调用共享 `site-build` 时传 `install_dependencies: false`，因为前面已经执行过 `npm ci`。
- dev 站点构建后删除 `public/CNAME`，再用固定 Wrangler 版本 direct upload 到 Cloudflare Pages。
- `repository_dispatch` 会写 GitHub Step Summary，输出 `batchId`、`taskStatus`、`persistenceStatus`、`archivedDate`、图片计数、pending 状态、`failureDisposition` 和失败 message ids。
- 成功通知步骤名应为 `Notify Telegram sync result`，不要再使用容易误读的 `Notify Telegram sync success`。
- 失败通知要包含 `STEP_SITE_BUILD_OUTCOME` 和 `STEP_PAGES_DEPLOY_OUTCOME`，方便区分同步、构建和 dev Pages 发布问题。

### 7.2 可选：创建 `.github/workflows/deploy-cloudflare-worker-dev.yml`

当前仓库如果没有 Dev Worker 自动部署 workflow，可以按下面模板新增；否则只需复核它部署 `wrangler.dev.toml` 并刷新 Dev webhook。

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

## 步骤 8：确认 dev 分支

如果远端尚未有 `dev` 分支，在本机执行：

```powershell
git checkout -b dev
git push -u origin dev
```

这会在 GitHub 上创建 `dev` 分支，后续 Dev Sync 的自动提交将推送到此分支。若 `dev` 分支已经存在，只需确认本地已切到正确分支并能 push。

---

## 步骤 9：复核 CI 工作流在 dev 分支触发

确认 `.github/workflows/ci-tests.yml` 的 `push.branches` 包含 `dev`：

```yaml
on:
  push:
    branches:
      - main
      - dev
```

这样 dev 分支的 push（包括 Dev Sync 自动提交）也会运行测试。若已包含 `dev`，不需要重复修改。

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
| `CLOUDFLARE_PAGES_DEV_PROJECT_NAME` | GitHub Variables | 可选（默认 `training-records-dev`） |

### 代码与工作流复核清单

| 文件 | 当前复核点 | 说明 |
| --- | --- | --- |
| `cloudflare/telegram-sync-dispatch-worker.mjs` | event type 可配置 | 使用 `env.GITHUB_DISPATCH_EVENT_TYPE?.trim() || 'telegram_update'` |
| `wrangler.dev.toml` | 应已存在 | Dev Worker 部署配置 |
| `.github/workflows/telegram-sync-dev.yml` | 应已存在 | Dev Telegram 同步工作流 |
| `.github/workflows/deploy-cloudflare-worker-dev.yml` | 可选 | Dev Worker 自动部署工作流 |
| `.github/workflows/deploy-cloudflare-pages-dev.yml` | 应已存在 | Dev Cloudflare Pages 预览部署工作流 |
| `.github/workflows/ci-tests.yml` | dev 分支触发 | push branches 包含 `dev` |

---

## 日常使用

**开发流程：**
1. 在 `dev` 分支修改代码
2. Dev Bot 发送测试消息 → 自动触发 Dev Sync → 写入 `training_records_dev`
3. 本地运行 `npm test` 验证
4. 本地运行 `npm run server` 快速预览站点效果
5. push 到 `dev` 后等待 `Deploy Cloudflare Pages (Dev)` 完成，访问 `https://training-records-dev.pages.dev`
6. Dev 分支测试通过后，创建 PR 合并到 `main`

**Dev Pages 在线预览：**
- 默认 Cloudflare Pages 项目名：`training-records-dev`
- 默认 dev 分支预览地址：`https://training-records-dev.pages.dev`
- 如修改项目名，请同步设置 GitHub Variable `CLOUDFLARE_PAGES_DEV_PROJECT_NAME`

**清理 Dev 数据库：**
```sql
DROP DATABASE training_records_dev;
CREATE DATABASE training_records_dev OWNER training_writer;
```
然后重新连接执行 `pgsql17.sql`。

**部署 Dev Worker（如代码有变更）：**
- 方式一：在 GitHub Actions 手动运行 `Deploy Cloudflare Worker (Dev)`
- 方式二：本机执行 `npx wrangler deploy -c wrangler.dev.toml`
