# AI

## 现象

- 图片识别失败。
- 识别返回非法 JSON。
- 主模型失败后没有 fallback。
- 分析命令失败。
- OCR 失败后图片被跳过，或图片超过字节/像素限制。

## 原因

- `AI_API_KEY`、`AI_BASE_URL`、`AI_MODEL` 缺失。
- provider 不支持 `json_schema` response format，需 fallback 到 `json_object` 或无 response format。
- 识别 fallback 三项配置不完整。
- AI 返回字段不满足 `telegram-recognition-schema`。
- `AI_OCR_FAILURE_MODE=required` 且 OCR provider 失败，或图片输入超过 `AI_IMAGE_MAX_*` 安全上限。

## 日志特征

- `AI recognition failed with HTTP`
- `recognition parse failure`
- `fallback recognition AI provider is not configured completely`
- `primary AI recognition failed`
- `strict_json_retry`

## 排查步骤

1. 查 provider 配置：`src/adapters/ai/openai-compatible.adapter.mjs:3-12`。
2. 查 provider factory：`src/adapters/ai/ai-provider.factory.mjs:13-25`。
3. 查识别请求：`src/app/use-cases/image-recognition.use-case.mjs:199`。
4. 查 response format fallback：`src/app/use-cases/image-recognition.use-case.mjs:409`。
5. 查 schema：`src/core/ai/telegram-recognition-schema.mjs`。
6. 查分析：`src/app/use-cases/training-analysis.impl.mjs`。
7. 查图片处理：`src/adapters/image/sharp-image-processor.mjs`；查 OCR：`src/adapters/ocr/openai-compatible-ocr.adapter.mjs`。

## 解决方案

- 补齐通用 AI env。
- 若主模型不支持 strict schema，允许代码 fallback；若仍失败，换支持 JSON 的模型。
- fallback provider 需要 API key、base URL、model 三项同时存在。
- schema 变更必须同步 Prompt、测试 fixture 和 DB 映射。
- OCR 非强依赖场景使用 `AI_OCR_FAILURE_MODE=best_effort`；只有业务明确要求 OCR 证据时使用 `required`。图片超限应调整来源图片或在评估资源风险后修改上限。

## 预防措施

- 保留 `ai_call_log` 审计。
- 对 schema 和 Prompt 运行 targeted tests。
- 不把低置信度或缺日期图片强行入库。
