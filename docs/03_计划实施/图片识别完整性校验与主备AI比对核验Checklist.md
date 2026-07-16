# 图片识别完整性校验与主备 AI 比对核验 Checklist

> 用途：核验“主 AI 完整则直接入库；主 AI 业务字段不完整则调用备 AI；主备补全并通过最终门禁后才写入 core；仍不完整或关键字段冲突时不得宣称成功”的实施结果。
>
> 对应实施方案：<code>docs/03_计划实施/图片识别完整性校验与主备AI比对实施方案.md</code>
>
> 适用链路：Telegram、飞书、pending replay，共享 <code>runMessageSync</code> 识别与入库编排。

## 0. 使用规则

- [ ] 每个检查项均已记录可复查证据，不能只填写“已完成”。
- [ ] 自动化项记录测试文件、测试名称和命令结果；数据库项记录脱敏后的批次 ID、SQL 摘要和行数；人工项记录截图编号或 Action run ID，不粘贴图片、Prompt、Secret 或完整 AI 响应。
- [ ] 标为“P0 阻断”的任一项失败，最终结论必须为 No-Go。
- [ ] “技术调用成功”与“业务识别完整”分开判定；HTTP 200、Schema 合法、Action 绿色均不能单独作为入库成功证据。
- [ ] 只把最终通过 Schema、SemanticGate、完整性门禁和冲突门禁的结果写入 <code>core.*</code>。
- [ ] 本清单不要求把 PostgreSQL 所有 nullable 列改为必填；完整性按图片类型和截图可见内容判断。

### 核验信息

| 项目 | 记录 |
| --- | --- |
| 核验分支（只能是 dev 或 main） | dev |
| 核验 commit |  |
| 核验环境 | 本地代码与自动化测试；不连接 dev/main 数据库，不读取远端 Secret |
| 核验开始/完成时间 | 2026-07-16 / 进行中 |
| 核验人 | Codex |
| 对应 PR / Action run |  |
| 测试数据说明（不得含敏感值） |  |

## 1. 实施前代码事实复核

### 1.1 当前缺陷基线

- [x] **BASE-01（P0）** 已确认 <code>src/core/ai/telegram-recognition-schema.mjs</code> 只要求字段键存在，<code>weightKg</code>、<code>bodyFatPct</code>、<code>totalCalories</code>、<code>activityCaloriesKcal</code>、<code>totalSleepMinutes</code>、<code>sleepScore</code> 等叶子值仍允许为 <code>null</code>。
- [x] **BASE-02（P0）** 已确认 <code>src/app/use-cases/image-recognition-provider.mjs</code> 的旧 fallback 判定主要覆盖 <code>AiProviderError</code>、429、5xx、超时和网络错误，未覆盖“Schema 合法但业务字段缺失”。
- [ ] **BASE-03（P0）** 已定位并反转 <code>test/ai-recognition-service.test.mjs</code> 中旧测试 <code>does not fallback for business-incomplete measurement payloads</code> 的行为预期。
- [x] **BASE-04（P0）** 已确认 <code>src/adapters/telegram/sync-batch-logic.adapter.mjs</code> 的旧逻辑可能在识别置信度和日期有效时返回 <code>status: ready</code>，但没有覆盖四类图片的通用业务完整性门禁。
- [x] **BASE-05（P0）** 已确认 <code>src/adapters/postgres/source-batch-repository.pg.mjs</code> 的旧状态映射会把非 <code>unknown</code> 识别记为 <code>succeeded</code>，未表达“业务不完整”或“主备冲突”。
- [x] **BASE-06（P0）** 已确认 <code>src/app/use-cases/image-recognition.use-case.mjs</code> 的旧缓存命中可在 Provider 调用和新门禁之前直接返回 <code>ingest.recognition_run.raw_result_json</code>。
- [x] **BASE-07（P0）** 已确认 <code>src/adapters/telegram/sync-analysis.adapter.mjs</code> 的 <code>normalizeActivities()</code> 旧实现只保留 <code>time/type/detail</code>，会丢弃 <code>durationSeconds/calories/heartRate/distanceKm/avgSpeedKmh</code>。
- [x] **BASE-08** 已确认 <code>src/core/entities/training-record.mjs</code> 能接收上述结构化 activity 字段，<code>src/adapters/postgres/core-row-writer.pg.mjs</code> 也能写入对应数据库列，因此字段丢失发生在 batch 归一化阶段而非表结构限制。
- [x] **BASE-09** 已确认 <code>tools/check-core-data-consistency.mjs</code> 主要发现“ingest 有记录而 core 无对应行”，不能充分发现“core 行存在但关键列为 null/0”的问题。
- [x] **BASE-10** 已确认 <code>src/site/monitor-view.mjs</code> 实际依赖体重、体脂、饮食热量、训练消耗、睡眠时长或评分，识别缺失会直接表现为页面缺值或误显示 0。

### 1.2 数据库与共享链路基线

