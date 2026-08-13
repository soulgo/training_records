# AI

## 每日报告面板

`/monitor/` 的每日报告在共享 site-build action 的实际构建步骤（`DAILY_MONITOR_REPORT_ENABLED=true`）调用 `src/app/use-cases/daily-monitor-report.use-case.mjs`。排查顺序：

1. 先确认 Pages workflow 是否注入 `AI_API_KEY`、`AI_BASE_URL`、`AI_MODEL`、`AI_API_PROTOCOL` 和 `AI_SUPPORTS_JSON_OBJECT`。
2. 再查看构建日志中的 `[daily-monitor-report]` 摘要；请求失败、空内容、非 JSON 或 schema 校验失败都会切换为 `dailyReport.source=rules`。
3. 页面标记“规则降级建议”不代表训练数据失败，先检查 `source/_data/monitorView.json` 的 `latestDataDate`、`dailyReport.reason` 和 `dataQuality`。
4. 修改建议口径时更新 `prompts/daily-monitor-report.md` 和 `src/core/ai/daily-monitor-report-schema.mjs`，不要在模板中拼接 AI 原始文本。

每日报告不写数据库、不创建 AI 业务表，也不在浏览器端发起 AI 请求。没有 AI 配置时站点仍可发布，但只显示规则建议。

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
- 备用服务协议与主服务不同，但 `TELEGRAM_RECOGNITION_FALLBACK_API_PROTOCOL` 未设置，导致备用 provider 请求不存在的 `/responses` 或 `/chat/completions` endpoint。
- `AI_BASE_URL` 错填为完整 endpoint，`responses` 协议又自动追加 `/responses`，或上游网关在 HTTP 200 下返回 HTML，导致 JSON 解析失败。
- Provider 能力配置与实际服务不一致，或不支持 vision / `json_schema` / `json_object` / 纯文本 JSON 中的某一种模式。
- 识别 fallback 未配置模型，或备用连接未配置且主 `AI_API_KEY` / `AI_BASE_URL` 也缺失。
- 备用模型与主模型来自不同服务或路由分组，但未配置 `STANDBY_AI_API_KEY` / `STANDBY_AI_BASE_URL`，导致 Kimi 继承 GPT endpoint 后返回“无可用渠道”。
- AI 返回字段不满足 `telegram-recognition-schema`。
- 主识别业务字段缺失（硬完整性/条件完整性未满足），且备用 provider 未配置或补全后仍不完整。
- 主备识别对关键数值字段给出超容差的不同值（`reconciliation:conflict`），或活动结构化指标冲突（`ACTIVITY_METRIC_CONFLICT`）。
- `AI_OCR_FAILURE_MODE=required` 且 OCR provider 失败，或图片输入超过 `AI_IMAGE_MAX_*` 安全上限。
- 主 AI 走 `responses` 协议但网关返回 `status=completed` 且 `output` 为空（无 `output_text`、无 refusal、无 incomplete reason），被判定为「empty Responses output」后切换备用 provider；此时每一张图都依赖备用 AI 兜底。
- 备用 AI 服务组织并发上限为 1（`organization concurrency: 1`），而 `AI_CONCURRENCY` 大于 1 时，同一相册多张图在主 AI 失败后会并发切换备用 provider，第二个及后续请求立即被 HTTP 429 拒绝。

## 日志特征

- `模型 ... 不支持 chat completions 协议`
- `AI recognition failed with HTTP`
- `recognition parse failure`
- `fallback recognition AI provider is not configured completely`
- `primary AI recognition failed`
- `AI recognition returned empty Responses output (status=completed)`（主 AI 空输出，随后 `retrying with fallback provider`）
- `strict_json_retry`
- `incomplete Responses output` / `refusal Responses output` / `empty Responses output`
- `business fallback recognition failed with HTTP ...; keeping primary result` / `reconciliation.status=fallback_failed`
- summary/回执中的 `completenessStatus`、`missingFields`、`reconciliationStatus`、`conflictFields`、`failureCategory=business_incomplete`、`failureDisposition=manual_intervention`
- `recognitionAttemptKinds` 含 `fallback_business_completion`（业务补全）或 `fallback`（技术 fallback）

## 排查步骤

