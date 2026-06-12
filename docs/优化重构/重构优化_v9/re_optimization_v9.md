# 系统重构优化建议（V9）

本文基于 `2026-06-07` 当前 `dev` 分支代码、`docs/` 系统文档、`sql/training_records/` 最新表结构、`CHANGELOG.md` 以及本目录下的专项排查纪要整理。目标是给后续编码提供一份可执行的重构优化建议，而不是直接改变现有业务功能。

本轮最重要的边界：

- 不改变系统现有功能。
- 不改变 Telegram 图片日期归档规则。
- 不改变睡眠截图按“醒来日期减一天”归档的逻辑。
- 不新增大批冗余文件或重复代码。
- 如确需改表结构，只提供增量 SQL，由维护者手动执行。

## 1. 当前系统基线

当前系统以 `TrainingSnapshot` 为统一中间层，数据来源主要有两条：

- `训练记录.md`：人工可读记录、默认页面源、数据库故障时的训练数据回退层。
- PostgreSQL `core.*`：Telegram 自动同步后的主结构化数据层。

主要链路如下：

1. Telegram update 进入 Cloudflare Worker。
2. Worker 触发 GitHub `repository_dispatch`。
3. GitHub Actions 执行 `npm run sync:telegram`。
4. `tools/telegram-sync.mjs` 读取 update、分组、识别图片、处理命令。
5. `tools/telegram-sync-lib.mjs` 做日期归档、批次归一、Markdown 增量合并。
6. `src/ai/recognition-service.mjs` 调用 AI 并做 schema 校验。
7. `src/db/training/write.mjs` 写入 `ingest.*` 和 `core.*`。
8. 页面构建从 Markdown 或数据库生成 `source/_data/*.json`，再由 Hexo 生成静态站点。

当前最新数据库结构分三层：

| 层级 | 主要表 | 职责 |
| --- | --- | --- |
| `ingest` | `telegram_batch`、`telegram_message`、`telegram_recognition`、`telegram_pending_batch` | Telegram 批次、消息、识别结果和待重试队列 |
| `core` | `training_day`、`measurement`、`activity`、`meal`、`sleep`、`thought` | 页面、分析和 MCP 查询使用的主业务数据 |
| `archive` | `training_parse_snapshot`、`training_day`、`training_activity`、`training_measurement`、`training_meal`、`training_sleep` | 构建快照归档、运行留痕和历史回填来源 |

## 2. 必须保持不变的业务逻辑

### 2.1 普通图片日期归档

普通锻炼、体脂秤、饮食图片继续使用当前优先级：

1. 图片画面内可靠日期。
2. Telegram 原始文件名日期。
3. 都没有可靠日期则跳过。

同一个相册或 batch 中：

- 只有一个可靠图片日期时，无日期图片继承该日期。
- 多个图片日期冲突时，整批跳过。
- 没有图片日期但文件名日期唯一时，可使用文件名日期。
- 文件名日期冲突时，整批跳过。

不得改成使用 caption、发送时间、当前日期或 GitHub Actions 运行时间猜测归档日。

### 2.2 睡眠图片日期归档

睡眠图片继续使用 `resolveSleepArchiveDate()` 的语义：

1. 优先从 `records.sleep.wakeTime` 提取醒来日期。
2. 如果 `wakeTime` 只有月日，可结合 Telegram 消息年份补全年份。
3. `wakeTime` 没有日期时，才使用 `detectedDate`。
4. 得到醒来日期后减一天，作为 `archivedDate`。
5. 只有纯时间且没有可靠日期时跳过。

这个逻辑不能为了提速而改变。后续所有增量入库、Markdown 合并、测试和通知都必须继续围绕这个归档口径工作。

## 3. 当前主要问题

### 3.1 Telegram 正常成功路径仍可能触发全量 Markdown 重建

当前 `runTelegramSync()` 在图片批次 `ready + stored` 后，会根据情况从数据库构建 snapshot，再调用 `exportTrainingMarkdown(snapshot)` 覆盖 `训练记录.md`。如果数据库 snapshot 不完整，则回退为 `applyTelegramSyncToMarkdown()` 按批次合并。