- [ ] **BASE-11（P0）** 已核对 <code>sql/dev-sql/core.sql</code> 和 <code>sql/main-sql/core.sql</code>：<code>core.measurement.weight_kg/body_fat_pct</code>、<code>core.activity.calories</code>、<code>core.meal.calories</code>、<code>core.sleep.total_sleep_minutes/sleep_score</code> 均允许为空。
- [x] **BASE-12（P0）** 已确认 <code>core.training_day.training_calories</code> 为 <code>NOT NULL DEFAULT 0</code>，实现和核验不会把“未识别到消耗量”错误解释为真实的 0 kcal。
- [x] **BASE-13** 已确认 <code>ingest.recognition_run.fields_json/raw_result_json</code>、<code>ingest.source_batch.payload_json</code>、<code>ingest.ai_call_log</code> 可承载本期完整性与主备审计信息；若未新增关系列，不需要仅为本功能强制做表迁移。
- [x] **BASE-14（P0）** 已确认 Telegram 和飞书都进入 <code>src/app/use-cases/message-sync.use-case.mjs</code> 的 <code>runMessageSync</code>，完整性逻辑没有复制成两套渠道实现。
- [x] **BASE-15（P0）** 已确认备用 Provider 只有在 <code>TELEGRAM_RECOGNITION_FALLBACK_API_KEY</code>、<code>TELEGRAM_RECOGNITION_FALLBACK_BASE_URL</code>、<code>TELEGRAM_RECOGNITION_FALLBACK_MODEL</code> 三项齐全时才会创建。
- [x] **BASE-16（P0）** 已确认 <code>.github/workflows/pending-replay.yml</code> 的旧配置未注入完整的备用识别 Provider 配置，实施范围包含修复该路径。

### 基线证据记录

| 检查项 | 文件/行号或命令 | 结果摘要 | 证据位置 |
| --- | --- | --- | --- |
| BASE-01～BASE-05 | `telegram-recognition-schema.mjs:31-192`；`image-recognition-provider.mjs:27-106`；`sync-batch-logic.adapter.mjs:277-558`；`source-batch-repository.pg.mjs:193-231` | 基线确认；BASE-03 待反转旧测试 | 本地源码只读复核 |
| BASE-06～BASE-10 | `image-recognition.use-case.mjs:86-138`；`sync-analysis.adapter.mjs:341-353`；`training-record.mjs:98-120`；`core-row-writer.pg.mjs:125-220`；`check-core-data-consistency.mjs`；`monitor-view.mjs:106-155,308-326` | 基线确认；字段保真已进入 RED/GREEN | `telegram-sync.test.mjs` 定向测试 |
| BASE-11～BASE-16 | `sql/dev-sql/core.sql`、`ingest.sql`；`message-sync.use-case.mjs:627-653`；`.github/workflows/pending-replay.yml:38-68` | dev SQL 与共享链路确认；main SQL 仍待最终静态复核 | 本地源码/SQL 只读复核 |

## 2. 完整性合同核验

### 2.1 通用合同

- [ ] **COMP-01（P0）** 已存在来源中性的完整性模块，例如 <code>src/core/ai/recognition-completeness.mjs</code>；模块名、入参和返回值不绑定 Telegram 或飞书。
- [ ] **COMP-02（P0）** 完整性结果至少可表达 <code>complete</code>、<code>incomplete</code> 和需阻断自动入库的 <code>review/conflict</code> 状态。
- [ ] **COMP-03（P0）** 结果中包含稳定版本号、缺失字段路径列表、触发依据和是否需要 fallback；判断代码不依赖自然语言错误文本。
- [ ] **COMP-04** 缺失字段使用稳定字段路径，例如 <code>records.measurement.weightKg</code>，不只返回“数据不完整”。
- [ ] **COMP-05（P0）** Schema 校验、SemanticGate 和完整性门禁均执行；完整性门禁不能替代数值范围、日期等既有语义校验。
- [ ] **COMP-06（P0）** 图片日期继续由现有 batch 日期合同判断，不把日期重复塞进 measurement/workout/nutrition/sleep 叶子完整性合同。
- [ ] **COMP-07（P0）** 未在截图或 OCR 证据中出现的可选字段，不会仅因数据库列为空就触发 fallback，也不会由备 AI 猜测补齐。
- [ ] **COMP-08** 完整性函数是纯函数或可稳定复现：同一识别结果、OCR 证据和合同版本必然得到相同结论。

### 2.2 四类硬完整性

- [ ] **MEAS-C01（P0）** measurement 必须存在 <code>records.measurement</code>。
- [ ] **MEAS-C02（P0）** measurement 至少要求有效 <code>weightKg</code> 才能形成可入库业务记录。
- [ ] **MEAS-C03** 当截图页型或 OCR 明确展示体脂率时，<code>bodyFatPct</code> 为空会判定不完整并触发备 AI。
- [ ] **MEAS-C04** 非数值、非有限数、明显越界值仍交由 SemanticGate 阻断，不会因“非 null”被完整性门禁误判为有效。

- [ ] **WORK-C01（P0）** workout 满足以下至少一种才可视为硬完整：存在有效 activities；或存在有效 <code>dailyWorkoutSummary.activityCaloriesKcal</code>。
- [ ] **WORK-C02（P0）** 每条参与入库的 activity 至少有有效 <code>time/type/detail</code>，无效 activity 不得靠空字符串通过。
- [x] **WORK-C03（P0）** <code>durationSeconds/calories/heartRate/distanceKm/avgSpeedKmh</code> 在识别、主备合并、batch 归一化、实体归一化和 PostgreSQL writer 全链路不丢失。
- [ ] **WORK-C04** 当 OCR 明确展示“活动热量/运动消耗”时，activity <code>calories</code> 或 <code>dailyWorkoutSummary.activityCaloriesKcal</code> 均缺失会触发备 AI。
- [ ] **WORK-C05** 只有 <code>detail</code> 文本但没有当前页型要求的结构化消耗值时，不会被误判为完整。

