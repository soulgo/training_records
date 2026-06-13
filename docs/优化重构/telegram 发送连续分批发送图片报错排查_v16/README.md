# Telegram 连续分批发送图片报错排查 v16

本目录记录 2026-06-13 对“Telegram 连续分批发送训练图片时，第一次发送返回报错，但 Telegram sync Action 日志无报错”的排查、修复和验证。

## 阅读顺序

1. [排查与实施记录](./排查与实施记录_v16.md)

## 当前判断

这不是 GitHub Action 执行失败，而是业务同步报告的可观测性问题：Telegram 回执会正确提示 `partialFailure` / AI 识别失败，但 Action summary 直接读取原始 result，未经过 `buildTelegramSyncReport()` 规范化，因此容易显示成 `ready + stored`，让审计日志看起来“没有报错”。

本轮修复不降低图片识别严格性，不吞掉 AI 识别失败；只让 Action 审计日志和 Telegram 回执使用同一套业务状态语义。
