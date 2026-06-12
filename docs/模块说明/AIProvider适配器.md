# AI Provider Adapter

## 1. 作用

当前训练系统的图片识别和 `/analysis` 训练分析都通过统一的 AI provider adapter 访问后端模型。

默认 provider:

- `openai-compatible`

当前只实现 OpenAI-compatible Chat Completions 协议，不新增 Claude、Gemini 或其它 provider 分支。

## 2. 默认行为

- 未配置 `AI_PROVIDER` 时，保持 `openai-compatible`
- 未配置 `AI_TIMEOUT_MS` 时，不额外引入新的超时语义
- 现有 `AI_API_KEY`、`AI_BASE_URL`、`AI_MODEL` 仍然沿用
- 未配置 `TELEGRAM_RECOGNITION_MODEL` 时，Telegram 图片识别继续使用 `AI_MODEL`
- `TELEGRAM_RECOGNITION_CACHE_ENABLED` 只控制是否读取数据库识别缓存，不改变 provider 默认值
- `TELEGRAM_RECOGNITION_FALLBACK_API_KEY`、`TELEGRAM_RECOGNITION_FALLBACK_BASE_URL`、`TELEGRAM_RECOGNITION_FALLBACK_MODEL` 全部配置后，Telegram 图片识别会在主 AI timeout、HTTP 429/5xx、空内容等可恢复失败后切到备用 OpenAI-compatible provider
- 识别缓存读取失败会降级为 cache miss 并继续调用 AI，不能阻断图片识别

## 3. 兼容策略

- 现有 Chat Completions 请求形状保持不变
- 图片识别的 `response_format.json_schema` 保持不变
- `/analysis` 的 prompt、输出格式和 reply 逻辑保持不变
- `.github/workflows/telegram-sync.yml` 与 `.github/workflows/telegram-sync-dev.yml` 显式透传 `AI_PROVIDER`、`AI_TIMEOUT_MS`、`TELEGRAM_RECOGNITION_MODEL`、`TELEGRAM_RECOGNITION_FALLBACK_*` 和 `TELEGRAM_RECOGNITION_CACHE_ENABLED`
- Telegram 图片识别可用 `TELEGRAM_RECOGNITION_MODEL` 单独覆盖模型；`/analysis` 仍使用 `AI_MODEL`
- 备用 AI 只作用于 Telegram 图片识别，不改变 `/analysis` 使用的 provider

## 4. 错误分类

- `AiProviderError`：provider 不支持或 provider 初始化失败
- `AiSchemaError`：AI 返回内容不是有效 JSON 或不符合 schema
- `timeout expired` 若来自识别缓存数据库读取，会被记录为 cache miss；若来自主 AI 请求且配置了备用 provider，会尝试备用 AI

## 5. 回滚方式

- 删除 `AI_PROVIDER` 覆盖值即可回到默认兼容路径
- 删除 `TELEGRAM_RECOGNITION_MODEL` 后，Telegram 图片识别会回到 `AI_MODEL`
- 删除任一 `TELEGRAM_RECOGNITION_FALLBACK_*` 必填项后，Telegram 图片识别不会启用备用 AI
- 删除 `TELEGRAM_RECOGNITION_CACHE_ENABLED` 后，识别缓存默认关闭
- 如需完全回退代码适配层，可将调用点切回原有 Chat Completions 实现

## 6. 风险等级

中

## 7. 验证

```bash
node --test test/ai-provider.test.mjs test/ai-recognition-service.test.mjs test/training-analysis.test.mjs test/telegram-sync-runner.test.mjs
node --test test/github-workflows.test.mjs
```
