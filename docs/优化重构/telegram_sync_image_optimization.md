# Telegram Sync 图片识别专项评估与优化建议

> **实施状态**：2026-06-01 已完成代码实施。P0/P1/P2 共 5 项已落地，P1 测试补充和 P3 数据库审计待后续。详见第 5 节实施详情。

## 1. 当前实现分析

### 1.1 审查范围与依据

本次审查仅覆盖 Telegram Sync 图片识别模块，重点包括图片日期识别、图片数量统计、Prompt 解析逻辑、数据校验逻辑和数据入库逻辑。

主要依据：

- `docs/训练系统/Telegram图片日期归档.md`
- `docs/训练系统/Telegram图片识别Prompt维护.md`
- `docs/训练系统/Telegram使用说明.md`
- `docs/系统架构/内部接口手册.md`
- `docs/数据流转/数据流转说明.md`
- `docs/模块说明/AI返回Schema校验.md`
- `docs/模块说明/AIProvider适配器.md`
- `docs/优化重构/re_v5/*`
- `prompts/telegram-training-image-recognition.md`
- `prompts/_source/recognition-rules.json`
- `prompts/_source/shared-rules.json`
- `tools/telegram-sync.mjs`
- `tools/telegram-sync-lib.mjs`
- `tools/telegram-recognition-schema.mjs`
- `src/ai/recognition-service.mjs`
- `src/ai/schema-validator.mjs`
- `src/db/training/write.mjs`
- `src/db/training/pending-recognition.mjs`
- `sql/pgsql17.sql`
- `test/telegram-sync.test.mjs`
- `test/telegram-sync-runner.test.mjs`
- `test/ai-recognition-service.test.mjs`
- `logs/telegram.txt`
- `.tmp/telegram-action-logs/*.log`
- 当前日常样例截图：`总消耗记录.jpg`、`训练记录.jpg`、`饮食记录.jpg`、`体脂秤数据记录.jpg`

本轮通过 `gh run view --log` 补充读取了最近六次 `Telegram Sync` Actions 完整日志。六次日志均由 Telegram 发送图片触发，且能反映“按最新失败日志继续优化重构代码”的实际迭代链路：

| Run | 时间 | 状态 | 说明 |
| --- | --- | --- | --- |
| #272 / `26735767631` | 2026-06-01 04:49 UTC | success | 新图片 batch `14242314693989005`，`ready + stored`，归档 `2026-05-30`，无 warning/error。 |
| #271 / `26735654822` | 2026-06-01 04:45 UTC | success | pending replay batch `14242310827589349` 已 `resolved` 并入库；同时单图 `single-398` 入库，带“月日补年份不确定” warning。 |
| #270 / `26735533825` | 2026-06-01 04:40 UTC | success | pending replay batch `14242286550751693` 已 `resolved`；新 batch `14242310827589349` 因 message `394/395` invalid JSON 被 `queued`。 |
| #269 / `26734205458` | 2026-06-01 03:53 UTC | success | batch `14242287890365181` 因检测到 `2026-05-31` 与 `2026-06-01` 冲突而跳过。 |
| #268 / `26734128793` | 2026-06-01 03:50 UTC | success | batch `14242286550751693` message `388` invalid JSON，跳过并提示 `photo` 不保留文件名。 |
| #267 / `26734018844` | 2026-06-01 03:46 UTC | success | batch `14242284559630125`，`ready + stored`，归档 `2026-05-31`，无 warning/error。 |

本轮审查结论更新：

- 当前环境已有 `gh` CLI 且已登录，可读取完整 Actions 日志；旧版“只能看到摘要”的限制已不成立。
- 最近六次日志证明：AI invalid JSON 仍会出现，但 pending recognition 的 `queued -> pendingReplay -> resolved` 链路已经开始发挥作用。
- 最近六次日志仍未直接输出 `sourceImageCount`、`recognizedImageCount`、`failedImageCount`，需要继续补强 1-4 张可变图片批次的可观测性。
- 最近六次日志中没有出现 `partialFailure=true`，但仍需要保留 ready batch 局部失败路径的报告和测试覆盖。

### 1.2 当前实际 1-4 张输入模式

当前日常 Telegram 图片常见完整集是 4 类截图，但每次实际发送可能是 1 张、2 张、3 张或 4 张，不应把“固定 4 张”当成入库前提。后续优化应以 `docs/训练系统/Telegram图片日期归档.md` 的现有逻辑为准：同一 batch 先看图片内可靠日期，再看 Telegram 原始文件名日期，最后才跳过。

这 4 类截图仍然是主要业务样例，但它们可以任意子集组合发送：