- [ ] **NUTR-C01（P0）** nutrition 必须有有效 <code>totalCalories</code>，或能从至少一条有效 <code>meal.calories</code> 进行确定性求和。
- [ ] **NUTR-C02（P0）** 只有 <code>details</code> 而没有总热量或可求和 meal calories 时判定不完整。
- [ ] **NUTR-C03** 自动求和规则已固定并有测试，空值、重复餐食、非法数值不会被静默当作 0。
- [ ] **NUTR-C04** 当 OCR 明确展示“总热量/总摄入”时，<code>totalCalories</code> 为空会触发备 AI；合并后的值仍需通过 SemanticGate。

- [ ] **SLEEP-C01（P0）** sleep 必须存在 <code>records.sleep</code>。
- [ ] **SLEEP-C02（P0）** <code>totalSleepMinutes</code> 或 <code>nightSleepMinutes</code> 至少一个有效，才可形成可入库睡眠记录。
- [ ] **SLEEP-C03（P0）** 只有 <code>sleepScore</code> 而没有睡眠时长时不能单独视为硬完整。
- [ ] **SLEEP-C04** 当 OCR 明确展示“睡眠评分”时，<code>sleepScore</code> 为空会触发备 AI。
- [ ] **SLEEP-C05** 总睡眠、夜间睡眠、午睡和睡眠阶段之间的既有语义校验仍生效；主备合并不能绕过这些校验。

### 2.3 条件字段证据

- [ ] **COND-01（P0）** 条件必填依据来自 OCR 文本、可复现页型/App Profile 或明确标签，不以模型“可能看见”为依据。
- [ ] **COND-02** “睡眠评分、活动热量/运动消耗、体脂率、总热量/总摄入”等标签识别规则均有正向和反向 fixture。
- [ ] **COND-03（P0）** 截图未展示条件字段时，主 AI 缺该字段不会无意义调用备 AI。
- [ ] **COND-04（P0）** 截图明确展示条件字段而主 AI 缺失时，必须调用备 AI。
- [ ] **COND-05** 条件匹配记录字段路径和证据类型，不在普通日志、Bot 回执或 Action summary 中输出 OCR 原文和业务数值。

### 完整性合同证据记录

| 检查项 | 测试名称/fixture | 预期 | 实际 | 证据位置 |
| --- | --- | --- | --- | --- |
| measurement |  |  |  |  |
| workout |  |  |  |  |
| nutrition |  |  |  |  |
| sleep |  |  |  |  |
| 条件字段 |  |  |  |  |

## 3. 主备 AI 触发、比对和合并

### 3.1 触发规则

- [ ] **FALL-01（P0）** 主 AI 技术失败时，原有可重试错误仍会调用备 AI，未因新完整性逻辑回归。
- [ ] **FALL-02（P0）** 主 AI Schema 合法且业务字段完整时，只调用主 AI，备 AI 调用次数为 0。
- [ ] **FALL-03（P0）** 主 AI Schema 合法但硬完整性字段缺失时，调用备 AI。
- [ ] **FALL-04（P0）** 主 AI 缺失 OCR 明确可见的条件字段时，调用备 AI。
- [ ] **FALL-05（P0）** 主 AI 结果不完整且备 AI 未配置或配置不全时，返回明确的业务未完成状态，不继续写 <code>core.*</code>，不伪装为“主 AI 成功”。
- [ ] **FALL-06** 同一图片的主备调用保持相同来源身份和幂等语义，可从审计信息关联为同一次识别任务。
- [ ] **FALL-07** 主备调用分别记录 Provider、model、attempt kind、耗时、token 和状态；不得把备 AI 调用覆盖成主 AI 调用。
- [ ] **FALL-08** fallback 只因技术失败或合同不完整触发；未知图片、未授权消息等既有非识别场景不被错误升级为双模型调用。

### 3.2 确定性合并

- [ ] **MERGE-01（P0）** 已存在来源中性的确定性合并模块，例如 <code>src/core/ai/recognition-reconciliation.mjs</code>。
- [ ] **MERGE-02（P0）** 主值非空、备值为空时保留主值。
- [ ] **MERGE-03（P0）** 主值为空、备值非空且通过 Schema/SemanticGate 时，才允许由备值补齐。
- [ ] **MERGE-04** 主备值相同或在已文档化、具名常量控制的数值容差内时，保留主值并记录一致。
- [ ] **MERGE-05（P0）** 关键字段冲突超过容差时不按模型置信度自动二选一，结果进入冲突/人工处理状态且不写 <code>core.*</code>。
- [ ] **MERGE-06（P0）** 合并只按字段白名单执行，不使用浅合并覆盖整个 <code>records</code> 对象，不把备 AI 的空值覆盖到主 AI 有效值。
- [ ] **MERGE-07（P0）** 备 AI 不得填充截图不可见字段；条件字段仍需有 OCR/页型证据。
- [ ] **MERGE-08（P0）** 合并结果再次执行 Schema、SemanticGate 和最终完整性门禁。
- [ ] **MERGE-09** 合并结果保留可审计来源：最终来自 primary、fallback 补全或 reconciled；字段级来源如有记录，不包含业务明文。
- [ ] **MERGE-10** activity 数组的合并和去重规则稳定，不因顺序变化制造重复活动或丢失结构化指标。

### 主备行为证据记录

