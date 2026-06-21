# AI 容灾与调度优化

## 第四轮 AI 识别业务校准

### AI 在系统中的定位

AI 识别不是自由文本总结，而是把图片中可见事实转换成受 schema 约束的结构化业务数据。AI 的职责是识别、分类、抽取和解释可见信息；系统的职责是校验、拒绝不可靠结果、保留证据、写入数据库。任何重构都不能把 AI 输出直接等同于事实。

### 图片分类与入库目标

当前图片识别 schema 的业务类型包括 `measurement`、`workout`、`nutrition`、`sleep`、`unknown`。不同类型的目标不同：

| 图片类型 | AI 识别目标 | 结构化结果 | 入库逻辑 | 关键校验 |
| --- | --- | --- | --- | --- |
| 训练图片 `workout` | 识别训练动作、重量、次数、组数、时长、消耗、训练日期等截图中可见事实 | workout/activity payload，允许字段为空但不得编造 | 写入 `core.activity`，刷新 `core.training_day` | 日期可靠性、动作/数值合法性、confidence、schema |
| 饮食图片 `nutrition` | 识别食物、餐次、热量、宏量营养等可见或模型明确可判断信息 | meal/nutrition payload | 写入 `core.meal`，刷新 `core.training_day` | 低置信度不写；不能用历史饮食补齐 |
| 体脂秤图片 `measurement` | 识别体重、体脂率、BMI、肌肉、水分、内脏脂肪、测量时间等指标 | measurement payload | 写入 `core.measurement`，刷新 `core.training_day` | 单位、范围、测量日期、缺失指标为空 |
| 睡眠图片 `sleep` | 识别入睡/醒来、总睡眠、睡眠评分、睡眠阶段等 | sleep payload | 写入 `core.sleep`，按睡眠归档规则刷新 `core.training_day` | 跨日规则、`sleep_bedtime` 推导、dateSources/warnings |
| 未知图片 `unknown` | 判断不是可入库的训练/饮食/体脂/睡眠截图 | unknown + reason | 不写 core | summary 说明 skipped，不自动重试 |

### Prompt、schema 和校验边界

- Prompt 源位于 `prompts/_source/*.json`，由规则文件组合成识别 prompt；文档不能只写“调用 AI OCR”，必须说明 prompt 是业务合同的一部分。
- AI 输出必须通过 JSON/schema 校验；非 JSON 或 schema parse failure 先在同一 provider 上追加严格 JSON 提示重试。
- `confidence < 0.75` 的结果不能写入 core，应进入 skipped 或人工介入路径。
- AI 只能提取图片和用户文本中可见信息，不能用历史记录、常识或目标值补齐缺失字段。
- 字段缺失时应保留 `null` 或空结构，而不是生成看似合理的数值。
- 日期处理必须保留 `dateSources`、`warnings` 和最终 `archivedDate`；`archivedDate` 不是日期可靠性的唯一证据。

### AI 异常处理

| 异常 | 当前/目标处理 | 是否 fallback |
| --- | --- | --- |
| provider/network timeout、429、5xx、空内容 | 视为可恢复服务异常，按配置调用 fallback provider 或进入 pending | 是 |
| 非 JSON / schema parse failure | 先同 provider 严格 JSON 重试；仍失败则记录 schema failure | 不应笼统认为都会 fallback |
| 低置信度 | 业务拒绝，summary 说明原因 | 否 |
| 缺少可靠日期 | `manual_intervention` 或 skipped，不写 core | 否 |
| DB timeout / 写入失败 | 已识别结果进入 pending replay，等待重放 | 不属于 AI fallback |
| 用户发送非目标图片 | `unknown/skipped` | 否 |

### 数据准确性红线