| 图片 | 识别类型 | 日期特征 | 主要提取字段 | 当前应有行为 |
| --- | --- | --- | --- | --- |
| `总消耗记录.jpg` | `workout` 日总览 | 顶部有完整日期，例如 `2026年5月29日星期五` | `dailyWorkoutSummary.activityCaloriesKcal=804`、`workoutDurationMinutes=71`、`activeHours=15` | 输出 `detectedDate=2026-05-29`，可作为单图或同批其他无日期图的可靠日期来源；不要拆成活动明细。 |
| `训练记录.jpg` | `workout` 活动明细 | 每条活动有月日和时间，例如 `5月29日 18:55`、`5月29日 06:39` | 多条 `records.activities`，如力量训练 185 千卡、HIIT 203 千卡、时长、心率 | 用 Telegram 消息年份补全为 `2026-05-29`；若同批还有其他图片日期，必须一致；不要写 `dailyWorkoutSummary`。 |
| `饮食记录.jpg` | `nutrition` | 画面通常无日期 | 早餐/午餐/晚餐、建议范围、单项食物、餐次热量、总热量 851 千卡 | 输出 `detectedDate=null` 和 `dateEvidence=no reliable image date`；只有同批有唯一可靠日期，或 Telegram 原始文件名有日期时，才能归档。 |
| `体脂秤数据记录.jpg` | `measurement` | 画面通常无日期，且样例无测量时间 | 体重 142.2 斤、BMI 22.9、体脂率 22.9%、骨骼肌 60.0 斤、骨盐量 5.8 斤、去脂体重 109.6 斤等 | 输出 `detectedDate=null`；无测量时间时 `measuredAt=null`；按斤转 kg 后入库，归档日期由 batch 后处理决定。 |

这个模式下，系统的核心目标不是要求每次都发送 4 张，也不是让每张图都独立产生日期，而是让任意 1-4 张图片按同一套日期归档规则安全入库：有日期图提供 `archivedDate`，无日期图只在同批有唯一可靠日期或文件名日期时继承，不能自行猜日期。

### 1.3 1-4 张日期决策矩阵

| 场景 | 应使用的归档日期 | 应处理方式 | 风险说明 |
| --- | --- | --- | --- |
| 单张总消耗图，画面有完整日期 | 图片内完整日期 | 单图 `ready` 并归档到该日 | 单图也应正常入库，不要求同批必须有 4 张。 |
| 单张训练图，画面只有月日和时间 | 月日 + Telegram 消息年份 | 单图 `ready`，但保留“年份补全不确定” warning | Telegram 消息时间只能补全年份，不能单独创造日期。 |
| 单张饮食图或体脂图以 `photo` 发送，画面无日期且无文件名日期 | 无 | 跳过，并提示 photo 不保留原始文件名 | 这是预期行为，不应让 AI 猜日期。 |
| 单张饮食图或体脂图以 `document` 发送，原始文件名有日期 | 文件名日期 | 可作为 `archivedDate` 回退 | 只在 Telegram Bot API 真拿到 `file_name` 时成立。 |
| 2-4 张同批，只有一张有可靠图片日期，其余无日期 | 唯一图片日期 | 整批 `ready`，无日期图继承同批日期 | 对应 `Telegram图片日期归档.md` 的“多张图片里只有一个可靠图片日期”。 |
| 2-4 张同批，每张都无图片日期，但文件名日期一致 | 唯一文件名日期 | 整批 `ready`，使用文件名日期归档 | 只适合 document 或 Bot API 能拿到原始 `file_name` 的情况。 |
| 2-4 张同批，有多个不同图片日期 | 无 | 整批 `skipped`，reason 应为 `conflicting detected dates` | 避免把不同天的训练、饮食或体脂误合并。 |
| 2-4 张同批，无图片日期但文件名日期冲突 | 无 | 整批 `skipped`，reason 应为 `conflicting filename dates` | 文件名回退也不能跨天混合。 |

结论：

- 总消耗图是常见四类截图中最可靠的日期锚点，但不是必传图片。
- 训练记录图的月日日期是可用证据；如果同批还有其他图片日期，必须一致。
- 饮食图和体脂图在当前样例格式下不应自行产生 `detectedDate`。
- 任意 1-4 张同批时，只要存在唯一可靠图片日期，无日期图继承该 batch `archivedDate` 是当前系统应保留的正确行为。
- 如果整批没有可靠图片日期，则严格按 `Telegram图片日期归档.md` 回退到唯一文件名日期；仍没有日期就跳过。

### 1.4 图片日期识别链路

当前日期链路分为 AI 识别和程序后处理两层：

