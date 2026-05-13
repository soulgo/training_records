# Telegram Webhook + Cloudflare Worker

这套接入用于让 Telegram 新消息直接触发 GitHub Actions，不再依赖定时轮询。

## 1. Cloudflare Worker 需要的配置

在 Cloudflare Worker 的 `Settings -> Variables and Secrets` 中配置：

- Secret: `GITHUB_TOKEN`
- Secret: `TELEGRAM_SECRET_TOKEN`
- Variable: `GITHUB_OWNER`
- Variable: `GITHUB_REPO`

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
2. 把原始 Telegram update 原样转发为 GitHub `repository_dispatch`
3. 触发类型固定为 `telegram_update`

## 3. GitHub Actions 行为

[`telegram-sync.yml`](/C:/Users/ljq90/Desktop/project_test/健身锻炼/.github/workflows/telegram-sync.yml) 现在支持：

- `repository_dispatch`
- `push` 到 `main`
- 手动 `workflow_dispatch`

并且运行时使用 `TELEGRAM_SYNC_TRANSPORT=webhook`：

- `repository_dispatch` 时直接消费 webhook payload
- `push` / 手动触发时不会再调用 `getUpdates`
- 仍然会重放待补偿批次并在需要时刷新 Markdown

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

## 5. 验证方法

1. 给 Bot 发一张新的训练/饮食/体脂截图
2. 在 Cloudflare Worker 请求日志确认收到了 `POST`
3. 在 GitHub Actions 确认 `Telegram Sync` 被 `repository_dispatch` 触发
4. 检查是否产生新的 `训练记录.md` 同步提交