| 场景 | 主调用数 | 备调用数 | 合并状态 | 是否写 core | 证据 |
| --- | ---: | ---: | --- | --- | --- |
| 主完整 |  |  |  |  |  |
| 主技术失败、备成功 |  |  |  |  |  |
| 主不完整、备补全 |  |  |  |  |  |
| 主备均不完整 |  |  |  |  |  |
| 主备关键字段冲突 |  |  |  |  |  |
| 备 AI 未配置 |  |  |  |  |  |

## 4. 缓存与幂等

- [ ] **CACHE-01（P0）** 缓存命中结果仍执行当前版本完整性门禁，不能从 <code>image-recognition.use-case.mjs</code> 直接作为成功结果返回。
- [ ] **CACHE-02（P0）** 旧的业务不完整缓存不会继续命中为成功；已通过下列方式之一失效：完整性版本进入 cache key，或 prompt/schema/pipeline 版本明确提升。
- [ ] **CACHE-03** cache key 可区分来源渠道、文件身份、prompt、schema、model、能力模式和本次采用的完整性合同版本。
- [ ] **CACHE-04（P0）** 缓存命中但结果不完整时，按合同触发备 AI；若备 AI 补全成功，最终缓存/审计指向新结果而不是继续复用旧缺失结果。
- [ ] **CACHE-05（P0）** 主备均不完整或冲突的结果不得作为“最终成功缓存”供后续绕过门禁。
- [ ] **CACHE-06** 已完整的主 AI 缓存命中不会再次调用主 AI 或备 AI。
- [ ] **CACHE-07** fallback/reconciled 结果的 model、provider、final source 和 completeness version 与 cache key、运行元数据一致。
- [ ] **CACHE-08（P0）** 同一消息重复投递或 pending replay 不会重复写入业务行，也不会因主备两次调用生成两套 <code>core.*</code> 行。
- [ ] **CACHE-09** 完整性门禁版本升级的历史缓存处置策略已测试，不依赖人工清库。

### 缓存证据记录

| 场景 | cacheStatus | AI 调用序列 | 最终状态 | 幂等结果 | 证据 |
| --- | --- | --- | --- | --- | --- |
| 完整缓存 |  |  |  |  |  |
| 旧不完整缓存 |  |  |  |  |  |
| 冲突缓存 |  |  |  |  |  |
| 重复消息/重放 |  |  |  |  |  |

## 5. Telegram、飞书与 pending replay 一致性

- [ ] **CHAN-01（P0）** 完整性和主备比对只在共享业务层实现一次，Telegram、飞书渠道装配未各自复制规则。
- [ ] **CHAN-02（P0）** Telegram 完整图片：主 AI 一次、备 AI 零次、最终写库成功。
- [ ] **CHAN-03（P0）** 飞书完整图片：主 AI 一次、备 AI 零次、最终写库成功。
- [ ] **CHAN-04（P0）** Telegram 主 AI 不完整时会调用备 AI，并按最终门禁决定是否入库。
- [ ] **CHAN-05（P0）** 飞书主 AI 不完整时会调用备 AI，并按与 Telegram 相同的最终门禁决定是否入库。
- [ ] **CHAN-06** 两个渠道的识别业务状态、缺失字段路径、冲突状态和通知含义一致，仅下载/回执 adapter 保持渠道差异。
- [ ] **CHAN-07（P0）** <code>.github/workflows/pending-replay.yml</code> 已注入备用 Provider 所需 key/base/model 以及需要的 protocol/timeout 配置，命名与同步 workflow 和代码读取保持一致。
- [ ] **CHAN-08（P0）** pending replay 对 Telegram 和飞书均执行完整性门禁，不会把历史不完整 payload 直接写入 <code>core.*</code>。
- [ ] **CHAN-09** <code>.github/workflows/sync-dev.yml</code>、<code>.github/workflows/sync.yml</code> 和 pending replay 的主备环境变量集合已做静态核对。
- [ ] **CHAN-10（P0）** 已分别核验 dev/main 的 fallback key、base URL、model 是否存在；只记录“存在/缺失”，不输出 Secret 值。
- [ ] **CHAN-11** fallback 配置只填一部分时有明确告警和业务未完成状态；不会静默降级后仍回复“解析成功”。

### 渠道与配置证据记录

| 检查项 | Telegram | 飞书 | pending replay | 证据 |
| --- | --- | --- | --- | --- |
| 主完整 |  |  | 不适用/已测 |  |
| 主不完整、备补全 |  |  |  |  |
| 主备仍不完整 |  |  |  |  |
| fallback 配置完整性 |  |  |  |  |

## 6. 入库、状态与审计

### 6.1 写库门禁

- [ ] **DB-01（P0）** <code>core-row-writer.pg.mjs</code> 或其调用方只接收最终完整且无关键冲突的结果。
- [ ] **DB-02（P0）** 主 AI 不完整、备 AI 尚未完成时，不会提前写 measurement/activity/meal/sleep/training_day。
- [ ] **DB-03（P0）** 主备均不完整时，<code>core.*</code> 对该批次新增行数为 0。
- [ ] **DB-04（P0）** 主备关键字段冲突时，<code>core.*</code> 对该批次新增行数为 0。
- [ ] **DB-05（P0）** 备 AI 补全成功后，只写最终合并结果，不把主、备原始结果各写一份。
- [ ] **DB-06（P0）** 写库失败仍沿用既有 pending/manual intervention 规则；不能把数据库写入失败误报为识别不完整。
- [ ] **DB-07** 写库事务边界保证业务表不会留下“部分类型已写、最终门禁失败”的半成品。