1. Prompt 要求 AI 只从截图画面内可见内容提取 `detectedDate`，格式为 `YYYY-MM-DD`。
2. Prompt 明确禁止 AI 从 Telegram caption/text 或外部文件名推断 `detectedDate`。
3. 如果截图内只显示月日，AI 可以结合 Telegram 消息年份补全。
4. 如果截图是系统相册、文件详情或分享预览页，画面中可见的文件名、标题、路径日期可以作为图片内日期。
5. `normalizeRecognitionDate()` 会根据 `detectedDate`、`dateEvidence`、体脂秤 `measuredAt` 归一图片日期。
6. `collectFilenameDates()` 只从 Telegram 原始 image document 的 `fileName` 做回退日期提取。
7. `analyzeTelegramBatch()` 按优先级决定 `archivedDate`：
   - 唯一可靠图片日期优先。
   - 无图片日期时使用唯一文件名日期。
   - 多个图片日期冲突则跳过。
   - 多个文件名日期冲突则跳过。
   - 都没有可靠日期则跳过。
8. 入库时写入 `ingest.telegram_batch.archived_date`，并合并到 `core.training_day.archived_date`。

优点：

- 图片日期和 Telegram 外部文件名日期边界清楚。
- 同一批次多日期冲突时选择跳过，避免跨天误合并。
- 对 `photo` 丢失原始文件名的情况已有 warning。
- 对无日期图片、文件名日期回退、月日补年、体脂秤 `measuredAt` 回退已有测试覆盖。

风险：

- 饮食图和体脂图通常无日期，若以 `photo` 单独发送且无文件名日期，会按日期归档规则跳过；若与有日期图同批发送，才能安全继承同一 batch 的唯一可靠日期。
- `shouldParseDateEvidence()` 通过关键词判断 `dateEvidence` 是否来自图片，存在自然语言描述歧义。比如 `filename visible in image` 是合法图片证据，但仅写 `filename` 会被视为外部来源。
- 体脂秤样例无测量日期和测量时间；后续 Prompt 需明确 `measuredAt=null`，不要用 Telegram 消息时间或当前日期伪造。
- 当前报告未显示每张图片的日期来源明细，只能从 `warnings/issues/recognitions` 间接排查。

### 1.5 图片数量解析链路

当前数量链路由 Telegram 消息分组决定，不由 Prompt 决定：

1. Cloudflare Worker 对 Telegram 相册按 `media_group_id` 缓冲后 dispatch。
2. `groupTelegramUpdates()` 按 `media_group_id` 聚合相册；单图使用 `single-<message_id>`。
3. `normalizeTelegramMessage()` 将 Telegram `photo` 和 image 类型 `document` 统一为 `message.photos`。
4. Telegram `photo` 的多个尺寸版本会保留在同一条 message 的 `photos` 数组中。
5. `recognizeBatch()` 按 message 识别，使用 `message.photos.at(-1)` 作为最高质量图片。
6. 因此当前业务意义上的图片数量约等于 image batch 中 `batch.messages.length`，不是 `photos.length`。

在 1-4 张可变批次下，预期业务图片数应等于本次 Telegram batch 实际包含的业务图片数，而不是固定写死为 4。完整日常集通常是 4 张，但单次只发送饮食、训练或体脂补图时，`sourceImageCount` 可以是 1、2 或 3。

- `sourceImageCount` 应等于本次 batch 的业务图片数。
- `recognizedImageCount` 理想状态应等于 `sourceImageCount`。
- `failedImageCount` 理想状态应为 0。
- 如果用户本次明确发送完整 4 张，但 `sourceImageCount` 不是 4，应优先排查相册是否被拆分、是否漏发、是否有图片被识别为随想命令图片。
- 如果用户本次只发送 1-3 张，报告不应把“少于 4 张”视为异常；只需要核对 `recognizedImageCount + failedImageCount` 是否覆盖 `sourceImageCount`。

优点：

- 不依赖 AI 判断图片数量，避免 Prompt 对图片张数的幻觉。
- 相册按 Telegram `media_group_id` 聚合，符合 Telegram Bot API 的数据模型。
- `photo` 多尺寸版本不会被误认为多张业务图片。
- thought 图片与训练截图通过命令路由分流，不会混入训练识别。

风险：

- `buildTelegramSyncReport()` 没有直接输出 `sourceImageCount`、`recognizedImageCount`、`failedImageCount`，排查本次 1-4 张图片是否全部处理时不直观。
- 如果 Worker 相册缓冲缺失或 Telegram dispatch 分批到达，同一次发送的 2-4 张图片可能被拆成多个 batch；当前代码能按收到的 batch 处理，但报告层不容易看出是否发生拆分。
- 可变批次里任意一张识别失败都可能导致当天数据不完整；报告必须显式显示失败图片对应的 `messageId`。

### 1.6 Prompt 与 Schema 校验链路