1. 训练、饮食、体脂、睡眠的识别目标必须清楚分开，不能把所有截图压成同一种 OCR 文本。
2. 不允许为了提高入库率而猜测日期、年份、重量、热量、睡眠分数或训练项目。
3. 睡眠跨日推导必须在 summary 中暴露，不能只留下最终日期。
4. Telegram 和飞书必须使用同一识别目标、同一 schema 校验和同一失败分类。
5. AI 识别成功不等于入库成功；AI 结果、DB persist 和业务回执必须分阶段记录。

## 主备 AI 切换策略

### 当前状态

- 图片识别支持 `TELEGRAM_RECOGNITION_FALLBACK_*`。
- 分析链路当前本地实现已支持 `AI_ANALYSIS_MODEL`、`AI_ANALYSIS_TIMEOUT_MS`、`AI_ANALYSIS_MAX_ATTEMPTS` 和 `AI_ANALYSIS_FALLBACK_*`；`AI_SCHEDULER_ENABLED=false` 时会回到通用 `AI_*` 且停用 analysis fallback。
- recognition 与 analysis 的 AI 调用已 best-effort 写入 `ingest.ai_call_log`，fallback 结果会保留 `aiAttemptKind/model`；真实 dev/main `/analysis` 端到端仍需验收。
- dev 最近 10 次 Action 中，飞书图片出现过 AI schema parse failure，说明 fallback 与 schema 校验必须纳入真实业务状态，而不是只看 workflow success。

### 目标策略

按场景配置 provider：

| 场景 | Primary（当前 env 前缀） | Fallback（当前 env 前缀） | 是否缓存 | 风险等级 |
| --- | --- | --- | --- | --- |
| 图片识别 | `AI_*`（通用）+ `TELEGRAM_RECOGNITION_MODEL`（覆盖模型） | `TELEGRAM_RECOGNITION_FALLBACK_*`（API_KEY, BASE_URL, MODEL, PROVIDER, TIMEOUT_MS） | 是 | P1 |
| 训练分析 | `AI_*`（通用）+ `AI_ANALYSIS_MODEL` / `AI_ANALYSIS_TIMEOUT_MS`（scheduler 开启时覆盖） | `AI_ANALYSIS_FALLBACK_*`（API_KEY, BASE_URL, MODEL, TIMEOUT_MS；scheduler 开启且配置完整时启用） | 可选 | P2 |

> **注意**：当前环境变量命名以 `TELEGRAM_` 为前缀（历史原因），后续统一为 `RECOGNITION_*` / `ANALYSIS_*` 前缀时需同步更新 workflow YAML 和代码。

当前 GitHub 配置事实：

| 配置 | 当前值/状态 | 说明 |
| --- | --- | --- |
| `AI_BASE_URL` | `https://www.packyapi.com/v1` | 主 AI base URL |
| `AI_MODEL` | `gpt-5.4-mini` | 主模型 |
| `AI_API_KEY` | secret 存在，值不可反读 | 主 AI key |
| `TELEGRAM_RECOGNITION_FALLBACK_BASE_URL` | `https://api.moonshot.cn/v1` | 识别 fallback base URL |
| `TELEGRAM_RECOGNITION_FALLBACK_MODEL` | `kimi-k2.6` | 识别 fallback model |
| `TELEGRAM_RECOGNITION_FALLBACK_TIMEOUT_MS` | `30000` | fallback timeout |
| `TELEGRAM_RECOGNITION_FALLBACK_API_KEY` | secret 存在，值不可反读 | fallback key |
| `TELEGRAM_RECOGNITION_MODEL` | 当前未配置变量 | 为空时使用 `AI_MODEL` |
| `AI_TIMEOUT_MS` / `AI_CONCURRENCY` | 代码已有默认与 clamp；实际 GitHub Variable 配置由 `实施checklist.md` 跟踪 | `AI_TIMEOUT_MS` 为空或非法时默认 45000ms；`AI_CONCURRENCY` 为空时 `runTelegramSync()` 默认 3，`AI_CONCURRENCY_MAX` 可限制误设上限 |