这个设计保证了数据库和 Markdown 可见层尽量同步，但也带来两个问题：

- 每次图片成功入库后，都可能把“整份数据库快照 -> 整份 Markdown”作为主路径。
- 如果全量导出能力落后于增量 Markdown 渲染能力，可能静默删除已有可见内容。

本目录现有排查纪要已观察到：睡眠批次 `stored` 后，`训练记录.md` 未稳定出现睡眠段落；另一次 sleep 补回导致饮食 `餐次明细` 被删除。

### 3.2 `persistNormalizedBatch()` 仍按整日替换写 core

当前 `persistNormalizedBatch()` 的训练图片写库路径是：

1. 查询同一 `batch_id` 的 `payload_hash`，相同则 `unchanged`。
2. upsert `ingest.telegram_batch/message/recognition`。
3. 读取当前 `archivedDate` 的已有 core day。
4. `mergeBatchIntoDay(existingDay, batch)` 合并本批次数据。
5. `replaceCoreDay()` 删除该日 `core.measurement/activity/meal/sleep`。
6. upsert `core.training_day`。
7. 重新批量插入该日 measurement、activity、meal、sleep。

这个策略对 Markdown 导入、历史回填和整日对账是合理的，因为这些入口天然以“某天完整快照”为输入。但 Telegram 图片正常成功路径的输入通常只是 1-4 张增量截图，继续整日删除重建会带来不必要的数据库往返和写入成本。

### 3.3 Markdown 导出能力和 Markdown 增量渲染能力不一致

当前 `applyTelegramSyncToMarkdown()` 的增量渲染路径已经支持 sleep block，而 `src/domain/training/training-exporter.mjs` 的全量导出更偏 measurement、workout、nutrition，缺少 sleep 段落渲染。同时 nutrition details 也存在被全量导出遗漏的风险。

结果是：

- 数据库里可能已有 `core.sleep` 或 `archive.training_sleep`。
- 页面快照或 dashboard 可能能读到部分睡眠数据。
- `训练记录.md` 却没有对应睡眠段落。
- 或已有 `餐次明细` 在全量导出后被删掉。

这会破坏人工可读账本的可信度。

### 3.4 workflow 绿灯容易掩盖部分失败

当前报告已经有 `partialFailure`、`queued`、`resolved`、`failedImageCount`、`recognitionPendingStatus` 等字段，但 GitHub Actions 的 step 名称仍偏“success”。维护者如果只看 workflow 绿灯，容易误判为“完全成功”。

实际需要区分：

- 全部识别成功且已入库。
- 部分识别成功、成功部分已入库、失败图片已进入 pending。
- 整批识别失败但已 queued。
- pending replay 成功 resolved。
- 用户输入导致 skipped。

### 3.5 构建与部署噪音偏多

当前 dev/main Telegram Sync 与 shared `site-build` 仍有一些可收敛点：

- Telegram Sync job 先 `npm ci`，进入 shared `site-build` 后再次 `npm ci`。
- dev Pages deploy 每次通过 Wrangler action 动态安装指定版本，日志噪音较大。
- `wrangler.toml` 缺少 Pages 输出目录配置，会有 warning。
- GitHub Actions 生态提示 Node 20 action deprecation，需要提前关注 action 版本升级。

这些不是当前最高风险 bug，但会增加排查成本。

### 3.6 大代码文件维护成本偏高

当前仓库中存在一些行数较多、职责较集中的代码文件。它们不是立即故障点，但会增加后续迭代成本，尤其是多人修改、定位测试失败、抽取复用逻辑时会更费劲。

本轮静态观察到的典型大文件包括：