当前 Prompt 来源是 `prompts/_source/*.json`，由 `tools/prompt-generator.mjs` 生成 `prompts/telegram-training-image-recognition.md`。运行时从 prompt metadata 读取版本、schema 名和 schema 版本。

Schema 当前要求：

- 顶层必填 `imageType`、`detectedDate`、`dateEvidence`、`records`、`confidence`、`warnings`。
- `records` 必填 `measurement`、`activities`、`meals`、`totalCalories`、`details`、`dailyWorkoutSummary`。
- `detectedDate` 必须匹配 `YYYY-MM-DD` 或为 `null`。
- 顶层和 records 默认不允许额外字段。

识别服务当前具备以下容错：

- 优先使用 `json_schema` structured output。
- 上游不兼容时降级到 `json_object`，必要时再去掉 response format。
- 对代码块、`data:` 前缀、非纯 JSON 包裹做候选 JSON 提取。
- JSON/schema 失败时追加一次严格 JSON 修复重试。
- 对 `records.details` 的字符串或对象做数组归一。
- 对 measurement 缺核心数据时降低置信度并写 warning。

优点：

- Prompt、schema、cache key 已绑定版本信息。
- JSON 解析与 schema 校验比直接 `JSON.parse` 稳定。
- 对饮食总热量、餐次、体脂单位换算已有多轮修复和测试。

风险：

- Prompt 当前是通用规则，没有显式描述常见四类截图的职责分工：总消耗图只写日总览，训练图只写活动明细，饮食/体脂无日期时不猜日期；同时也没有明确说明每次只可能收到 1-4 张中的任意子集。
- Prompt 未明确要求 AI 返回“本次只识别这一张图片，不统计整组图片数量”，虽然当前数量不依赖 AI，但模型可能在 `warnings/dateEvidence/details` 中混入多图推断文字。
- Prompt 对“同屏多日期”的处理只有 warning 要求，尚未更强约束 `detectedDate=null` 或降低 confidence 的触发条件。
- Prompt 对 `dateEvidence` 的格式没有结构化枚举，后处理仍需依赖文本关键词。

### 1.7 数据入库链路

`persistNormalizedBatch()` 的入库流程：

1. 根据 batch JSON 计算 `payload_hash`。
2. 事务开始。
3. 如果同 `batch_id` 且 hash 未变，返回 `unchanged`。
4. upsert `ingest.telegram_batch`。
5. upsert `ingest.telegram_message`。
6. upsert `ingest.telegram_recognition`。
7. 对 ready 图片批次读取现有 `core.training_day`。
8. `mergeBatchIntoDay()` 只替换当前 batch 包含的数据块：
   - 有 measurement 则替换 measurement，否则保留已有 measurement。
   - 有 activities 则替换 activities，否则保留已有 activities。
   - 有 nutrition payload 则替换 nutrition，否则保留已有 nutrition。
   - 有 workout summary 则替换 summary，否则保留已有 summary。
9. `replaceCoreDay()` 先删除该日 core 子表，再重建 `core.training_day`、`core.measurement`、`core.activity`、`core.meal`。
10. 成功提交，失败 rollback。

优点：

- 入库事务边界清晰，避免半批次写入。
- `payload_hash` 保证同批次幂等。
- 同日合并已避免新批次覆盖无关旧数据。
- 数据库失败时会 fallback 到 `训练记录.md` 并写 pending 队列。

风险：

- 可变批次中如果任一图片识别失败但 batch 仍达到 `ready`，成功识别部分会入库；当前代码已有 `partialFailure` 标记，也有整批 AI 失败进入 pending recognition 的测试和真实日志验证，但最近六次真实日志暂未覆盖 `partialFailure=true` 的生产路径。
- 最近六次 Actions 已覆盖“全部图片识别失败时进入 pending recognition，并在后续 action replay resolved”的路径，说明 invalid JSON 不再只停留在一次性失败日志里。
- `ingest.telegram_recognition` 只保存成功 recognition；失败 recognition 只在 batch payload 的 `recognitionErrors` 中体现，不利于按 message 追踪失败历史。
- `core.training_day.source_batch_id` 只能保存最后一次替换该日的 batch id，多次同日增量写入后无法直接从 core 表看出全部来源，需要回查 ingest。

### 1.8 最近六次 Action 日志复盘

最近六次 Telegram Sync 日志形成了一个很清晰的优化闭环：先出现 AI invalid JSON 和日期冲突，再通过代码优化补上 pending recognition、replay 和更明确的 report 字段，最后出现连续 `ready + stored` 的稳定结果。