### 6.2 字段级数据库核验

- [ ] **DB-MEAS-01（P0）** measurement 成功样本的 <code>core.measurement.weight_kg</code> 与最终识别结果一致且非空。
- [ ] **DB-MEAS-02** 截图明确展示体脂率的成功样本，<code>core.measurement.body_fat_pct</code> 非空且来自通过语义校验的最终结果。
- [ ] **DB-WORK-01（P0）** activity 样本的 <code>calories/heart_rate/distance_km/avg_speed_kmh/duration_seconds</code> 与最终结构化结果逐项一致。
- [ ] **DB-WORK-02（P0）** 没有真实消耗值时，不会仅因 <code>core.training_day.training_calories DEFAULT 0</code> 把该批次判为完整或成功。
- [ ] **DB-NUTR-01（P0）** nutrition 成功样本的 <code>core.training_day.intake_calories</code> 来自已验证总值或确定性 meal 求和。
- [ ] **DB-NUTR-02** meal calories 不会因空值归一化为 0 而制造虚假总摄入。
- [ ] **DB-SLEEP-01（P0）** sleep 成功样本的 <code>core.sleep.total_sleep_minutes</code> 或 <code>night_sleep_minutes</code> 至少一个非空。
- [ ] **DB-SLEEP-02** OCR 明确展示睡眠评分的成功样本，<code>core.sleep.sleep_score</code> 非空；未展示评分的样本允许为空。
- [ ] **DB-UI-01** 最终页面数据质量检查不再把本次成功样本标为对应类别缺失，且不会用默认 0 掩盖缺失。

### 6.3 ingest 与 AI 审计

- [ ] **AUDIT-01（P0）** <code>ingest.recognition_run</code> 不再把业务不完整或冲突结果无条件标为 <code>succeeded</code>。
- [ ] **AUDIT-02** <code>fields_json/raw_result_json</code> 或约定 JSONB 中可追踪 <code>completeness.status/version/missingFields/triggeredFallback</code>。
- [ ] **AUDIT-03** 约定 JSONB 中可追踪 <code>reconciliation.status/conflictFields</code> 以及 primary/fallback/final source 元数据。
- [ ] **AUDIT-04（P0）** <code>ingest.source_batch.status/reason/issues_json/payload_json</code> 能区分最终完整、仍不完整、关键冲突、备 AI 未配置。
- [ ] **AUDIT-05** <code>ingest.ai_call_log</code> 能看到主备两次调用及各自成功/失败，不泄露 Prompt、图片或完整响应。
- [ ] **AUDIT-06** 安全摘要只记录字段路径、数量、状态、provider/model 等低敏元数据，不记录缺失字段对应的实际业务值。
- [ ] **AUDIT-07** 若本期未新增表列，dev/main SQL 导出无无关漂移；若实际新增列，则 dev/main DDL、迁移和 repository 同步更新且有回滚说明。
- [ ] **AUDIT-08** 已增加能发现“core 行存在但关键业务列缺失”的专项断言或查询，不仅依赖 <code>npm run check:core-consistency</code>。

### 数据证据记录

| 批次类型 | sourceChannel | 脱敏 batch ID | recognition 状态 | core 行数/关键列 | 结果 |
| --- | --- | --- | --- | --- | --- |
| measurement |  |  |  |  |  |
| workout |  |  |  |  |  |
| nutrition |  |  |  |  |  |
| sleep |  |  |  |  |  |
| incomplete |  |  |  |  |  |
| conflict |  |  |  |  |  |

## 7. Bot 回执、Action summary 与安全

### 7.1 状态文案

- [ ] **STATUS-01（P0）** 主 AI 完整且已入库时，Bot 才可返回对应的成功文案。
- [ ] **STATUS-02** 备 AI 补全并已入库时，回执能表达“经补全后完成”，但不暴露模型响应和业务字段值。
- [ ] **STATUS-03（P0）** 主备均不完整时，Bot 不得出现“解析成功”“已入库”，应明确“解析未完成/未入库”及安全原因分类。
- [ ] **STATUS-04（P0）** 主备关键字段冲突时，Bot 不得出现“解析成功”“已入库”，应明确需人工处理。
- [ ] **STATUS-05（P0）** 备 AI 未配置或配置不完整时，Bot 不得出现“解析成功”，应明确数据未写入。
- [ ] **STATUS-06** 技术流程可保持 Action job 绿色时，<code>businessStatus</code>、<code>failureDisposition</code>、批次状态必须明确业务未完成。
- [ ] **STATUS-07** <code>src/app/use-cases/message-sync/status.mjs</code> 中 <code>status: ready</code> 的成功文案不会覆盖完整性失败状态。
- [ ] **STATUS-08** Action summary 分别呈现：主结果完整、备 AI 补全成功、主备仍不完整、主备冲突、备 AI 未配置。

### 7.2 信息安全