| 文件 | 当前行数级别 | 主要风险 |
| --- | --- | --- |
| `test/telegram-sync-runner.test.mjs` | 5000+ | 用例很多，失败定位和分组维护成本高 |
| `test/telegram-sync.test.mjs` | 3000+ | 日期、批次、Markdown 合并等测试混在一起 |
| `tools/telegram-sync-lib.mjs` | 2000+ | Telegram 分组、日期归档、Markdown 渲染、报告辅助逻辑耦合 |
| `src/db/training/write.mjs` | 2000+ | ingest/core/archive 写入、回填、合并、SQL 构造职责集中 |
| `test/training-db-core.test.mjs` | 1800+ | DB 写入、回填、导出和异常路径测试集中 |
| `tools/telegram-sync.mjs` | 1800+ | 同步编排、识别、fallback、通知、pending replay 逻辑集中 |
| `src/mcp/tools.mjs` | 1000+ | MCP tool 定义和查询/分析适配逻辑集中 |

大文件治理不能机械按行数切块。拆分目标是降低维护成本，不改变现有功能，也不制造大量薄包装文件。建议触发条件是：

- 单文件超过约 1000 行。
- 一个文件承担超过 3 类稳定职责。
- 单测失败时很难快速定位到功能区域。
- 后续多人维护时容易在同一文件产生冲突。

拆分必须按职责边界进行，例如 Telegram 分组、日期归档、Markdown 渲染、通知报告、DB 写入、archive 回填、MCP tool 定义等，而不是简单按前后行号切分。

## 4. V9 总体优化方向

V9 不建议大改业务功能，也不建议重建整套任务系统。推荐采用“局部增量化 + 导出一致性修复 + workflow 可观测性收敛 + 大文件按职责拆分”的策略。

大文件治理的原则是：生产核心大文件优先于测试大文件，职责拆分优先于行数拆分，保留原有 facade/barrel 入口优先于大范围修改 import。

优先级如下：

| 优先级 | 主题 | 目标 |
| --- | --- | --- |
| P0 | Telegram 图片增量持久化和 Markdown 可见性修复 | 提速并避免全量导出删内容 |
| P1 | workflow 状态表达、构建降噪、生产核心大文件拆分 | 降低维护误判、日志噪音和核心文件修改成本 |
| P2 | 审计增强、测试大文件治理和长期分层收敛 | 为后续迭代留出更清晰的扩展面 |

## 5. P0：Telegram 图片增量持久化优先

### 5.1 目标

让 Telegram 图片正常成功路径只写本批次增量数据和对应日期汇总，不再把整份 Markdown 或整日替换作为主写入方式。

注意：这里说的“增量”不是改日期归档规则，也不是改识别结果；只是改变数据库持久化策略。

### 5.2 建议实现思路

保留现有 `persistNormalizedBatch()` 入口兼容性，但内部按入口分流：

- Telegram 图片批次：走新的增量写入路径。
- Markdown 导入、archive 回填、手工对账：继续允许整日替换。
- 随想批次：保持 `core.thought` mirror 逻辑不变。
- 数据库失败：继续 fallback 到 `applyTelegramSyncToMarkdown()` 和 pending 队列。

建议新增内部函数，名称可按实际代码风格调整：

- `persistTelegramImageBatchIncremental(client, batch, payloadHash, processedAt)`
- `upsertCoreMeasurementsForBatch(client, batch, processedAt)`
- `upsertCoreActivitiesForBatch(client, batch, processedAt)`
- `upsertCoreMealsForBatch(client, batch, processedAt)`
- `upsertCoreSleepForBatch(client, batch, processedAt)`
- `refreshCoreTrainingDaySummary(client, archivedDate, sourceContext, processedAt)`

这些函数应放在现有 DB 写入模块内或其相邻子模块中，不建议新开大量薄包装文件。

### 5.3 子表增量写入规则

`core.measurement/activity/meal/sleep` 继续使用现有 key 生成规则，避免改变幂等语义：

- `measurement_key`：按日期、测量时间、体重等字段生成。
- `activity_key`：按日期、活动时间、类型、详情等字段生成。
- `meal_key`：按日期、餐次名、热量等字段生成。
- `sleep_key`：按日期、睡眠类型、入睡时间、醒来时间、总睡眠分钟数生成。

增量写入使用 upsert：