| Run | 输入形态 | 同步结果 | 关键观察 |
| --- | --- | --- | --- |
| #267 | 图片 batch `14242284559630125` | `ready + stored`，`archivedDate=2026-05-31` | 基础图片 batch 路径可正常入库，日志无 warning/error。 |
| #268 | 图片 batch `14242286550751693`，message `388` | `skipped`，`failureCategory=ai_service` | inline retry 后仍 invalid JSON；当时只能看到跳过、photo 文件名 warning 和 `missing recognition`。 |
| #269 | 图片 batch `14242287890365181` | `skipped`，`failureCategory=user_input` | 冲突日期 `2026-05-31, 2026-06-01` 被正确拒绝，但缺少每张图日期来源明细，人工排查仍不够快。 |
| #270 | pending replay + 新图片 batch `14242310827589349` | 旧 batch `resolved`；新 batch message `394/395` invalid JSON 后 `queued` | pending recognition 开始生效；失败不再只是 action 日志里的瞬时错误，而是进入可重放队列。 |
| #271 | pending replay + 单图 `single-398` | pending batch `resolved`；单图 `ready + stored` | replay 能把 #270 的 invalid JSON 批次补入库；单图月日补年仍会产生不确定 warning。 |
| #272 | 图片 batch `14242314693989005` | `ready + stored`，`archivedDate=2026-05-30` | 最新路径稳定，无 `recognitionErrors`、无 warning，说明当前优化方向有效。 |

从这六次日志可以得出四个结论：

1. **AI invalid JSON 是真实高频风险**：#268、#270 都出现 invalid JSON，不能只依赖 inline retry。
2. **pending recognition 是必要能力**：#270 `queued`、#271 `pendingReplay=true + resolved` 证明队列补偿能修复真实发送图片失败。
3. **日期冲突策略不能放宽**：#269 正确跳过冲突日期，避免把跨天图片误合并；下一步不是放宽入库，而是增强日期来源可观测性。
4. **批次计数仍是盲点**：日志能看到 batch/message 错误，却看不到每个 batch 的 `sourceImageCount/recognizedImageCount/failedImageCount`，人工仍需从 `recognitionErrors` 反推。

## 2. 发现的问题

| 编号 | 问题描述 | 影响范围 | 风险等级 |
| --- | --- | --- | --- |
| P0 | `ready + partialFailure=true` 的生产路径仍需确认是否进入 pending recognition；最近六次真实日志只验证了 `skipped + ai_service -> queued -> resolved`。 | 1-4 张图片 batch；可能导致某张失败图片未补偿，而成功部分已入库。 | 高 |
| P1 | 同步报告仍缺少原始图片数、成功识别数、失败识别数；最近六次日志仍需要从 batch/message/error 反推本次图片是否齐全。 | Action 日志、Telegram 回执、人工确认 1-4 张图片是否齐全。 | 高 |
| P2 | 无日期的饮食图和体脂图依赖同批有日期 workout 图继承日期；如果单独以 `photo` 发送，预期会跳过。 | 日常发送方式、补发单张图片、排查“为什么没入库”。 | 高 |
| P3 | AI invalid JSON 在最近六次中重复出现，inline retry 不能保证一次 action 内恢复。 | OpenAI/兼容 API 抖动、schema 输出不稳定、图片识别重放。 | 中 |
| P4 | 日期冲突能正确跳过，但报告缺少每张图片的日期来源明细。 | 排查 #269 这类 `2026-05-31` vs `2026-06-01` 冲突。 | 中 |
| P5 | Prompt 未显式固化常见四类截图职责分工和 1-4 张可变批次边界，可能把总消耗图拆成活动、把训练明细图写成日总览，或让无日期图猜日期。 | Prompt 稳定性、字段入库准确性。 | 中 |
| P6 | `dateEvidence` 是自由文本，后处理通过关键词判断日期来源，存在表达歧义。 | 图片日期识别、无日期图片误识别、多日期图片排查。 | 中 |
| P7 | `ingest.telegram_message` 不存业务图片计数字段，`ingest.telegram_recognition` 不存失败 recognition 行。 | 数据审计和追踪，非核心入库正确性。 | 低 |

## 3. 优化建议

### 3.1 图片日期识别优化建议

- 保持现有 `detectedDate -> filename date -> skip` 优先级，不改变归档口径。
- 把常见四类截图的日期口径写入 Prompt 和测试，但不要要求每次必须 4 张：
  - `总消耗记录.jpg` 顶部完整日期是最可靠 `detectedDate`。
  - `训练记录.jpg` 行内月日必须结合 Telegram 消息年份补全；若同批有总消耗图，日期应与总消耗图一致。
  - `饮食记录.jpg` 无日期时必须输出 `detectedDate=null`。
  - `体脂秤数据记录.jpg` 无日期时必须输出 `detectedDate=null`。