- [ ] **SAFE-01（P0）** 控制台日志、Bot、Action summary 和测试快照不含图片 base64、图片 URL token、完整 OCR、完整 Prompt、完整 AI 响应。
- [ ] **SAFE-02（P0）** 不输出 API key、数据库 URL、Telegram token、飞书 secret、chat ID 等 Secret/标识符。
- [ ] **SAFE-03** <code>ingest</code> 中既有审计原始结果仅按当前授权边界保存，不被复制到公开构建产物或通知。
- [ ] **SAFE-04** 缺失和冲突只输出字段路径与分类；数值差异不进入安全摘要。
- [ ] **SAFE-05** 飞书 <code>oc_*</code> 等来源标识仍经过现有脱敏逻辑。
- [ ] **SAFE-06** 新错误对象、审计对象和序列化逻辑不会因 spread 操作意外带出原始 Provider 响应。

### 回执与安全证据记录

| 场景 | Bot 文案摘要 | businessStatus | failureDisposition | 泄露扫描结果 | 证据 |
| --- | --- | --- | --- | --- | --- |
| 主完整 |  |  |  |  |  |
| 备补全 |  |  |  |  |  |
| 仍不完整 |  |  |  |  |  |
| 冲突 |  |  |  |  |  |
| 备未配置 |  |  |  |  |  |

## 8. 自动化测试矩阵

### 8.1 单元测试

- [ ] **TEST-U01（P0）** measurement：主完整不调用备 AI。
- [ ] **TEST-U02（P0）** measurement：主缺 <code>weightKg</code>、备补全，最终完整。
- [ ] **TEST-U03（P0）** measurement：主备都缺 <code>weightKg</code>，最终阻断。
- [ ] **TEST-U04（P0）** measurement：OCR 可见体脂但主缺 <code>bodyFatPct</code>，触发备 AI。
- [ ] **TEST-U05** measurement：OCR 未展示体脂且 <code>bodyFatPct</code> 为空，不因此触发备 AI。

- [ ] **TEST-U06（P0）** workout：有效 activities 完整时不调用备 AI。
- [ ] **TEST-U07（P0）** workout：只有有效 daily summary 且含活动热量时可通过硬完整性。
- [ ] **TEST-U08（P0）** workout：OCR 可见运动消耗但主结果缺失，备 AI 补全。
- [x] **TEST-U09（P0）** workout：<code>normalizeActivities()</code> 保留 <code>durationSeconds/calories/heartRate/distanceKm/avgSpeedKmh</code>。
- [x] **TEST-U10** workout：数组去重后仍保留结构化指标，顺序稳定。

- [ ] **TEST-U11（P0）** nutrition：有 <code>totalCalories</code> 时完整。
- [ ] **TEST-U12（P0）** nutrition：无 total、但 meal calories 可确定求和时完整。
- [ ] **TEST-U13（P0）** nutrition：只有 details 时不完整并触发备 AI。
- [ ] **TEST-U14** nutrition：非法/部分缺失 meal calories 不会被静默当 0 后判完整。

- [ ] **TEST-U15（P0）** sleep：有 total 或 night minutes 时满足硬完整性。
- [ ] **TEST-U16（P0）** sleep：只有 score、没有睡眠分钟数时不完整。
- [ ] **TEST-U17（P0）** sleep：OCR 可见睡眠评分但主缺 score 时触发备 AI。
- [ ] **TEST-U18** sleep：OCR 未展示评分但有有效时长时不因 score 为空触发备 AI。

- [ ] **TEST-U19（P0）** 合并：主有备空、主空备有、双方相同、容差内、容差外五组规则都有测试。
- [ ] **TEST-U20（P0）** 合并后再次门禁，不能因补了一部分字段就直接通过。
- [ ] **TEST-U21（P0）** 技术错误 fallback 的旧测试仍通过。
- [ ] **TEST-U22（P0）** 旧的“business incomplete 不 fallback”测试已改为“必须 fallback”，且失败原因确实来自旧行为。
- [ ] **TEST-U23** fallback Provider 未配置、配置一部分、配置完整三种情况均有测试。
- [ ] **TEST-U24** 安全摘要不含业务值、OCR 原文、Prompt 和完整响应。

### 8.2 集成与回归测试

- [ ] **TEST-I01（P0）** Telegram 从图片识别到 <code>core.*</code> 的主完整路径通过。
- [ ] **TEST-I02（P0）** Telegram 主不完整、备补全路径通过。
- [ ] **TEST-I03（P0）** Telegram 主备仍不完整不写 core，回执正确。
- [ ] **TEST-I04（P0）** 飞书从图片识别到 <code>core.*</code> 的主完整路径通过。
- [ ] **TEST-I05（P0）** 飞书主不完整、备补全路径通过。
- [ ] **TEST-I06（P0）** 飞书主备仍不完整不写 core，回执正确。
- [ ] **TEST-I07（P0）** 缓存命中仍经过门禁；旧不完整缓存触发备 AI。
- [ ] **TEST-I08（P0）** pending replay 走同一门禁和主备逻辑。
- [ ] **TEST-I09（P0）** PostgreSQL 写入测试验证四类成功数据的关键列和两类失败数据的零 core 写入。
- [ ] **TEST-I10** Action summary 五种业务状态及脱敏测试通过。
- [ ] **TEST-I11** 识别评估集至少包含 measurement/workout/nutrition/sleep 四类，以及可见条件字段缺失样本。
- [ ] **TEST-I12** <code>npm run check:core-consistency</code> 通过，并另有专项检查覆盖“行存在但关键列空/默认 0”。

## 9. 必跑命令

> 文档阶段可只校验 Markdown；功能实施完成后的 Go/No-Go 必须执行本节全部命令。每条命令记录退出码和日志位置，不在本文件粘贴含敏感数据的完整日志。