> **运行观察**：`Sync (Dev) #57` 飞书图片识别耗时约 37.7s、persist 约 6.6s。飞书 inline 图片的识别耗时已接近建议 timeout 45s；当前本地合同已让 adapter 在未配置 `AI_TIMEOUT_MS` 时使用 45s 默认超时。`AI_CONCURRENCY=2` 是建议的飞书图片限流策略，不是修复“单并发”默认值；代码默认并发为 3。

切换触发：

- timeout
- HTTP 429
- HTTP 5xx
- 网络错误
- 空内容
- 空内容或 provider 返回格式退化导致的可恢复内容错误

不切换：

- 用户输入不是训练截图。
- 明确鉴权失败。
- prompt 配置缺失。
- schema 业务字段合理为空。
- AI 返回内容已进入 schema validator 且判定为业务结构不合格。

当前代码边界：

- `requestRecognitionWithProviderFallback()` 只在 provider/network/timeout/HTTP 429/5xx/empty content 等可恢复错误时切 fallback。
- AI 返回非 JSON 或 schema parse failure 时，当前先在同一 provider 上追加严格 JSON 提示重试；重试后仍失败才记为 schema 失败。
- 因此文档和测试不能把所有 `AiSchemaError` 都视为会触发 fallback。

## 超时控制设计

| 场景 | 建议 timeout | 原因 |
| --- | --- | --- |
| 图片单张识别 | 45s | 截图 OCR 和视觉模型较慢 |
| 图片批次整体 | `单张 timeout * 并发批次 + 10s` | 防止 Action 卡死 |
| 训练分析 | 60s | 文本总结较长 |
| fallback 单次 | primary 的 70% | 快速恢复，不拖长总耗时 |

配置分层（区分仓库已配置、当前未配置但建议补齐、代码已支持但真实环境仍待验收的调度变量）：

```text
# ── 仓库 Variables/Secrets 已确认存在 ──
TELEGRAM_RECOGNITION_CACHE_ENABLED=true
TELEGRAM_RECOGNITION_FALLBACK_API_KEY=<key>
TELEGRAM_RECOGNITION_FALLBACK_BASE_URL=<url>
TELEGRAM_RECOGNITION_FALLBACK_MODEL=<model>
TELEGRAM_RECOGNITION_FALLBACK_TIMEOUT_MS=30000

AI_API_KEY=<key>              # 通用 AI provider（识别+分析共用）
AI_BASE_URL=<url>
AI_MODEL=<model>

# ── 当前未配置，但 workflow/代码引用且建议补齐 ──
TELEGRAM_RECOGNITION_MODEL=<model>
TELEGRAM_RECOGNITION_FALLBACK_PROVIDER=openai-compatible
AI_PROVIDER=openai-compatible
AI_TIMEOUT_MS=45000
AI_CONCURRENCY=2

# ── 本地代码已支持；仓库级配置与 dev/main 端到端仍待验收 ──
AI_SCHEDULER_ENABLED=true
AI_RECOGNITION_TIMEOUT_MS=45000
AI_RECOGNITION_MAX_ATTEMPTS=2
AI_RECOGNITION_FALLBACK_TIMEOUT_MS=30000
AI_ANALYSIS_TIMEOUT_MS=60000
AI_ANALYSIS_MAX_ATTEMPTS=2
AI_ANALYSIS_FALLBACK_API_KEY=<key>
AI_ANALYSIS_FALLBACK_BASE_URL=<url>
AI_ANALYSIS_FALLBACK_MODEL=<model>
```

> 状态口径：`AI_SCHEDULER_ENABLED`、`AI_RECOGNITION_*`、`AI_ANALYSIS_*` 已在本地代码路径中生效；上表不表示仓库级 Variables/Secrets 已全部配置，也不替代真实主 AI 超时、fallback 成功、双 AI 失败和 dev/main `/analysis` 端到端验收。

## fallback 机制

执行顺序：

1. 计算 idempotency key。
2. 查缓存。
3. 调 primary。
4. primary 可恢复失败则调 fallback。
5. fallback 成功则写 `provider_role=fallback`。
6. 两者失败则写 pending 或返回失败。