- 体脂秤图没有测量时间时，`records.measurement.measuredAt` 应为 `null`；归档日期由 batch 后处理补齐，不由 AI 伪造。
- 在报告中增加每张图片的日期摘要或至少输出 `recognitionErrors` 对应 message，便于核对本次 batch 中哪张提供了日期。
- 报告中的日期摘要应服务于 1-4 张可变 batch：单图直接说明该图日期来源，多图说明哪张图提供唯一日期、哪张图继承日期、是否存在冲突日期。
- 保留现有冲突跳过策略，不建议为了提高入库率放宽多日期冲突规则。

### 3.2 图片数量解析优化建议

- 不让 Prompt 负责图片数量统计，继续以 Telegram message 数作为业务图片数量。
- 1-4 张可变 batch 的正常状态应是：
  - `sourceImageCount=N`
  - `recognizedImageCount=N`
  - `failedImageCount=0`
- 在报告和 Telegram 回执中补充 `sourceImageCount`、`recognizedImageCount`、`failedImageCount`。
- 对相册 batch 输出 `messageIds` 或失败 `messageId` 列表，方便定位本次 1-4 张中哪张漏识别。
- 不建议把 `photo` 多尺寸版本计入图片数；当前取 `photos.at(-1)` 作为最高质量图是合理的。

### 3.3 Prompt 优化建议

- 只改 `prompts/_source/recognition-rules.json`，再运行 `node tools/prompt-generator.mjs`，不要直接手写运行时 prompt。
- 在 Prompt 中加入常见四类截图规则，并明确“本次可能只有 1-4 张中的任意子集”：
  - “总消耗记录/活动总览截图是日总览，只写 `records.dailyWorkoutSummary`，不要拆成活动明细。”
  - “训练记录/活动列表截图是活动明细，只写 `records.activities`，不要写 `records.dailyWorkoutSummary`。”
  - “饮食记录截图如果画面没有日期，`detectedDate=null`，不要从 Telegram 时间、caption 或当前日期猜测。”
  - “体脂秤截图如果画面没有日期和测量时间，`detectedDate=null` 且 `records.measurement.measuredAt=null`。”
  - “本次只识别当前这张图片，不推断同一相册其他图片数量；同一批次可能只有 1 张、2 张、3 张或 4 张。”
  - “图片数量、相册顺序由程序统计，AI 不需要返回图片张数。”
  - “同屏多个日期且无法确定主日期时，`detectedDate=null`。”
  - “如果日期只来自 caption/text/Telegram 外部文件名，`detectedDate=null`。”
- 保持现有字段名和 schema，不新增字段，避免扩大改动面。

### 3.4 数据校验优化建议

- 保留已验证的 pending recognition 路径：当 image batch 因 AI invalid JSON 整体 `skipped` 时，应写入 `recognitionPendingStatus=queued`，后续 action 以 `pendingReplay=true` 重放并在成功后标记 `resolved`。
- 继续补强 ready partial failure 路径：只要 image batch 存在 `recognitionErrors` 或 `missing recognition`，即使 batch `status=ready`，也应将失败 message 所属 batch 或失败 message 信息进入 pending recognition。
- 对任意 1-4 张 batch，如果 `recognizedImageCount < sourceImageCount`，报告和回执必须标记 `partialFailure=true`。
- 对 ready 但 partial failure 的 batch，在报告和 Telegram 回执中持续显示失败 message id、pending 状态和失败原因。
- 对 replay 结果增加可读摘要：例如 `pendingReplay=true`、`recognitionPendingStatus=resolved`、`resolvedBatchId` 或 `originalFailureMessageIds`，避免只看 batch id 时难以串联 #270 与 #271。
- 保留现有 min confidence `0.75`，不建议降低阈值换取入库率。
- 增加日期来源歧义测试：只写 `filename` 不应被当作图片内日期；写 `visible filename in image` 才允许。

### 3.5 数据入库优化建议

- 不建议本轮修改数据库 schema 主结构。
- 短期优先利用现有 `batch_payload_json` 保存补强后的计数、日期证据和 partial failure 信息。
- 1-4 张可变 batch 场景下，整批 AI 失败已验证可进入 pending recognition；下一步重点是确保成功识别部分先入库时，失败图片也能进入 pending/replay，并按同一 `archivedDate` 补齐同一天数据。
- 若后续需要审计增强，再评估在 ingest 层增加失败 recognition 记录或统计字段；不应影响 `core.*` 主数据表。
- 继续保持 `replaceCoreDay()` 事务删除重建策略，不在本轮引入增量 SQL 重构。

### 3.6 推荐发送方式与限制