- 同 key 已存在时更新字段和 `updated_at`。
- 同 key 不存在时插入。
- 本批次没有包含的模块不删除既有数据。

这可以保留“同日补发一张饮食图不删除已有运动/睡眠/体脂”的现有功能要求。

### 5.4 日级汇总更新规则

`core.training_day` 不再依赖“先构造完整 day 再整日替换”。Telegram 图片增量写入完成后，只重算当前 `archivedDate` 的汇总字段：

- `total_activities`：来自 `core.activity` 当日行数。
- `total_duration_seconds`：来自 `core.activity.duration_seconds` 汇总。
- `training_calories`：优先保留本批次 workout summary 或按现有汇总策略计算。
- `workout_duration_minutes`：来自本批次 summary 或活动时长汇总。
- `active_hours`：来自 workout summary。
- `cycling_distance_km`：来自 `core.activity.distance_km` 汇总。
- `intake_calories`：来自本批次 nutrition total 或 `core.meal` 汇总兜底，沿用现有语义。
- `nutrition_details_json`：有本批次 nutrition details 时更新；没有时保留既有 details。
- 睡眠汇总字段：有本批次 sleep 时更新；没有时保留既有 sleep 汇总或从 `core.sleep` 聚合。

实现时要特别注意：不能因为本批次是 sleep，就把当天饮食 details 清空；不能因为本批次是 nutrition，就把 sleep 汇总清空。

### 5.5 `ingest.*` 继续作为审计层

`ingest.telegram_batch/message/recognition` 的写入应保持在事务中，并继续先于 core 写入：

- `payload_hash` 继续用于同 batch 幂等判断。
- 相同 batch hash 返回 `unchanged`。
- `batch_payload_json` 保留完整 batch，包括计数、日期来源、pending/replay 元数据。
- 在没有新增 SQL 的情况下，所有新增审计信息都先放在 `batch_payload_json` 中。

### 5.6 archive 写入策略

当前 Telegram 图片写入路径会通过 `replaceCoreDay()` 顺带写 `archive.training_parse_snapshot` 和 `archive.training_sleep`。改成增量写入后，建议短期先保持 archive 语义保守：

- `ingest.*` 是 Telegram 图片首要审计事实源。
- `core.*` 是页面和分析主数据。
- `archive.*` 主要继续服务于构建快照归档和历史回填。

如果必须继续将 Telegram sleep 同步到 `archive.training_sleep`，只对本批次 sleep rows 做 upsert，不触发整日 archive snapshot 重写。

### 5.7 验收标准

P0 增量入库完成后，应满足：

- 单张 sleep 图 `ready + stored` 后，`core.sleep` 有记录，`core.training_day` 睡眠汇总更新。
- 同日补发 sleep 不删除已有 measurement/activity/meal。
- 同日补发 nutrition 不删除已有 sleep。
- 同日补发 measurement 不删除已有 nutrition details。
- 相同 batch 重放返回 `unchanged`。
- 数据库失败仍 fallback 写 `训练记录.md`，并进入 pending 队列。
- 日期归档测试不变。

## 6. P0：Markdown 导出一致性修复

### 6.1 目标

让全量导出 `exportTrainingMarkdown(snapshot)` 与增量渲染 `applyTelegramSyncToMarkdown()` 对核心可见字段保持一致，避免数据库里已有数据但人工账本不可见，或导出时删掉已有字段。

### 6.2 必须补齐的导出字段

`exportTrainingMarkdown()` 至少应补齐：

- `#### 当日睡眠截图记录`
- 睡眠类型
- 入睡时间、起床时间
- 总睡眠、夜间睡眠、午睡
- 深睡、浅睡、REM、清醒
- 睡眠评分、超过用户百分比
- 深睡比例、浅睡比例、REM 比例
- 深睡连续性、清醒次数、呼吸质量
- 平均心率、HRV、平均血氧、平均呼吸率
- 睡眠阶段摘要和阶段明细
- 睡眠解读和建议
- 饮食 `nutrition.details` 的 `##### 餐次明细`

