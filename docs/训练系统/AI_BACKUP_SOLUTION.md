# Telegram 图片识别备用 AI 方案

## 根因结论

2026-06-08 早上的两次 Telegram Sync 日志暴露出两个不同失败面：

1. `timeout expired`：日志显示识别阶段很快失败，同时 `readOffset`、`readPendingRecognition`、`queueRecognition` 也出现 PostgreSQL 连接超时。开启 `TELEGRAM_RECOGNITION_CACHE_ENABLED=true` 后，图片识别前会先读取数据库识别缓存；此前缓存读取失败会被外层当成 AI 失败。
2. `AI recognition returned empty content`：主 AI 请求返回成功响应，但 `choices[0].message.content` 为空。这属于上游 AI 服务临时不可用或兼容网关异常。

## 已实现修复

- `src/ai/recognition-service.mjs`：识别缓存读取失败降级为 cache miss，继续调用 AI。
- `src/ai/recognition-service.mjs`：主 AI 在 timeout、HTTP 429/5xx、空内容、网络失败等可恢复错误后，自动尝试备用 provider。
- `tools/telegram-sync.mjs`：Telegram 图片识别支持独立备用 AI 配置，只影响图片识别，不影响 `/analysis`。
- `.github/workflows/sync.yml` 和 `.github/workflows/sync-dev.yml`：已透传备用 AI 配置。

## 配置项

GitHub Actions Secret：

```text
TELEGRAM_RECOGNITION_FALLBACK_API_KEY=你的备用 AI API Key
```

GitHub Actions Variables：

```text
TELEGRAM_RECOGNITION_FALLBACK_BASE_URL=https://api.openai.com/v1
TELEGRAM_RECOGNITION_FALLBACK_MODEL=备用模型名
TELEGRAM_RECOGNITION_FALLBACK_TIMEOUT_MS=30000
```

启用条件：`TELEGRAM_RECOGNITION_FALLBACK_API_KEY`、`TELEGRAM_RECOGNITION_FALLBACK_BASE_URL`、`TELEGRAM_RECOGNITION_FALLBACK_MODEL` 三项必须全部配置。`TELEGRAM_RECOGNITION_FALLBACK_TIMEOUT_MS` 可选，未配置时沿用 `AI_TIMEOUT_MS`。

建议同时配置主 AI 超时：

```text
AI_TIMEOUT_MS=30000
```

## 行为边界

- 备用 AI 只用于 Telegram 图片识别。
- `/analysis` 仍使用主 `AI_API_KEY`、`AI_BASE_URL`、`AI_MODEL`。
- schema 不匹配、无效 JSON 等非临时错误仍按现有修复/重试路径处理，不盲目吞掉结构问题。
- 备用 AI 成功后，识别结果中的 `model` 和 `cacheKey` 会记录真实使用的备用模型，避免缓存错配。

## 验证

已覆盖测试：

```bash
node --test test/ai-recognition-service.test.mjs test/telegram-sync-runner.test.mjs test/github-workflows.test.mjs
npm run test:fast
```
