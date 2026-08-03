# AI

## 现象

- 图片识别失败。
- 识别返回非法 JSON。
- 主模型失败后没有 fallback。
- 回执显示“解析未入库：识别结果仍缺少必要字段 / 备用识别未配置 / 主备识别的关键字段不一致”。
- 回执显示“解析成功……部分字段图片可见但未识别”。
- 分析命令失败。
- OCR 失败后图片被跳过，或图片超过字节/像素限制。

## 原因

- `AI_API_KEY`、`AI_BASE_URL`、`AI_MODEL` 缺失。
- `AI_API_PROTOCOL` 与模型不匹配，例如仅支持 Responses 的模型仍请求 `/chat/completions`。
- Provider 能力配置与实际服务不一致，或不支持 vision / `json_schema` / `json_object` / 纯文本 JSON 中的某一种模式。
- 识别 fallback 未配置模型，或备用连接未配置且主 `AI_API_KEY` / `AI_BASE_URL` 也缺失。
- AI 返回字段不满足 `telegram-recognition-schema`。
- 主识别业务字段缺失（硬完整性/条件完整性未满足），且备用 provider 未配置或补全后仍不完整。
- 主备识别对关键数值字段给出超容差的不同值（`reconciliation:conflict`），或活动结构化指标冲突（`ACTIVITY_METRIC_CONFLICT`）。
- `AI_OCR_FAILURE_MODE=required` 且 OCR provider 失败，或图片输入超过 `AI_IMAGE_MAX_*` 安全上限。

## 日志特征

- `模型 ... 不支持 chat completions 协议`
- `AI recognition failed with HTTP`
- `recognition parse failure`
- `fallback recognition AI provider is not configured completely`
- `primary AI recognition failed`
- `strict_json_retry`
- `incomplete Responses output` / `refusal Responses output` / `empty Responses output`
- summary/回执中的 `completenessStatus`、`missingFields`、`reconciliationStatus`、`conflictFields`、`failureCategory=business_incomplete`、`failureDisposition=manual_intervention`
- `recognitionAttemptKinds` 含 `fallback_business_completion`（业务补全）或 `fallback`（技术 fallback）

## 排查步骤

1. 核对 `AI_API_PROTOCOL`：`chat_completions` 使用 `/chat/completions`，`responses` 使用 `/responses`；不要根据模型名在代码中猜协议。
2. 查 provider 配置：`src/adapters/ai/openai-compatible.adapter.mjs`。
3. 查 provider factory：`src/adapters/ai/ai-provider.factory.mjs:13-25`。
4. 查识别请求：`src/app/use-cases/image-recognition.use-case.mjs:199`。
5. 查 response format fallback：`src/app/use-cases/image-recognition.use-case.mjs:409`。
6. 查 schema：`src/core/ai/telegram-recognition-schema.mjs`，当前版本应为 v4。
7. 核对 `AI_SUPPORTS_VISION`、`AI_SUPPORTS_JSON_SCHEMA`、`AI_SUPPORTS_JSON_OBJECT`、`AI_SUPPORTS_TEXT_JSON`。
8. 回执为“缺少必要字段 / 备用识别未配置”时，先看是硬完整性还是条件完整性缺失（`src/core/ai/recognition-completeness.mjs`），再确认是否配置了 `TELEGRAM_RECOGNITION_FALLBACK_MODEL`；备用 key/base URL 不填时继承主连接。备用未配置时主识别缺字段会走 `fallback_unavailable`，仍会把图片上已有的数据入库，只是缺失字段无法补全。
9. 回执为“主备识别的关键字段不一致”时，说明主备对关键数值超出容差（`src/core/ai/recognition-reconciliation.mjs` 的 `RECOGNITION_RECONCILIATION_TOLERANCES`）或活动指标冲突；系统不自动二选一，需人工核对，该批次 `core.*` 零写入。
10. 回执为“解析成功……部分字段图片可见但未识别”时属正常诚实提示：图片已入库可用字段，OCR 证据显示某字段可见但本次未识别，可重发或配置备用识别补全，不是失败。
11. 查分析：`src/app/use-cases/training-analysis.impl.mjs`。
12. 查图片处理：`src/adapters/image/sharp-image-processor.mjs`；查 OCR：`src/adapters/ocr/openai-compatible-ocr.adapter.mjs`。

## 解决方案

- 补齐通用 AI env，并把 `AI_API_PROTOCOL` 设置为模型真实支持的协议。
- 按 Provider 真实能力设置 capability；代码只在声明允许时从 strict schema 降级到 `json_object` 或纯文本 JSON。
- fallback provider 至少需要单独配置 model；备用 API key/base URL 不填时继承主连接，只有备用服务商不同时才需要单独配置连接凭据。
- 主备关键字段冲突需人工核对真实数值后重发单一权威截图；不要靠调大容差掩盖真实差异。
- schema 变更必须同步 Prompt source、生成后的 Prompt、App Profile、测试 fixture 和 DB/core 映射。
- OCR 非强依赖场景使用 `AI_OCR_FAILURE_MODE=best_effort`；只有业务明确要求 OCR 证据时使用 `required`。图片超限应调整来源图片或在评估资源风险后修改上限。

## 预防措施

- 保留 `ai_call_log` 审计，主备两次调用分别记录 provider/model/attempt kind/status，不互相覆盖。
- 对 schema、Prompt、完整性合同和主备合并运行 targeted tests（`test/ai-recognition-service.test.mjs`、`test/ai-schema-validator.test.mjs`、`npm run eval:recognition`）。
- 只识别并写入图片上确有的数据，不把低置信度或缺日期图片强行入库，也不让备 AI 猜测截图未展示的字段。