AI 调用记录：

| 字段 | 说明 |
| --- | --- |
| `ai_call_id` | 单次调用 ID |
| `task_id` | 对应业务任务 |
| `scene` | recognition / analysis |
| `provider_role` | primary / fallback |
| `model` | 实际模型 |
| `prompt_version` | prompt 元数据 |
| `status` | started / succeeded / failed |
| `latency_ms` | 耗时 |
| `failure_category` | 失败分类 |

## 防重复执行机制

| 重复来源 | 防重方式 |
| --- | --- |
| GitHub Action 重跑 | `task_id + payload_hash` |
| AI primary 超时后实际成功但客户端未收到 | `idempotency_key`、现有识别缓存和审计字段 |
| 同一图片多次发送 | `image_fingerprint + prompt_version + model` |
| pending 重放 | `message_task.status` 和 `attempt_count`；当前本地合同已在 `ingest.telegram_pending_batch` 读取前把超过 retry limit 的 `pending` 置为 `abandoned`，并用 `FOR UPDATE SKIP LOCKED` claim 待重放记录 |

## 飞书图片容灾重点

飞书图片链路与 Telegram 不同，容灾设计必须单列：

- 飞书图片使用 `image_key`，需要 tenant access token 和 `sourceMessageId` 下载资源。
- 飞书 workflow 当前强制 `FEISHU_RECOGNITION_IMAGE_INPUT_MODE=inline`。
- schema parse failure 中出现过模型输出 `<think>...` 非 JSON 的情况，必须在日志中记录 snippet、provider、model 和 fallback 是否尝试。
- DB timeout 会使已识别图片进入 `pending_replay`；业务回执应明确“待自动重试”，不能写成完全成功。

## 生产 AI 故障 runbook

AI 故障不能只按“主 AI / 备 AI”二分。线上排障必须先定位失败发生在：图片下载、缓存读取、primary 调用、严格 JSON 重试、fallback 调用、schema 校验、业务校验、DB persist。

| 故障 | 当前行为 | 运维判断 | 处理动作 | 告警 |
| --- | --- | --- | --- | --- |
| 主 AI 超时 | `AI_TIMEOUT_MS` 配置为正数时 AbortController 生效；未配置或非法时使用 45000ms 默认超时 | summary/log 出现 timeout、AbortError、AI request failed | 立即确认 GitHub Variable `AI_TIMEOUT_MS=45000` 与本地默认是否一致；若 fallback 成功，确认业务是否 `stored`；若 pending，等待或手动重放 | 单次 timeout 记录 warning；15 分钟内 >=3 次告警 |
| 主 AI 429/5xx/network | `shouldRetryWithFallbackProvider()` 会触发 fallback provider | 看 stderr 中 `primary AI recognition failed...retrying with fallback provider` | 检查主 provider 状态、限流、余额；临时降低 `AI_CONCURRENCY`；必要时切主备 | fallback 使用率连续 10 分钟 > 30% 告警 |
| 主 AI 返回非法 JSON/schema | 当前先同 provider 追加严格 JSON 提示重试；仍失败后记录 schema failure | 看 `recognition parse failure` 的 `parseStage` 和 snippet | 不要无限重跑；若同类模型持续输出 `<think>` 或非 JSON，切模型或收紧 prompt/response_format | schema failure >=2 次/小时告警 |
| 备 AI 超时/异常 | fallback 调用失败后图片进入 skipped/pending，视失败阶段而定 | summary 出现 `ai_service`、`recognitionPendingStatus=queued` 或 `partialFailure` | 检查 fallback key/base/model；若两家 provider 均不可用，暂停图片批量发送并保留 pending | primary + fallback 均失败立即告警 |
| AI 返回低置信度或缺日期 | 系统按业务拒绝，不应 fallback | `failureDisposition=manual_intervention` 或 skipped | 要求用户重发带日期截图，或人工校正数据；不能靠重跑修复 | 不作为平台故障告警，但进入人工队列 |
| AI 成本或 token 异常增长 | 当前 `ingest.ai_call_log` 已有 token/cost 字段，`maintenance:inspect` 可汇总最近窗口；真实 provider 账单侧仍需外部对账 | 从 `ingest.ai_call_log`、run duration、图片数、fallback 使用率、provider 账单侧判断 | 降低 `AI_CONCURRENCY`，限制图片大小/数量，核对 token/cost 是否持续异常 | 日成本超过预算或单 run 耗时异常告警 |