- 可以每天发送 1-4 张训练图片；如果当天发送多张，建议作为同一个 Telegram 相册发送，方便它们共享唯一可靠 `archivedDate`。
- 不建议以 `photo` 单独发送无日期的 `饮食记录.jpg` 或 `体脂秤数据记录.jpg`；如果确实只补发这类单图，优先以 `document/文件` 发送并保留带日期的原始文件名。
- 图片顺序理论上不应影响最终归档；但发送完整 4 类截图时，稳定顺序建议为：总消耗记录、训练记录、饮食记录、体脂秤数据记录，便于人工排查日志。
- 如果需要补发某天的饮食或体脂单图，优先用文件方式发送，并确保文件名含 `YYYY-MM-DD` 或 `YYYYMMDD`。
- 不要依赖 Telegram 消息发送时间作为训练日日期；它只能用于补全截图内可见月日的年份。

## 4. 优先级评估

| 优先级 | 建议项 | 是否建议实施 | 原因 |
| --- | --- | --- | --- |
| P0 | 报告增加 `sourceImageCount`、`recognizedImageCount`、`failedImageCount`，并显示 `x/N`。 | ✅ 已实施 | `analyzeTelegramBatch()` 返回 `sourceImageCount`、`recognizedImageCount`、`failedImageCount`；`buildTelegramSyncReport()` 输出这些字段。 |
| P0 | ready batch 存在部分识别失败时也进入 pending recognition，并在回执中明确显示。 | ✅ 已实施 | `shouldQueueRecognitionFailure()` 已支持 ready+partialFailure；`hasPartialRecognitionFailure()` 增加 count 字段检测。 |
| P1 | 在 Telegram 回执中显示”本批已识别 x/N，失败 y/N，pending/replay 状态”。 | ✅ 已实施 | `formatTelegramSyncNotification()` 增加 `formatImageCountText()` 输出 `已识别 N/M` 格式；partial failure 路径附带重试队列提示。 |
| P1 | Prompt 补强常见四类截图职责分工、1-4 张可变批次、dateEvidence、同屏多日期和数量边界规则。 | ✅ 已实施 | `recognition-rules.json` 新增 `batchRules` 和 `screenshotTypeRules` 章节；`shared-rules.json` 版本更新；`prompt-generator.mjs` 新增这两个章节渲染。 |
| P1 | 增加 1-4 张可变 batch、日期冲突、无日期单图、pending replay、partial failure 回归测试。 | ⚠️ 待后续 | 现有测试已更新以匹配新字段，新增专项回归测试建议后续 PR 补充。 |
| P2 | 报告增加 image-level 日期证据摘要。 | ✅ 已实施 | `analyzeTelegramBatch()` 构建 `dateSources` 数组（每条含 messageId/detectedDate/dateEvidence/source）；`buildTelegramSyncReport()` 输出。 |
| P3 | 评估 ingest 层失败 recognition 审计字段或表结构。 | ❌ 未实施 | 按建议暂不实施，避免扩大 schema 改动。 |

## 5. 实施详情 (2026-06-01)

### 修改文件清单

| 文件 | 变更内容 |
| --- | --- |
| `tools/telegram-sync-lib.mjs` | `analyzeTelegramBatch()` 新增 `sourceImageCount`/`recognizedImageCount`/`failedImageCount`/`dateSources` 追踪；`buildSkippedBatchResult()` 透传新字段 |
| `tools/telegram-sync.mjs` | `buildTelegramSyncReport()` 输出新字段；`shouldQueueRecognitionFailure()` 支持 ready+partialFailure；`hasPartialRecognitionFailure()` 增加计数检测；`attachFailureMetadata()` 补全 failureCategory；`formatTelegramSyncNotification()` 增加 `formatImageCountText()` |
| `prompts/_source/recognition-rules.json` | 版本 `2026-05-24`→`2026-06-01`；新增 `batchRules` 和 `screenshotTypeRules`；`dateRules` 增加同屏多日期和 dateEvidence 结构化规则 |
| `prompts/_source/shared-rules.json` | 版本 `2026-05-24`→`2026-06-01` |
| `prompts/_source/analysis-rules.json` | 版本 `2026-05-24`→`2026-06-01` |
| `tools/prompt-generator.mjs` | `generateRecognitionPrompt()` 新增 `batchRules` 和 `screenshotTypeRules` 渲染 |
| `src/db/training/pending-recognition.mjs` | `shouldQueueRecognitionFailure()` 同步更新以支持 ready+partialFailure |
| `test/telegram-sync-runner.test.mjs` | 适配新字段：`dateSources`/`sourceImageCount`/`recognizedImageCount`/`failedImageCount`；更新通知文本断言为 `已识别 N/M` 格式 |
| `test/prompt-generator.test.mjs` | 版本断言更新为 `2026-06-01` |

### 改动的关键行为