- [ ] **CMD-01** <code>node --test test/ai-schema-validator.test.mjs</code>
- [ ] **CMD-02（P0）** <code>node --test test/ai-recognition-service.test.mjs</code>
- [ ] **CMD-03（P0）** <code>node --test test/telegram-sync.test.mjs</code>
- [ ] **CMD-04** <code>node --test test/telegram-sync-runner.test.mjs</code>
- [ ] **CMD-05（P0）** <code>node --test test/feishu-sync.test.mjs</code>
- [ ] **CMD-06（P0）** <code>node --test test/training-db-core.test.mjs</code>
- [ ] **CMD-07（P0）** <code>node --test test/action-sync-summary.test.mjs</code>
- [ ] **CMD-08（P0）** <code>node --test test/github-workflows.test.mjs</code>
- [ ] **CMD-09（P0）** <code>npm run eval:recognition</code>
- [ ] **CMD-10** <code>npm run check:core-consistency</code>
- [ ] **CMD-11（P0）** <code>npm test</code>
- [ ] **CMD-12（P0）** <code>npm run build</code>
- [ ] **CMD-13（P0）** <code>git diff --check</code>

### 命令证据记录

| 命令 ID | 执行时间 | 退出码 | 通过/失败/跳过 | 日志或 Action 证据 | 备注 |
| --- | --- | ---: | --- | --- | --- |
| CMD-01 |  |  |  |  |  |
| CMD-02 |  |  |  |  |  |
| CMD-03 |  |  |  |  |  |
| CMD-04 |  |  |  |  |  |
| CMD-05 |  |  |  |  |  |
| CMD-06 |  |  |  |  |  |
| CMD-07 |  |  |  |  |  |
| CMD-08 |  |  |  |  |  |
| CMD-09 |  |  |  |  |  |
| CMD-10 |  |  |  |  |  |
| CMD-11 |  |  |  |  |  |
| CMD-12 |  |  |  |  |  |
| CMD-13 |  |  |  |  |  |

## 10. 人工端到端验收用例

| 用例 ID | 输入场景 | 预期 AI 调用 | 预期业务结果 | 预期数据库结果 | 结果/证据 |
| --- | --- | --- | --- | --- | --- |
| E2E-01 | Telegram measurement，主结果完整 | 主 1、备 0 | 成功 | measurement 写入，weight 非空 |  |
| E2E-02 | 飞书 measurement，主缺 weight、备补全 | 主 1、备 1 | 补全后成功 | 只写最终 measurement |  |
| E2E-03 | 主备均缺 weight | 主 1、备 1 | 未完成/未入库 | 该批次 core 0 行 |  |
| E2E-04 | 主备 weight 关键冲突超容差 | 主 1、备 1 | 冲突/人工处理 | 该批次 core 0 行 |  |
| E2E-05 | workout 主结果含五个结构化指标 | 主 1、备 0 | 成功 | 五个 activity 列均保留 |  |
| E2E-06 | OCR 可见运动消耗、主缺 calories、备补全 | 主 1、备 1 | 补全后成功 | calories 非空，training_day 正确 |  |
| E2E-07 | nutrition 仅 details，备给出有效总热量 | 主 1、备 1 | 补全后成功 | intake calories 正确 |  |
| E2E-08 | nutrition 主备都只有 details | 主 1、备 1 | 未完成/未入库 | core meal/training_day 无新增 |  |
| E2E-09 | sleep 有时长，截图未显示评分 | 主 1、备 0 | 成功 | 时长写入，评分可空 |  |
| E2E-10 | sleep OCR 可见评分，主缺 score、备补全 | 主 1、备 1 | 补全后成功 | 时长和评分均正确 |  |
| E2E-11 | 旧不完整缓存命中 | 主按策略、备 1 | 不复用旧成功 | 仅最终完整结果可写 core |  |
| E2E-12 | fallback 三项配置缺一 | 主 1、备 0 | 明确未完成 | core 0 行 |  |
| E2E-13 | pending replay 重放不完整任务 | 按门禁决定 | 与实时同步一致 | 无重复行/半成品 |  |
| E2E-14 | 同一图片重复投递 | 第二次命中/幂等 | 不重复通知成功数据 | core 业务行不重复 |  |

- [ ] **E2E-GATE-01（P0）** E2E-01～E2E-14 全部通过，或跳过项有书面、可接受且不影响本目标的理由。
- [ ] **E2E-GATE-02（P0）** 至少各有一个 Telegram 和飞书真实/脱敏 fixture 走过“主不完整、备补全”路径。
- [ ] **E2E-GATE-03（P0）** 至少有一个主备均不完整样本和一个关键冲突样本，均证明 core 零写入。

## 11. 性能、成本与可观测性

- [ ] **OPS-01（P0）** 主结果完整的正常流量不调用备 AI，调用数量和成本不因本功能无条件翻倍。
- [ ] **OPS-02** fallback 触发次数可从安全审计信息统计，并能区分技术失败与业务不完整。
- [ ] **OPS-03** 可观察主 AI、备 AI、合并、最终门禁各阶段耗时，且不会把两次 AI 耗时误算为一次。
- [ ] **OPS-04** 主备超时配置合理；备用 AI timeout 未短于已知正常响应所需时间，超时后业务状态仍正确。
- [ ] **OPS-05** 并发批次中完整性和合并状态不串批，主备调用日志可通过 task/idempotency key 正确关联。
- [ ] **OPS-06** fallback 激增、冲突率升高或不完整率升高时有可查证信号，不依赖用户先从页面发现缺值。
- [ ] **OPS-07** 识别评估报告记录四类数据的完整率、fallback 触发原因分布和最终阻断数，不记录敏感业务值。