字段名称应尽量复用 `applyTelegramSyncToMarkdown()` 当前渲染口径，避免 parser 和 exporter 使用两套不同标题。

### 6.3 导出与解析的闭环

补齐 exporter 后，应验证：

1. 数据库 snapshot 导出 Markdown。
2. `parseTrainingRecord()` 再解析导出的 Markdown。
3. 关键字段仍存在。

特别要覆盖：

- sleep health metrics。
- sleep stage detail。
- nutrition details。
- 只有 sleep 没有训练/饮食的日期。
- 只有 nutrition details 没有餐次明细以外内容的日期。

### 6.4 Telegram 成功路径对 Markdown 的建议

Telegram 正常成功写库后，不建议每次都全量覆盖 `训练记录.md`。更稳妥的策略：

- 数据库写入成功：以数据库和站点数据为主，不强制全量导出 Markdown。
- 需要保持人工账本可见时：只对本批次调用 `applyTelegramSyncToMarkdown()` 做目标日期增量合并。
- 数据库失败：继续使用 `applyTelegramSyncToMarkdown()` 作为 fallback，并写 pending。
- 手工触发 `export:markdown` 或非 dispatch 维护路径：允许全量导出，但必须通过 exporter 一致性测试。

这样既能提速，也能减少全量导出对既有内容的破坏。

## 7. P1：workflow 状态与构建降噪

### 7.1 通知 step 命名

建议将：

- `Notify Telegram sync success`

改成更中性的名称，例如：

- `Notify Telegram sync result`

原因是 workflow 成功不等于业务完全成功。`partialFailure`、`queued retry`、`resolved replay` 都可能发生在绿色 workflow 内。

### 7.2 job summary

建议在 Telegram Sync workflow 中输出 GitHub Actions summary，内容包括：

- batchId
- taskStatus
- persistenceStatus
- archivedDate
- sourceImageCount / recognizedImageCount / failedImageCount
- recognitionPendingStatus
- failureDisposition
- failed messageIds

这样维护者不需要展开 JSON 日志也能判断本次是否完整成功。

### 7.3 避免重复安装依赖

当前 Telegram Sync job 已经执行 `npm ci`，随后 shared `site-build` 也执行 `npm ci`。建议后续在 shared action 中增加输入，例如：

- `install_dependencies: true|false`

Telegram Sync 已安装依赖时传 `false`。普通 deploy workflow 仍保持 `true`。

### 7.4 Wrangler 与 Pages warning

建议后续处理：

- 固定 Wrangler 版本或通过已有 action cache 减少动态安装噪音。
- 在适当配置中补齐 Pages 输出目录，避免部署 warning。
- 关注 GitHub Actions action 版本升级，提前处理 Node deprecation 提示。

这些属于维护体验优化，不应和 P0 数据写入修复混在同一个大改里。

## 8. P1/P2：大代码文件拆分治理

### 8.1 拆分目标

大文件拆分的目标是让后续维护更容易，而不是追求文件数量变多。拆分后应满足：

- 原有功能和外部导入入口不变。
- 每个新文件有明确职责，不产生只有转发作用的冗余文件。
- 高风险逻辑拆分后仍由 targeted tests 锁住行为。
- 生产核心文件优先治理，测试大文件在业务拆分稳定后分批整理。

### 8.2 高优先级候选

高优先级文件影响 Telegram 入库、日期归档、fallback 或数据库事务，建议随 P0/P1 实现同步治理。

| 文件 | 建议拆分方向 | 保留边界 |
| --- | --- | --- |
| `src/db/training/write.mjs` | 拆出 Telegram 图片增量写入、core 子表 upsert、单日汇总刷新、archive sleep 写入/回填 | 保留 `src/db/training/write.mjs` 对外导出，避免调用方大范围改 import |
| `tools/telegram-sync-lib.mjs` | 拆出 update 分组、日期归档、Markdown section 渲染、batch report 辅助 | `analyzeTelegramBatch()`、`applyTelegramSyncToMarkdown()` 的行为和导出名保持兼容 |
| `tools/telegram-sync.mjs` | 拆出同步编排步骤、pending replay、fallback Markdown、通知/结果持久化 | `runTelegramSync()` 和 CLI 入口保持兼容 |