### 人工介入边界

以下状态不得通过自动重试解决，应直接进入人工处理：

- `dateConfidence=missing` 或 `no reliable image or filename date`。
- 低置信度但 AI 服务本身成功。
- 同批图片出现互相冲突的日期证据。
- 用户发送非训练/饮食/体脂/睡眠截图。
- schema 校验通过但业务字段明显不可信，需要修 prompt 或人工数据修正。

## AI 调用日志与审计设计

审计表见 `数据库优化.md`；当前本地/schema 合同已包含 `ingest.ai_call_log`，并保留 nullable token/cost 字段。

日志写入策略：

- 调用前写 `started`。
- 调用成功更新 `succeeded`、latency、token/cost 字段。
- 调用失败更新 `failed`、failure_category、failure_reason。
- 日志写入失败不阻断业务，但要写 stderr 和 GitHub summary。

## 风险控制

| 风险 | 等级 | 原因/证据 | 控制 |
| --- | --- | --- | --- |
| fallback 模型输出格式不同 | P1 | 不同 provider 对 JSON/schema 约束遵循程度不同 | fallback 也必须通过同一 schema validator |
| 超时过短导致误失败 | P2 | 飞书 inline 图片识别已观察到接近 45s | dev 观测 1 周后调参 |
| 缓存误命中 | P1 | 识别缓存若只按图片 ID 命中会忽略 prompt/schema/model 差异 | cache key 包含 promptVersion + schemaVersion + model |
| 日志表写入影响性能 | P2 | AI 审计写入属于辅助链路 | 异步或 best-effort 写入 |
| Action success 掩盖 AI 业务失败 | P1 | workflow conclusion 与 `taskStatus/failureDisposition` 不是同一层语义 | summary 中 `taskStatus/failureDisposition` 必须进入告警和审计 |
| DB pending 无终止条件导致长期重复执行 | P1 | 原始审计发现 SQL 有 `abandoned` 注释但读取不检查 attempt 上限；当前本地合同已在 pending 读取前执行 `abandoned` 收敛，并在 summary 中暴露人工处理状态 | 超过最大重试后进入 `abandoned`，并在通道回执/GitHub summary 中提示人工处理 |
| npm `form-data` CRLF 漏洞影响 AI 请求 | P1 | `npm audit --omit=dev` 已暴露 high 漏洞 | `npm audit fix` 修复，AI provider 和飞书 API 的 multipart 请求均受影响 |
| npm `dompurify` sanitization 漏洞影响 HTML 处理链 | P2 | `npm audit --omit=dev` 已暴露 moderate 漏洞 | `npm audit fix` 修复，避免报告/页面渲染链路保留已知 XSS 风险 |
| `AI_TIMEOUT_MS` 未配置时 `AbortController` 不生效 | P0 | 原始审计发现 timeoutMs <= 0 时返回原始 fetch；当前本地合同已将缺失/非法 timeout 归一为 45000ms | AI 调用不会因缺失变量而无限挂起；真实 dev/main 慢请求仍需端到端观察 |
| 主 AI 超时后 fallback 成功但主 AI 实际已完成 | P1 | 主 AI 响应慢但请求仍可能在服务端执行，导致重复 AI 调用；当前本地合同已为 primary/fallback/严格 JSON 重试使用同一 `idempotency_key` 并发送 `Idempotency-Key` header | 保留本地 idempotency key 合同；真实 provider 是否按 header 去重、是否需要独立表级 idempotency cache 仍需外部验证/后续设计 |
| 同 provider 严格 JSON 重试成功路径需保留缓存/审计回归保护 | P2 | `retryRecognitionAfterInvalidContent()` 成功后会回到 `recognizeTelegramImageMessage()`，当前本地合同已记录 `aiAttemptKind=normal/strict_json_retry/fallback`，并覆盖普通成功、严格 JSON 重试成功、fallback 成功写入 `ingest.telegram_recognition.recognition_json` | 保留三路径缓存/审计合同测试；真实 dev/main AI schema failure -> strict retry -> 入库链路仍需端到端观察 |
| `AI_CONCURRENCY` 默认值 3，但 env 可被设置过高 | P2 | `runTelegramSync()` 默认 3，`mapWithConcurrency()` 会限制 worker 数，不是无限并发；风险在于未给 env 配置硬上限，误设过大时可能压垮 AI/飞书下载/DB | 对 `AI_CONCURRENCY` 做 min/max clamp，建议默认 3、飞书图片配置 2、硬上限 5，并增加峰值并发测试 |
| 图片/分析用户文本边界需保留端到端验收 | P1 | 原始审计发现图片 `caption/text` 和 `/analysis` question 都进入 AI messages；当前本地实现已分别通过 `sanitizePromptUserText()` 与 `normalizeAnalysisQuestion()` 限长、移除控制字符，并标注用户文本不是系统指令 | 保留 prompt-safe 本地合同测试；真实 dev/main 超长、HTML、Emoji、控制字符 AI 请求仍需端到端验收 |

