# Telegram Webhook + Cloudflare Worker

这套接入用于让 Telegram 新消息直接触发 GitHub Actions，不再依赖定时轮询。

## 1. Cloudflare Worker 需要的配置

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

## 2. Worker 代码

仓库内示例文件：

- [telegram-sync-dispatch-worker.mjs](/C:/Users/ljq90/Desktop/project_test/健身锻炼/cloudflare/telegram-sync-dispatch-worker.mjs)

它会：

1. 校验 Telegram webhook 请求头 `X-Telegram-Bot-Api-Secret-Token`
2. 普通单条消息立即转发为 GitHub `repository_dispatch`
3. 相册消息按 `chat_id + media_group_id` 进入 `TelegramAlbumBuffer`，缓冲 3 秒后再合并派发
4. 触发类型固定为 `telegram_update`，payload 使用 `client_payload.telegram_updates`

如果没有配置 `TELEGRAM_ALBUM_BUFFER` 绑定，Worker 仍然会继续工作，但相册不会聚合，行为会退回为逐条 dispatch。

排查信号：如果 Cloudflare 对一次“合并发送”的相册显示多条 POST，同时 GitHub Actions 里出现多次 `Telegram Sync`，并且日志里的 `batchId` 相同，通常就是 `TELEGRAM_ALBUM_BUFFER` Durable Object 绑定没有在已部署的 Worker 上生效。

## 3. Durable Object 绑定说明

建议在 Worker 配置里把 Durable Object class 绑定到 `TELEGRAM_ALBUM_BUFFER`，class 名称使用：

- `TelegramAlbumBuffer`

仓库根目录已经提供 [`wrangler.toml`](/C:/Users/ljq90/Desktop/project_test/健身锻炼/wrangler.toml)，核心绑定长这样：

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

当前仓库已经提供 [`deploy-cloudflare-worker.yml`](/C:/Users/ljq90/Desktop/project_test/健身锻炼/.github/workflows/deploy-cloudflare-worker.yml)，它会在以下文件推到 `main` 后自动运行 `wrangler deploy`：

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

## 4. GitHub Actions 行为

[`telegram-sync.yml`](/C:/Users/ljq90/Desktop/project_test/健身锻炼/.github/workflows/telegram-sync.yml) 现在支持：

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

[`deploy-pages.yml`](/C:/Users/ljq90/Desktop/project_test/健身锻炼/.github/workflows/deploy-pages.yml) 用于普通人工 push / 手动触发：

- 在 `main` 的站点相关文件真正发生 push 后再部署
- 不再因为一次 `Telegram Sync` 完成就无条件额外跑一次 Pages workflow

## 5. 设置 Telegram webhook

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

## 6. 验证方法

1. 给 Bot 发一张新的训练/饮食/体脂截图，应触发 1 次 `Telegram Sync`
2. 给 Bot 发 2 张相册截图，应只触发 1 次 `Telegram Sync`；如果触发多次，先检查 `TELEGRAM_ALBUM_BUFFER` Durable Object 绑定
3. 给 Bot 发一条 `/thought 今天训练后背阔发力更明显`，应触发 1 次 `Telegram Sync`
4. 在 Cloudflare Worker 请求日志确认收到了 `POST`
5. 在 GitHub Actions 确认 `Telegram Sync` 被 `repository_dispatch` 触发
6. 对截图消息，检查是否产生新的 `训练记录.md` 同步提交
7. 对 `/thought` 消息，检查是否产生新的 `source/_posts/YYYY-MM-DD-telegram-thought-<messageId>.md` 同步提交