### 8.3 中优先级候选

中优先级文件影响查询、分析或读取维护性，但不是本轮 Telegram 入库提速的 P0 瓶颈。

| 文件 | 建议拆分方向 | 保留边界 |
| --- | --- | --- |
| `src/mcp/tools.mjs` | 按 tool 主题拆为训练快照、每日记录、分析、配置/状态等模块 | MCP tool 名称、参数和返回结构不变 |
| `tools/training-analysis.mjs` | 拆出 intent 解析、上下文构造、回复生成、Telegram 分段发送 | `/分析` 命令行为不变 |
| `src/db/training/read.mjs` | 拆出 core 读取、archive 读取、row 到 snapshot 映射 | `readTrainingSnapshotFromDatabase*` 导出兼容 |

### 8.4 低优先级候选

低优先级主要是超大测试文件。它们会影响维护体验，但建议在生产核心拆分稳定后再做，避免一边改业务逻辑一边大规模搬测试。

| 文件 | 建议拆分方向 | 保留边界 |
| --- | --- | --- |
| `test/telegram-sync-runner.test.mjs` | 按 ready stored、fallback、pending replay、通知、命令类批次分组 | 用例语义不变，优先抽共享 fixture |
| `test/telegram-sync.test.mjs` | 按日期归档、Markdown 合并、图片计数、partial failure 分组 | 日期归档测试必须保持完整 |
| `test/training-db-core.test.mjs` | 按 persist、import/export、backfill、sleep 分组 | DB 写入事务和 rollback 用例不丢 |

### 8.5 拆分安全规则

- 先拆纯函数和低副作用辅助逻辑，再拆事务和 workflow 编排。
- 每次拆分只处理一个职责区域，避免一次 PR 同时拆 Telegram、DB、MCP 和测试。
- 原文件可作为 facade/barrel 暂时保留，对外导出保持兼容。
- 拆分前后运行对应 targeted tests，确认不是“文件变小、行为变了”。
- 不为追求行数目标创建大量只有一两个函数的碎片文件。

## 9. P2：审计增强与 SQL 建议

本轮不强制修改 `core.*` 主表结构。当前 `core.*` 足够承载页面和分析数据，盲目加字段会增加迁移成本。

如果后续需要增强审计，可新增一个增量 SQL 文件，例如：

```text
sql/training_records/telegram_incremental_audit.sql
```

建议只在 `ingest` 层加可选字段或索引，例如：

- `ingest.telegram_batch.source_image_count`
- `ingest.telegram_batch.recognized_image_count`
- `ingest.telegram_batch.failed_image_count`
- `ingest.telegram_batch.task_status`
- `ingest.telegram_batch.failure_disposition`
- `ingest.telegram_message.source_type`
- `ingest.telegram_recognition.status`
- `ingest.telegram_recognition.error_json`

但要遵守两条规则：

- 未执行该 SQL 时，代码仍必须通过 `batch_payload_json` 正常工作。
- 新字段只做审计加速，不参与核心功能判断。

如果只是为了本轮增量入库提速，优先不加 SQL。

## 10. 推荐实施顺序

### 阶段 1：先修可见性和导出一致性

先补齐 `exportTrainingMarkdown()` 的 sleep 和 nutrition details 渲染，并补测试。这一步风险较低，可以直接解决“数据库有数据但 Markdown 看不到”和“导出删除餐次明细”的问题。

### 阶段 2：实现 Telegram 图片增量持久化

在 `src/db/training/write.mjs` 内部引入 Telegram 图片增量写入路径，保持外部入口不变。先针对 measurement/activity/meal/sleep 子表 upsert，再做 `core.training_day` 单日汇总刷新。

### 阶段 3：收敛 Telegram 成功后 Markdown 写入策略

调整 `runTelegramSync()` 中成功写库后的 Markdown 重建策略：