## Bug 修复方案（本轮审计新发现）

### P0-1: `AI_TIMEOUT_MS` 未配置时 `AbortController` 不生效

**问题描述**

原始审计发现 `src/adapters/ai/openai-compatible.adapter.mjs` 在 `timeoutMs <= 0` 时会直接返回原始 `fetch` 请求，导致 `AbortController` 不生效。当 `AI_TIMEOUT_MS` 未配置时，请求可能无限挂起直至 GitHub Actions 6 小时超时。当前本地合同已完成：`normalizeTimeoutMs()` 会把缺失、非数字或小于等于 0 的值归一为 `45000`。

**代码级修复**

文件：`src/adapters/ai/openai-compatible.adapter.mjs`

当前实现要点：

```javascript
function normalizeTimeoutMs(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return 45000;
  }
  return Math.floor(normalized);
}
```

**测试策略**

1. 单元测试：`test/ai-provider.test.mjs` 覆盖 `AI_TIMEOUT_MS` 缺失时仍附加 `AbortController` signal。
2. Mock `fetch` 为永不 resolve 的 Promise，断言 `AbortController.signal.aborted === true`。
3. 集成测试：在 GitHub Actions dev 环境临时移除 `AI_TIMEOUT_MS`，发送大图请求，确认 45s 左右触发 timeout 并进入 fallback。

**回滚计划**

- 回退 `src/adapters/ai/openai-compatible.adapter.mjs` 到修改前版本。
- 移除或恢复 `AI_TIMEOUT_MS` 环境变量默认值配置。
- 监控 `AI_TIMEOUT_MS` 已配置的线上环境不受影响。

---

### 风险：主 AI 超时后 fallback 成功但主 AI 实际已完成

**问题描述**

主 AI 响应较慢时，客户端因超时触发 fallback 并成功。但主 AI 请求仍在服务端执行，导致同一任务产生重复 AI 调用，增加成本并可能引发数据不一致。

