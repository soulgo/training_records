# AI

## 现象

- 图片识别失败。
- 识别返回非法 JSON。
- 主模型失败后没有 fallback。
- 分析命令失败。
- OCR 失败后图片被跳过，或图片超过字节/像素限制。

## 原因

- `AI_API_KEY`、`AI_BASE_URL`、`AI_MODEL` 缺失。
- `AI_API_PROTOCOL` 与模型不匹配，例如仅支持 Responses 的模型仍请求 `/chat/completions`。
- Provider 能力配置与实际服务不一致，或不支持 vision / `json_schema` / `json_object` / 纯文本 JSON 中的某一种模式。
- 识别 fallback 三项配置不完整。
- AI 返回字段不满足 `telegram-recognition-schema`。
- `AI_OCR_FAILURE_MODE=required` 且 OCR provider 失败，或图片输入超过 `AI_IMAGE_MAX_*` 安全上限。

## 日志特征

- `模型 ... 不支持 chat completions 协议`
- `AI recognition failed with HTTP`
- `recognition parse failure`
- `fallback recognition AI provider is not configured completely`
- `primary AI recognition failed`
- `strict_json_retry`

## 排查步骤

1. 核对 `AI_API_PROTOCOL`：`chat_completions` 使用 `/chat/completions`，`responses` 使用 `/responses`；不要根据模型名在代码中猜协议。
2. 查 provider 配置：`src/adapters/ai/openai-compatible.adapter.mjs`。
3. 查 provider factory：`src/adapters/ai/ai-provider.factory.mjs:13-25`。
4. 查识别请求：`src/app/use-cases/image-recognition.use-case.mjs:199`。
5. 查 response format fallback：`src/app/use-cases/image-recognition.use-case.mjs:409`。
6. 查 schema：`src/core/ai/telegram-recognition-schema.mjs`，当前版本应为 v4。
7. 核对 `AI_SUPPORTS_VISION`、`AI_SUPPORTS_JSON_SCHEMA`、`AI_SUPPORTS_JSON_OBJECT`、`AI_SUPPORTS_TEXT_JSON`。
8. 查分析：`src/app/use-cases/training-analysis.impl.mjs`。
9. 查图片处理：`src/adapters/image/sharp-image-processor.mjs`；查 OCR：`src/adapters/ocr/openai-compatible-ocr.adapter.mjs`。

## 解决方案

- 补齐通用 AI env，并把 `AI_API_PROTOCOL` 设置为模型真实支持的协议。
- 按 Provider 真实能力设置 capability；代码只在声明允许时从 strict schema 降级到 `json_object` 或纯文本 JSON。
- fallback provider 需要 API key、base URL、model 三项同时存在。
- schema 变更必须同步 Prompt source、生成后的 Prompt、App Profile、测试 fixture 和 DB/core 映射。
- OCR 非强依赖场景使用 `AI_OCR_FAILURE_MODE=best_effort`；只有业务明确要求 OCR 证据时使用 `required`。图片超限应调整来源图片或在评估资源风险后修改上限。

## 预防措施

- 保留 `ai_call_log` 审计。
- 对 schema 和 Prompt 运行 targeted tests。
- 不把低置信度或缺日期图片强行入库。