- 默认不再每次全量导出。
- 如需写人工账本，只对 ready stored batch 做目标日期增量合并。
- 保留数据库 snapshot 构建用于站点，而不是用于每次覆盖 Markdown。

### 阶段 4：workflow 降噪

单独处理通知命名、summary、重复 `npm ci`、Wrangler warning 等问题，避免和数据写入改动互相影响。

### 阶段 5：生产核心大文件拆分

结合 P0/P1 的实际改动，优先治理 `src/db/training/write.mjs`、`tools/telegram-sync-lib.mjs` 和 `tools/telegram-sync.mjs`。每次只拆一个职责区域，并保留原导出入口。

### 阶段 6：可选审计 SQL

如果后续排查仍觉得 JSON 不够直观，再新增 `telegram_incremental_audit.sql`，并让代码在字段不存在时继续兼容。

### 阶段 7：测试大文件分批整理

生产逻辑稳定后，再按用例主题整理 `test/telegram-sync-runner.test.mjs`、`test/telegram-sync.test.mjs` 和 `test/training-db-core.test.mjs`。优先抽共享 fixture 和 helper，不急于一次拆完。

## 11. 回归测试建议

后续实现时建议至少覆盖：

```bash
node --test test/telegram-sync.test.mjs test/telegram-sync-runner.test.mjs
node --test test/training-db-core.test.mjs test/reconcile-training-markdown-to-core.test.mjs
node --test test/export-training-markdown.test.mjs test/training-parser.test.mjs
npm run test:fast
```

关键场景：

- 单张睡眠图入库，归档到醒来日期前一天。
- 睡眠图只有纯时间时跳过。
- 1-4 张相册中唯一日期图片带无日期图入库。
- 多日期冲突整批跳过。
- 同日补发 nutrition 不删除 sleep。
- 同日补发 sleep 不删除 nutrition details。
- `partialFailure` 成功部分先入库，失败图片进入 pending。
- pending replay 成功后 resolved。
- 数据库写入失败时 fallback Markdown。
- `exportTrainingMarkdown()` 导出后 parser 能读回 sleep 和 nutrition details。
- 大文件拆分后原 facade/barrel 导出仍可用，相关 targeted tests 通过。

## 12. 风险与回滚

### 12.1 主要风险

- 增量写入如果汇总刷新不完整，可能导致 `core.training_day` 与子表不一致。
- 如果 key 生成规则改变，可能导致历史数据重复或覆盖异常。
- Telegram 成功后不再全量导出 Markdown，可能改变人工账本更新频率，需要明确“数据库为成功路径主事实源”。
- workflow summary 增强如果输出过多，可能增加日志噪音。
- 大文件拆分如果同时改变职责和行为，可能让回归失败难以定位。

### 12.2 回滚策略

- 保留 `persistNormalizedBatch()` 外部入口不变。
- 增量路径可通过内部开关或小范围函数替换回 `mergeBatchIntoDay + replaceCoreDay`。
- `applyTelegramSyncToMarkdown()` fallback 不删除。
- `export:markdown` 仍可作为人工修复工具，但必须通过一致性测试后使用。
- 大文件拆分时保留原 facade/barrel 文件；如果新模块出问题，可先把导出指回原实现再修分层。

## 13. 最终建议

V9 的重构重点不是新增功能，而是让现有功能跑得更轻、更稳、更容易维护。

最推荐先做四件事：

1. 补齐 `exportTrainingMarkdown()` 的 sleep 和 nutrition details，避免全量导出删内容。
2. 将 Telegram 图片正常成功路径改为增量 upsert 和单日汇总刷新，避免每次依赖整日替换或整份 Markdown 重建。
3. 调整 workflow 状态表达，让 partial failure、queued retry、resolved replay 不再被绿色 workflow 误读成“完全无异常”。
4. 对生产核心大文件按职责拆分，优先降低 Telegram 同步和 DB 写入的维护成本。

完成这些后，系统功能口径保持不变，但后续迭代会更容易：图片入库更快、人工账本更可靠、数据库写入边界更清晰、Action 日志也更适合排查。
