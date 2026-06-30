# Telegram

## 现象

- Telegram 消息没有触发同步。
- Worker 返回鉴权失败。
- 图片下载失败。
- 同步成功但没有回发通知。

## 原因

- `TELEGRAM_SECRET_TOKEN` 与 Telegram webhook secret header 不一致。
- `TELEGRAM_BOT_TOKEN` / `DEV_TELEGRAM_BOT_TOKEN` 缺失。
- `TELEGRAM_ALLOWED_CHAT_IDS` 不包含来源 chat。
- `TELEGRAM_WEBHOOK_URL` / `DEV_TELEGRAM_WEBHOOK_URL` 配错。

## 日志特征

- `unauthorized chat`
- `Missing required environment variable: TELEGRAM_BOT_TOKEN`
- `Telegram setWebhook failed`
- `telegram_file_download`

## 排查步骤

1. 查 Worker secret 校验：`cloudflare/telegram-sync-dispatch-worker.mjs:126`。
2. 查 webhook 配置构造：`src/adapters/telegram/webhook.transport.mjs:1-19`。
3. 查同步 env 校验：`src/app/use-cases/telegram-sync.use-case.mjs:831-887`。
4. 查分组逻辑：`src/adapters/telegram/sync-batch-logic.adapter.mjs:95`。
5. 查 Actions summary 中 `failed messageIds`、`failureCategory`。

## 解决方案

- 重跑 `npm run telegram:webhook` 或对应 Worker deploy workflow。
- 修正 Bot token、webhook URL、secret token。
- 把来源 chat id 加入 `TELEGRAM_ALLOWED_CHAT_IDS`。

## 预防措施

- main/dev 使用不同 Bot token 和 webhook URL。
- webhook secret 同时校验 GitHub 注入和 Cloudflare Worker secret。
- 不把 unauthorized chat 当作系统失败。