1. 核对 `AI_API_PROTOCOL`：`chat_completions` 使用 `/chat/completions`，`responses` 使用 `/responses`；`AI_BASE_URL` 只填写 API base（通常到 `/v1`），不要附带这两个 endpoint，也不要根据模型名在代码中猜协议。
2. 查 provider 配置：`src/adapters/ai/openai-compatible.adapter.mjs`。
3. 查 provider factory：`src/adapters/ai/ai-provider.factory.mjs:13-25`。
4. 查识别请求：`src/app/use-cases/image-recognition.use-case.mjs:199`。
5. 查 response format fallback：`src/app/use-cases/image-recognition.use-case.mjs:409`。
6. 查 schema：`src/core/ai/telegram-recognition-schema.mjs`，当前版本应为 v4。
7. 核对 `AI_SUPPORTS_VISION`、`AI_SUPPORTS_JSON_SCHEMA`、`AI_SUPPORTS_JSON_OBJECT`、`AI_SUPPORTS_TEXT_JSON`。
8. 日志先出现 `primary AI recognition failed ... retrying with fallback provider`、随后出现 HTTP 404 时，核对 `TELEGRAM_RECOGNITION_FALLBACK_API_PROTOCOL` 是否匹配备用服务；当前主模型走 `responses`、备用 Kimi 走 `chat_completions`，必须显式设置覆盖变量。
9. 回执或日志出现备用模型、`distributor`、无可用渠道时，先确认 `TELEGRAM_RECOGNITION_FALLBACK_MODEL`，再检查 `STANDBY_AI_API_KEY` / `STANDBY_AI_BASE_URL` 是否指向真正提供该模型的服务。新参数为空时才回退旧 fallback 参数，再为空才继承主连接。
10. 回执为“主备识别的关键字段不一致”时，说明主备对关键数值超出容差（`src/core/ai/recognition-reconciliation.mjs` 的 `RECOGNITION_RECONCILIATION_TOLERANCES`）或活动指标冲突；系统不自动二选一，需人工核对，该批次 `core.*` 零写入。
11. 回执为“解析成功……部分字段图片可见但未识别”时属正常诚实提示：图片已入库可用字段，OCR 证据显示某字段可见但本次未识别，可重发或配置备用识别补全，不是失败。
12. 查分析：`src/app/use-cases/training-analysis.impl.mjs`。
13. 查图片处理：`src/adapters/image/sharp-image-processor.mjs`；查 OCR：`src/adapters/ocr/openai-compatible-ocr.adapter.mjs`。

## 解决方案

- 补齐通用 AI env，并把 `AI_API_PROTOCOL` 设置为模型真实支持的协议。
- 按 Provider 真实能力设置 capability；代码只在声明允许时从 strict schema 降级到 `json_object` 或纯文本 JSON。
- fallback provider 至少需要配置 model；它默认继承主 `AI_API_PROTOCOL`，只有备用服务协议不同才设置 `TELEGRAM_RECOGNITION_FALLBACK_API_PROTOCOL`。备用服务商与主服务商不同时，必须配置 `STANDBY_AI_API_KEY` / `STANDBY_AI_BASE_URL`。主 endpoint 的 HTTP 404 或 HTTP 200 HTML/非 JSON 响应会直接切换到备用 provider；业务补全失败会保留主 AI 已有数据并标记 `fallback_failed`，不会再因备用增强不可用而丢弃主结果。
- 主备关键字段冲突需人工核对真实数值后重发单一权威截图；不要靠调大容差掩盖真实差异。
- 主 AI 持续返回「empty Responses output」时，先核对 `AI_BASE_URL` 指向的网关是否真正支持 `AI_MODEL`（如 `gpt-5.4-mini`）的 Responses 结构化输出（`text.format` + `json_schema` + `store:false`）；不支持则改 `AI_API_PROTOCOL=chat_completions`，或设 `AI_SUPPORTS_JSON_SCHEMA=false` 让主 AI 降级到 `json_object`/纯文本 JSON。这属于主 AI 连接配置问题，不是「主 AI 坏了」。
- 备用 AI 服务组织并发上限为 1 时，代码已对备用 provider 的请求串行化（`serializeAiProviderRequests`），同一时刻最多一个备用在途请求，`AI_CONCURRENCY` 只作用于主 provider；不要再通过调低 `AI_CONCURRENCY` 去迁就备用服务，那会拖慢主 AI 的正常并发识别。
- schema 变更必须同步 Prompt source、生成后的 Prompt、App Profile、测试 fixture 和 DB/core 映射。
- OCR 非强依赖场景使用 `AI_OCR_FAILURE_MODE=best_effort`；只有业务明确要求 OCR 证据时使用 `required`。图片超限应调整来源图片或在评估资源风险后修改上限。

## 预防措施

- 保留 `ai_call_log` 审计，主备两次调用分别记录 provider/model/attempt kind/status，不互相覆盖。
- 对 schema、Prompt、完整性合同和主备合并运行 targeted tests（`test/ai-recognition-service.test.mjs`、`test/ai-schema-validator.test.mjs`、`npm run eval:recognition`）。
- 只识别并写入图片上确有的数据，不把低置信度或缺日期图片强行入库，也不让备 AI 猜测截图未展示的字段。
