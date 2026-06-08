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

## 3. 兼容策略

- 现有 Chat Completions 请求形状保持不变
- 图片识别的 `response_format.json_schema` 保持不变
- `/analysis` 的 prompt、输出格式和 reply 逻辑保持不变
- `.github/workflows/telegram-sync.yml` 与 `.github/workflows/telegram-sync-dev.yml` 显式透传 `AI_PROVIDER`、`AI_TIMEOUT_MS`、`TELEGRAM_RECOGNITION_MODEL`、`TELEGRAM_RECOGNITION_CACHE_ENABLED`
- Telegram 图片识别可用 `TELEGRAM_RECOGNITION_MODEL` 单独覆盖模型；`/analysis` 仍使用 `AI_MODEL`

## 4. 错误分类

- `AiProviderError`：provider 不支持或 provider 初始化失败
- 现阶段 schema 校验仍由后续任务接管

## 5. 回滚方式

- 删除 `AI_PROVIDER` 覆盖值即可回到默认兼容路径
- 删除 `TELEGRAM_RECOGNITION_MODEL` 后，Telegram 图片识别会回到 `AI_MODEL`
- 删除 `TELEGRAM_RECOGNITION_CACHE_ENABLED` 后，识别缓存默认关闭
- 如需完全回退代码适配层，可将调用点切回原有 Chat Completions 实现

## 6. 风险等级

中

## 7. 验证

```bash
node --test test/ai-provider.test.mjs test/training-analysis.test.mjs test/telegram-sync-runner.test.mjs
node --test test/github-workflows.test.mjs
```