1. **报告新增字段**：每个 batch 的结果 JSON 中新增 `sourceImageCount`、`recognizedImageCount`、`failedImageCount` 和 `dateSources`。
2. **ready+partialFailure 进入 pending**：当 batch 状态为 `ready` 但存在部分消息识别失败时，整批进入 pending recognition 队列，下次 action 重放整批识别。
3. **通知文本增强**：Telegram 回执从 `解析成功` 变为 `解析成功（已识别 3/4，失败 1）`；失败消息附带 `失败图片已加入重试队列` 提示。
4. **Prompt 规则强化**：新增”批次规则”和”常见截图类型职责分工”章节，明确每次只识别一张图、1-4 张可变批次、总消耗图/训练图/饮食图/体脂秤图的职责分离。
5. **dateEvidence 结构化**：Prompt 要求区分 `visible filename in image`（允许）和 `filename`（禁止）。

### 风险说明

- ready+partialFailure 的 pending replay 是整批重放（非单条消息重试），已成功识别的消息会被重新识别。在缓存启用时结果一致；缓存未启用时可能有微小差异，但核心数据不应变化。
- 日期冲突/缺失的跳过逻辑完全保留，没有放宽。
- Prompt 新增的职责分工规则是增量补充，不改变现有字段结构和 schema。
- 通知中 `（已识别 N/M）` 格式对非 image batch（thought/analysis 等）不输出（`sourceImageCount=0` 时 `formatImageCountText` 返回空）。

### 后续观察项

- 观察 ready+partialFailure batch 进入 pending recognition 后在真实生产中的 replay 行为。
- 观察新 Prompt 规则下四类截图误判率的下降情况。
- 评估是否需要在后续 PR 中新增专项回归测试覆盖 1-4 张可变 batch 全场景。

## 5. 后续测试场景

文档更新本身不需要运行测试。若后续实施代码或 Prompt 优化，建议至少补充以下测试：

1. 单张总消耗图：画面有完整日期，最终归档到该日期。
2. 单张训练图：画面只有月日和时间，结合 Telegram 消息年份补全，并输出不确定 warning。
3. 2-4 张同批：总消耗图有完整日期，训练图有月日，饮食/体脂无日期，最终归档同一天。
4. 2-4 张同批：总消耗图完整日期与训练图月日补全年份后冲突，整批跳过。
5. 饮食图单独以 `photo` 发送且无文件名日期，跳过并输出 photo 文件名 warning。
6. 体脂图单独以 `photo` 发送且无文件名日期，跳过并输出 photo 文件名 warning。
7. 饮食图或体脂图单独以 `document` 发送且文件名有日期，使用文件名日期归档。
8. 整批图片 invalid JSON：batch 跳过并进入 pending recognition，下一次 action replay 成功后标记 `resolved`。
9. 任意 1-4 张 batch 中某张 invalid JSON：batch 可部分入库，但失败图片必须进入 pending recognition，并在回执中持续显示。
10. 报告输出 `sourceImageCount=N`、`recognizedImageCount`、`failedImageCount`。
11. 日期冲突报告输出 image-level 日期证据，能定位是哪张图贡献了冲突日期。
12. 总消耗图只写 `dailyWorkoutSummary`，训练图只写 `activities`。
13. 体脂秤图按斤转 kg：142.2 斤应入库为 71.1 kg，60.0 斤应入库为 30.0 kg，5.8 斤应入库为 2.9 kg，109.6 斤应入库为 54.8 kg。

建议命令：

```bash
node --test test/telegram-sync.test.mjs test/telegram-sync-runner.test.mjs test/ai-recognition-service.test.mjs
```

## 6. 是否建议实施

建议实施，但应保持小步改动：

1. 第一阶段只改报告字段、ready partial failure 的 pending 条件和测试，优先保障 1-4 张可变 batch 不会“部分失败后静默缺数据”。
2. 第二阶段增强 Telegram 回执，把 `x/N`、失败 message id、pending/replay 状态直接反馈给用户。
3. 第三阶段只改 Prompt 结构化源和生成结果，固化常见四类截图职责分工和 1-4 张可变批次边界。
4. 第四阶段再评估是否需要 ingest 审计增强。

不建议本轮实施以下内容：

- 不重构 Telegram Sync 整体架构。
- 不改变 Telegram 命令语义。
- 不改变 `archivedDate` 判定优先级。
- 不改变 `core.*` 表结构。
- 不把图片数量统计交给 AI。
- 不引入新的 OCR 服务或独立识别服务。

当前实现整体满足生产使用的基础要求，且最近六次 Actions 已验证整批 AI 失败可通过 pending recognition 重放恢复。下一步最高价值缺口是 1-4 张可变 batch 的计数可观测性、ready partial failure 补偿和 image-level 日期证据摘要；这些缺口不需要新架构即可按现有 pending recognition、report、回执和 Prompt 生成机制补强。