**实施状态（本地）**：已完成调用侧 idempotency 合同。当前 `openai-compatible` provider 会在 `input.idempotencyKey` 存在时发送 `Idempotency-Key` header；图片识别基于 `schemaName/schemaVersion/promptVersion/primary model/image fingerprint/message identity` 生成稳定 key，primary、fallback、严格 JSON 重试复用同一 key，并把 `aiIdempotencyKey` 写入 `ingest.telegram_recognition.recognition_json` 和 `ingest.ai_call_log` 审计字段。`test/ai-provider.test.mjs` 覆盖 header 转发，`test/ai-recognition-service.test.mjs` 覆盖 primary/fallback 共用 key。真实 provider 是否实际按该 header 去重、以及是否需要独立表级 idempotency cache，仍需后续外部验证/设计。

**已落地实现要点**

文件：

- `src/adapters/ai/openai-compatible.adapter.mjs`
- `src/app/use-cases/image-recognition.use-case.mjs`

1. 在发起 AI 请求前生成 `idempotencyKey`：

```javascript
const idempotencyKey = buildRecognitionIdempotencyKey({
  message,
  imageUrl,
  promptVersion,
  schemaName,
  schemaVersion,
  model,
});
```

2. 将 `idempotencyKey` 传入 provider，并由 provider 转成请求 header：

```javascript
await aiProvider.requestChatCompletion({
  messages,
  idempotencyKey,
});
```

3. 当前没有声明已完成独立 `idempotency_key` 缓存表；现有缓存仍以 `sourceChannel + fileUniqueId + promptVersion + schemaVersion + model` 读取 `ingest.telegram_recognition`。是否增加表级 idempotency cache 属后续设计。

**测试策略**

1. 已覆盖：验证 `Idempotency-Key` 出现在请求 headers 中。
2. 已覆盖：验证 primary 与 fallback provider 收到相同 `idempotencyKey`。
3. 已覆盖：验证 recognition JSON / AI call log 保留 `aiIdempotencyKey`。
4. 待真实环境验证：provider 侧是否实际去重，以及慢 primary 超时后 fallback 成功时 provider 账单/调用次数是否收敛。

**回滚计划**

- 移除 `Idempotency-Key` header 的注入逻辑。
- 保留缓存逻辑，但不再以 `idempotency_key` 为索引查询。
- 降级为原有超时+重试行为，重复调用风险恢复为已知问题。

---

### 风险：同 provider 严格 JSON 重试成功路径缓存/审计回归保护

**问题描述**

当 AI 返回非 JSON 或 schema parse 失败后，系统在同一 provider 上使用严格 JSON 提示重试。代码路径显示：`retryRecognitionAfterInvalidContent()` 成功后返回解析结果，`recognizeTelegramImageMessage()` 会把结果放进 batch recognition，随后 `PostgresTelegramBatchRepository.upsertRecognitions()` 写入 `ingest.telegram_recognition`。因此不能把“重试成功不写缓存”写成已确认 bug；当前本地合同已补齐三路径测试，重点转为保留普通成功、严格 JSON 重试成功、fallback 成功的缓存/审计字段不回退。

**实施状态（本地）**：已完成本地合同校准。`recognizeTelegramImageMessage()` 会输出 `aiAttemptKind=normal/strict_json_retry/fallback`；`test/ai-recognition-service.test.mjs` 覆盖三种识别尝试来源；`test/training-db-core.test.mjs` 覆盖 `normal`、`fallback` 和 `strict_json_retry` 都会写入 `ingest.telegram_recognition.recognition_json` 并保留 `model/promptVersion/schemaVersion/cacheKey/aiIdempotencyKey` 等审计字段。真实 dev/main 的 AI schema failure -> strict JSON retry -> DB 入库端到端仍需观察。

**已落地实现要点**

文件：

- `src/app/use-cases/image-recognition.use-case.mjs`
- `src/adapters/postgres/telegram-batch-repository.pg.mjs`

```javascript
return {
  messageId: message.messageId,
  ...parsed,
  aiAttemptKind: recognitionResult.attemptKind, // normal | strict_json_retry | fallback
  promptVersion,
  schemaName,
  schemaVersion,
  model: usedModel,
  cacheKey,
};
```