### 性能与可观测性证据

| 指标/场景 | 基线 | 实施后 | 可接受范围/判断 | 证据 |
| --- | ---: | ---: | --- | --- |
| 主完整平均 AI 调用数 |  |  | 必须为 1 |  |
| 业务不完整平均 AI 调用数 |  |  | 预期为 2 |  |
| fallback 技术失败数 |  |  |  |  |
| fallback 业务不完整数 |  |  |  |  |
| 最终不完整/冲突阻断数 |  |  |  |  |

## 12. 回滚、历史数据与文档落地

- [ ] **ROLL-01（P0）** 回滚不会恢复“业务不完整也写 core/回成功”的旧行为；若必须回滚代码，应同时暂停相关自动同步或采用等价安全门禁。
- [ ] **ROLL-02** 本期未通过删除或覆盖方式清理历史识别记录；历史修复使用可审计的重放/重识别路径。
- [ ] **ROLL-03** 已定义如何识别并重放旧的不完整成功记录，范围至少覆盖 weight、body fat、training calories、intake calories、sleep minutes/score。
- [ ] **ROLL-04** 历史回填先在 dev 验证，不把 dev/main 数据和 Secret 混写。
- [ ] **ROLL-05** 重放同一批次不会重复写 core，关键冲突不会覆盖已确认数据。

- [ ] **DOC-01** 实施完成后按 <code>docs/05_日常规则/实施规划落地文档同步规则.md</code> 从实际代码、workflow、SQL 和运行结果反查最终事实。
- [ ] **DOC-02** 主备配置事实更新到 <code>docs/01_系统配置/</code>，只记录变量名称、用途和存在性，不记录 Secret。
- [ ] **DOC-03** 完整性门禁、主备触发、合并、缓存和入库不变量更新到 <code>docs/02_系统核心逻辑/</code>。
- [ ] **DOC-04** 不完整、冲突、fallback 未配置、缓存旧结果等排查方法更新到 <code>docs/04_问题与排查/</code>。
- [ ] **DOC-05** 修正 <code>docs/04_问题与排查/飞书.md</code> 中仍称复用 <code>runTelegramSync</code> 的漂移描述，以实际共享 <code>runMessageSync</code> 为准。
- [ ] **DOC-06** 更新相关 README 导航和 <code>CHANGELOG.md</code>。
- [ ] **DOC-07** 功能验收并同步长期文档后，删除本实施方案和本 Checklist，一次性过程文档不作为第二套长期事实保留。

## 13. 最终 Go / No-Go

### 13.1 P0 阻断条件

出现以下任一情况，必须判定 No-Go：

- [ ] 存在主 AI 业务不完整但未调用已配置备 AI的路径。
- [ ] 存在主结果完整却无条件调用备 AI 的路径。
- [ ] 存在主备均不完整仍写入 <code>core.*</code> 或回复“解析成功/已入库”的路径。
- [ ] 存在主备关键字段冲突后自动二选一并写入 <code>core.*</code> 的路径。
- [ ] 缓存命中可绕过当前完整性门禁。
- [ ] <code>normalizeActivities()</code> 仍会丢失任一结构化训练字段。
- [ ] Telegram、飞书、pending replay 使用了不同完整性合同或任一路径未配置备用 Provider。
- [ ] 关键数据库列缺失仍可能被 <code>training_calories = 0</code> 等默认值伪装为成功。
- [ ] Bot、Action summary 或日志泄露 Secret、图片、完整 OCR、完整 Prompt、完整 AI 响应或敏感业务值。
- [ ] 任一 P0 测试或必跑命令失败。

### 13.2 Go 判定表

| 判定维度 | 通过条件 | 结论 | 证据 |
| --- | --- | --- | --- |
| 完整性合同 | 四类硬字段与可见条件字段测试全部通过 |  |  |
| 主备调用 | 主完整不调备；主不完整调备 |  |  |
| 合并与冲突 | 确定性补空；关键冲突阻断 |  |  |
| 缓存与幂等 | 旧缓存不绕门禁；重放不重复写 |  |  |
| 渠道一致性 | Telegram/飞书/pending replay 一致 |  |  |
| 数据库 | 完整才写 core；失败/冲突零写入 |  |  |
| 状态与安全 | 不伪报成功；无敏感泄露 |  |  |
| 自动化与构建 | CMD-01～CMD-12 满足要求 |  |  |
| 长期文档 | 当前事实已同步，临时文档待验收后删除 |  |  |

### 13.3 最终签署

- [ ] 所有 P0 检查项已通过。
- [ ] 所有失败或跳过项均有记录，且无一影响目标行为。
- [ ] 数据库抽样证明“完整才入库，不完整/冲突零写入”。
- [ ] 用户可见回执与 Action summary 不再把业务不完整显示为成功。
- [ ] 最终结论：**Go**
- [ ] 最终结论：**No-Go**

| 角色 | 姓名/标识 | 结论 | 时间 | 备注 |
| --- | --- | --- | --- | --- |
| 实施核验 |  |  |  |  |
| 代码复核 |  |  |  |  |
| 数据核验 |  |  |  |  |
| 发布判断 |  |  |  |  |
