# AI 识别体系

本文是图片分类、Prompt、识别 Schema、Provider/Fallback、AI 可观测性、容灾演练和分析 AI 的唯一入口。字段级映射保留在数据模型文档。


## AI 识别体系

AI 在系统中的定位是结构化识别和训练分析，不是自由 OCR。

## 图片识别

图片识别输出必须符合 schema：

- `measurement`
- `workout`
- `nutrition`
- `sleep`
- `unknown`

详见 [图片分类](#图片分类) 和 [识别 schema](#识别-schema)。

## Prompt

Prompt 源位于 `prompts/_source/*.json`，生成结果位于 `prompts/*.md`。修改规则时优先改 source，再运行生成器。

详见 [Prompt 体系](#prompt-体系)。

## 主备 AI

识别链路支持主 provider 和 fallback provider。fallback 只处理可恢复服务异常，不应处理业务拒绝。

详见 [Provider 与 fallback](#provider-与-fallback) 和 [AI 主备容灾演练](#ai-主备容灾演练)。

## 审计

AI 调用可 best-effort 写入 `ingest.ai_call_log`。审计失败不应阻断业务。

## 字段映射

图片识别 schema 到数据库字段的维护口径见 [图片识别字段映射](../数据模型/图片识别字段映射.md)。


## 图片分类

## 类型

| imageType | 业务含义 | 入库目标 |
| --- | --- | --- |
| `measurement` | 体脂秤、身体成分、体重 | `core.measurement` |
| `workout` | 运动记录、活动总览、心率、距离、消耗 | `core.activity`、`core.training_day` |
| `nutrition` | 饮食、餐次、热量摄入 | `core.meal`、`core.training_day` |
| `sleep` | 睡眠时长、阶段、评分、健康指标 | `core.sleep`、`core.training_day` |
| `unknown` | 非目标图片或无法可靠分类 | 不写 core |

## 红线

- 不把所有图片压成 OCR 文本。
- 不猜测截图没有显示的事实。
- 不用历史数据补当前图片。
- 不把低置信度当成功。


## 识别 Schema

当前识别 schema 名为 `telegram_training_image`，版本为 `v2`。

## 事实源

- `src/core/ai/telegram-recognition-schema.mjs`
- `tools/telegram-recognition-schema.mjs`
- `prompts/_source/recognition-rules.json`

## 顶层字段

- `imageType`
- `detectedApp`
- `detectedDate`
- `dateEvidence`
- `records`
- `confidence`
- `warnings`

## records

`records` 包含 measurement、activities、meals、totalCalories、details、dailyWorkoutSummary、sleep 等结构。字段缺失时应使用 `null` 或空数组，而不是省略或编造。

## 校验边界

- 非 JSON 或 schema parse failure 会先尝试严格 JSON 重试。
- schema 通过后还要经过日期、置信度和业务规则校验。
- schema 成功不等于入库成功。


## Prompt 体系

## 源文件

| 路径 | 作用 |
| --- | --- |
| `prompts/_source/recognition-rules.json` | 图片识别规则 |
| `prompts/_source/app-profiles.json` | APP 字段映射 |
| `prompts/_source/shared-rules.json` | 共享规则 |
| `prompts/_source/analysis-rules.json` | 分析规则 |
| `prompts/telegram-training-image-recognition.md` | 生成后的识别 prompt |
| `prompts/training-analysis.md` | 生成后的分析 prompt |

## 修改流程

1. 修改 `_source/*.json`。
2. 运行 `node tools/prompt-generator.mjs`。
3. 运行 prompt 和 schema 相关测试。
4. 同步更新 AI 文档和业务字段说明。

生成器的事实源是 `tools/prompt-generator.mjs`。当前生成结果只应落在
`prompts/telegram-training-image-recognition.md` 和 `prompts/training-analysis.md`。

## 约束

Prompt 是业务合同的一部分。字段、日期、分类和禁猜规则必须与 schema、写库逻辑和测试保持一致。


## Provider 与 Fallback

## Provider

当前 AI 调用使用 OpenAI-compatible Chat Completions。

基础变量：

- `AI_API_KEY`
- `AI_BASE_URL`
- `AI_MODEL`
- `AI_PROVIDER`
- `AI_TIMEOUT_MS`

## 识别 fallback

识别 fallback 使用历史命名：

- `TELEGRAM_RECOGNITION_FALLBACK_API_KEY`
- `TELEGRAM_RECOGNITION_FALLBACK_BASE_URL`
- `TELEGRAM_RECOGNITION_FALLBACK_MODEL`
- `TELEGRAM_RECOGNITION_FALLBACK_TIMEOUT_MS`

虽然变量带 `TELEGRAM_`，飞书图片识别也复用共享识别链路。

## 会 fallback 的情况

- timeout
- HTTP 429
- HTTP 5xx
- 网络错误
- 空内容或可恢复服务异常

## 不应 fallback 的情况

- 低置信度。
- 缺少可靠日期。
- 非目标图片。
- 用户输入导致的业务拒绝。
- schema 通过但业务字段不可信。

## 超时

缺失或非法 `AI_TIMEOUT_MS` 默认应归一为 45000ms，避免请求无限挂起。


## AI 主备容灾演练

AI 主备容灾只处理可恢复的服务异常，不处理业务拒绝。

## 配置面

识别主 provider：

- `AI_API_KEY`
- `AI_BASE_URL`
- `AI_MODEL`
- `AI_PROVIDER`
- `AI_TIMEOUT_MS`
- `AI_RECOGNITION_MODEL`
- `AI_RECOGNITION_TIMEOUT_MS`
- `AI_RECOGNITION_MAX_ATTEMPTS`

识别 fallback：

- `TELEGRAM_RECOGNITION_FALLBACK_API_KEY`
- `TELEGRAM_RECOGNITION_FALLBACK_BASE_URL`
- `TELEGRAM_RECOGNITION_FALLBACK_MODEL`
- `TELEGRAM_RECOGNITION_FALLBACK_TIMEOUT_MS`
- `AI_RECOGNITION_FALLBACK_TIMEOUT_MS`

分析 fallback：

- `AI_ANALYSIS_FALLBACK_API_KEY`
- `AI_ANALYSIS_FALLBACK_BASE_URL`
- `AI_ANALYSIS_FALLBACK_MODEL`
- `AI_ANALYSIS_FALLBACK_TIMEOUT_MS`

## 应触发 fallback

- 主 AI timeout。
- HTTP 429。
- HTTP 5xx。
- 网络错误。
- 空内容或可恢复服务异常。

## 不应触发 fallback

- 低置信度。
- 缺少可靠日期。
- 非目标图片。
- schema 已通过但业务字段不可入库。
- 用户输入本身不满足要求。

## 演练步骤

1. 在 dev 环境使用独立 AI 配置。
2. 将主 AI base URL 或模型临时配置为可恢复失败场景。
3. 发送一张有清晰日期的测试图片。
4. 检查同步 summary 是否出现 fallback attempt。
5. 检查 `ingest.ai_call_log` 是否记录 primary failure 和 fallback status。
6. 恢复主 AI 配置。
7. 再次发送测试图片，确认 primary 正常。

## 验收口径

- fallback 成功时，业务结果仍必须经过 schema、日期、置信度和写库校验。
- fallback 失败时，必须返回可诊断失败分类，不应静默丢数据。
- 审计日志失败不阻断业务，但 summary 必须能判断业务结果。


## AI 可观测性

## 审计表

`ingest.ai_call_log` 记录 AI 调用审计。

典型字段：

- `ai_call_id`
- `task_id`
- `scene`
- `provider`
- `model`
- `prompt_version`
- `idempotency_key`
- `status`
- `latency_ms`
- `failure_category`
- `failure_reason`
- token 和 cost 字段

## 运行判断

排查 AI 故障时先定位失败阶段：

1. 图片下载。
2. 缓存读取。
3. primary 调用。
4. 严格 JSON 重试。
5. fallback 调用。
6. schema 校验。
7. 业务校验。
8. DB persist。

## 告警建议

- fallback 使用率异常升高。
- schema failure 持续出现。
- primary + fallback 同时失败。
- AI latency 接近或超过 timeout。
- token/cost 异常增长。


## 分析 AI

分析 AI 读取 `TrainingSnapshot`，根据用户问题生成训练建议。

## 边界

- 不写数据库。
- 不写 Markdown。
- 不写随想。
- 不修改训练事实。

## 配置

- `TRAINING_ANALYSIS_GOAL`
- `TRAINING_ANALYSIS_PROMPT_PATH`
- `TRAINING_ANALYSIS_SNAPSHOT_POLICY`
- `AI_ANALYSIS_MODEL`
- `AI_ANALYSIS_TIMEOUT_MS`
- `AI_ANALYSIS_FALLBACK_*`

## 快照策略

`strict_db` 表示数据库快照不可用时直接返回数据源异常。`allow_markdown_fallback` 允许回退 Markdown，但必须在 summary 或回执中暴露 fallback 状态。