测试应持续断言 `upsertRecognitions()` 对以下三类结果都会写入 `ingest.telegram_recognition`：

- 首次 strict schema 成功。
- 非 JSON / schema parse failure 后严格 JSON 重试成功。
- primary 可恢复失败后 fallback provider 成功。

**测试策略**

1. Mock 首次请求返回非 JSON，重试请求返回合法 JSON，验证最终 `ingest.telegram_recognition.recognition_json` 被写入且 `aiAttemptKind=strict_json_retry`。
2. 再次请求相同 `fileUniqueId + promptVersion + schemaVersion + model`，验证直接命中缓存，无 AI 调用。
3. Mock primary timeout/fallback success，验证 fallback model 对应 cache key 和 recognition JSON 均正确。

**回滚计划**

- 如新增 `aiAttemptKind` 字段影响下游 schema，可先只在测试 fixture 中通过日志/spy 验证写库路径，延后字段落库。
- 保留严格 JSON 重试机制本身，不改 provider fallback 条件。

---

### 风险：`AI_CONCURRENCY` 默认值 3，但 env 可被设置过高

**问题描述**

`runTelegramSync()` 在 `AI_CONCURRENCY` 未配置时默认 3；`mapWithConcurrency()` 会按 `Math.min(limit, items.length)` 控制 worker 数，因此不是 `Promise.all` 无限并发。真实风险是环境变量缺少硬上限：如果误设为 20/50，同批图片会同时触发大量下载、AI 调用和 DB 写入，导致 provider 429、Feishu token/资源接口压力增大或 Action 资源峰值过高。

**代码级修复**

文件：`src/app/use-cases/telegram-sync.use-case.mjs`

```javascript
function normalizeAiConcurrency(value, { defaultValue = 3, maxValue = 5 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return Math.min(maxValue, Math.max(1, Math.floor(parsed)));
}
```

调用处：

```javascript
const aiConcurrency = normalizeAiConcurrency(env.AI_CONCURRENCY, {
  defaultValue: 3,
  maxValue: Number(env.AI_CONCURRENCY_MAX ?? 5),
});
```

飞书图片可通过 GitHub Variable 配置 `AI_CONCURRENCY=2` 作为限流策略，但文档和测试必须写清楚代码默认值仍是 3。

**测试策略**

1. 单元测试：`AI_CONCURRENCY` 缺失、0、非数字时返回默认 3。
2. 单元测试：`AI_CONCURRENCY=50` 时被 clamp 到 `AI_CONCURRENCY_MAX`。
3. 并发测试：10 个 mock 图片任务、并发设为 3/5 时，峰值不超过上限。
4. dev 端到端：飞书连续图片批次配置 `AI_CONCURRENCY=2`，日志中的同时 AI 请求峰值不超过 2。

**回滚计划**

- 如 clamp 误伤吞吐，可只调整 `AI_CONCURRENCY_MAX`，无需回退代码。
- 保留 `mapWithConcurrency()` 现有 worker 实现，不引入新依赖。

## 回滚方案

1. `AI_SCHEDULER_ENABLED=false`。
2. 图片识别回到现有 fallback provider 逻辑。
3. 分析回到现有 `requestTrainingAnalysis()`。
4. 保留 AI 日志表，不参与读取。

## 验证

```bash
node --test test/ai-provider.test.mjs test/ai-recognition-service.test.mjs test/training-analysis.test.mjs
```

验收时必须覆盖：

- provider timeout/429/5xx/network error 触发 fallback。
- schema parse failure 的同 provider 严格 JSON 重试。
- 普通成功、严格 JSON 重试成功、fallback 成功三条路径均写入 recognition 缓存/审计。
- 图片 caption/text 和分析 question 的超长、HTML、Emoji、控制字符不会破坏请求 JSON，也不会被当作系统指令。
- schema 业务校验失败不无限 fallback。
- DB pending 达到最大重试后进入 `abandoned`，不再被下一轮 sync 读取为 pending。
