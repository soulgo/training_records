# Telegram 睡眠识别与入库说明

本文档说明 Telegram 睡眠截图从 AI 识别、批次归档、PostgreSQL 入库、pending replay 到页面读取的完整链路，便于后续维护和排查问题。

## 1. 当前能力边界

当前睡眠截图作为 Telegram 图片识别的一种 `imageType=sleep` 处理，和锻炼、体脂秤、饮食截图共用同一批次链路。

稳定支持的睡眠字段：

- 入睡时间、起床时间。
- 总睡眠、夜间睡眠、午睡、深睡、浅睡、REM、清醒分钟数。
- 睡眠阶段文本和可见的阶段明细。
- 睡眠评分、超过用户百分比、深睡/浅睡/REM 比例、深睡连续性、清醒次数、呼吸质量。
- 平均心率、HRV、平均血氧、平均呼吸率。
- 截图中已有的睡眠解读和睡眠建议。

当前主流程以夜间睡眠为主。如果截图明确是午睡或小睡，`sleepType` 可以写 `午睡`；否则默认按 `夜间睡眠` 处理。

## 2. 识别层口径

睡眠图片识别规则维护在：

- `prompts/_source/recognition-rules.json`
- `prompts/_source/app-profiles.json`
- 生成产物 `prompts/telegram-training-image-recognition.md`

schema 事实源是：

- `tools/telegram-recognition-schema.mjs` 的 `buildRecognitionSchema()`

关键约束：

- `imageType` 使用 `sleep`。
- 顶层 `detectedApp` 记录截图来源 APP；无法可靠识别时填 `null`。
- 不同 APP 的睡眠标签、时间位置和单位优先通过 `app-profiles.json` 映射到现有 `records.sleep` 字段。
- `records.sleep` 是睡眠字段唯一载体，不要把睡眠内容写进运动、饮食或体脂字段。
- `records.sleep` 必须包含 schema 中的全部字段；画面不可见时填 `null`。
- `totalSleepMinutes` 和 `nightSleepMinutes` 是同一条 `records.sleep` 的两个字段，不是两条记录；不要把二者相加。
- 如果截图同时显示总睡眠和夜间睡眠，总睡眠写入 `totalSleepMinutes`，夜间睡眠写入 `nightSleepMinutes`；除非画面明确列出单独午睡条目，否则仍然只输出一条 `records.sleep`。
- `bedtime`、`wakeTime` 写截图中真实可见的入睡/起床时间，不要为了归档日期改写。
- 深睡、浅睡、REM、清醒、阶段占比和睡眠健康指标都必须写在同一个 `records.sleep` 中，不要拆到第二条记录或只保留总时长。
- `sleepStageDetail` 只保留画面明确可见的信息，不补全推断。
- `analysisText` 写截图底部已有的睡眠解读，`suggestionText` 写截图底部已有的睡眠建议，不让模型生成新建议。
- 遇到跨天、多个日期或日期冲突时，宁可让 `detectedDate` 为 `null`。

## 3. 睡眠归档日期

睡眠截图的归档日期和普通训练图不同。

程序侧实现位于 `tools/telegram-sync-lib.mjs` 的 `resolveSleepArchiveDate()`：

1. 优先从 `records.sleep.wakeTime` 提取醒来日期。
2. 如果 `wakeTime` 中只有 `M/D`，会结合 Telegram 消息年份补全年份。
3. 如果 `wakeTime` 没有可用日期，再使用截图识别出的 `detectedDate`。
4. 最终把醒来日期减一天，作为 `archivedDate`。
5. 如果以上都无法得到可靠日期，睡眠批次会跳过，不凭当前日期猜测。

例子：

| 截图可见信息 | 归档结果 |
| --- | --- |
| `wakeTime=2026-06-05 06:40` | `archivedDate=2026-06-04` |
| `wakeTime=6/5 06:40`，Telegram 消息年份为 2026 | `archivedDate=2026-06-04` |
| `detectedDate=2026-06-05`，`wakeTime` 无日期 | `archivedDate=2026-06-04` |
| 只有 `06:40`，无截图日期 | 跳过，避免错归档 |

`dateSources` 中如果看到 `source=sleep_bedtime`，表示睡眠归档日来自睡眠时间语义换算，不是普通图片日期直接归档。

## 4. 同步与回退链路

Telegram 睡眠图进入同一条图片同步链路：

1. `tools/telegram-sync.mjs` 调度同步。
2. `tools/telegram-sync-lib.mjs` 对 Telegram update 分组，单图和相册都会变成图片 batch。
3. `src/ai/recognition-service.mjs` 调用 AI provider 识别图片，并通过 schema 校验。
4. `analyzeTelegramBatch()` 汇总 `records.sleep`，生成 `batchResult.sleep`。
5. `status=ready` 的批次优先写 PostgreSQL；正常成功路径只增量 upsert 当前 sleep 明细并刷新目标 `core.training_day` 睡眠汇总。
6. 成功路径不会写 `训练记录.md`；Markdown 由 DB -> Markdown 备份 workflow 定期导出。
7. 数据库写入失败时，不写 `训练记录.md` 兜底；批次进入 pending 队列，等待数据库恢复后重放。
8. 页面构建读取数据库快照；严格数据库模式下，数据库快照不可用或不完整会阻止发布旧 Markdown 页面。

睡眠记录在同步结果中会汇总为：

- `sleep.records`
- `sleep.totalSleepMinutes`
- `sleep.nightSleepMinutes`
- `sleep.napMinutes`
- `sleep.sleepStartTime`
- `sleep.sleepEndTime`
- `sleep.deepSleepMinutes`
- `sleep.lightSleepMinutes`
- `sleep.remSleepMinutes`
- `sleep.awakeMinutes`
- `sleep.sleepScore`
- `sleep.averageHeartRateBpm`
- `sleep.hrvMs`
- `sleep.averageSpo2Pct`
- `sleep.averageRespiratoryRate`

## 5. 数据库落表

睡眠结果会写入两层表：

| 表 | 职责 |
| --- | --- |
| `core.sleep` | 页面和分析读取的主睡眠明细 |
| `core.training_day` | 日级睡眠汇总字段 |
| `archive.training_sleep` | 构建快照归档中的睡眠明细 |
| `archive.training_day` | 归档日级睡眠汇总字段 |

主要字段包括：

- `sleep_type`
- `bedtime`
- `wake_time`
- `night_sleep_minutes`
- `total_sleep_minutes`
- `nap_minutes`
- `deep_sleep_minutes`
- `light_sleep_minutes`
- `rem_sleep_minutes`
- `awake_minutes`
- `sleep_stage_text`
- `sleep_stage_detail`
- `sleep_score`
- `sleep_score_percentile`
- `deep_sleep_ratio_pct`
- `light_sleep_ratio_pct`
- `rem_sleep_ratio_pct`
- `deep_sleep_continuity_score`
- `wake_count`
- `breathing_quality_score`
- `average_heart_rate_bpm`
- `hrv_ms`
- `average_spo2_pct`
- `average_respiratory_rate`
- `analysis_text`
- `suggestion_text`

幂等策略：

- `core.sleep` 使用 `sleep_key` 去重。
- 同一天重复同步时，Telegram 图片路径只 upsert 本批次 sleep row 并刷新目标 `core.training_day`，不会整日删除重建其它模块。
- Telegram sleep 正常同步不写 `archive.training_sleep`；该表保留给历史归档和回填维护。
- archive-only 睡眠记录可通过回填链路补写 `core.sleep`。
- 页面和分析读取睡眠卡片时，`core.sleep` 明细是优先来源；只有在 `core.sleep` 没有对应记录时，才使用 `core.training_day` 睡眠汇总兜底，避免明细和日汇总重复叠加。

## 6. SQL 与迁移

新环境优先使用完整初始化脚本：

```bash
psql "$TRAINING_DB_URL" -f sql/pgsql17.sql
```

已有环境如果缺少睡眠健康指标，使用增量脚本：

```bash
psql "$TRAINING_DB_URL" -f sql/training_records/sleep_health_metrics.sql
```

历史拆分 schema 文件：

- `sql/training_records/core.sql`
- `sql/training_records/core_sleep.sql`
- `sql/training_records/archive.sql`
- `sql/training_records/sleep_health_metrics.sql`

## 7. 维护与排查顺序

当你遇到“Telegram 已发送睡眠图，但页面没有数据”时，建议按这个顺序查：

1. 看 Telegram 回复或 workflow JSON，确认批次是否 `status=ready`。
2. 看 `imageType` 是否为 `sleep`，以及 `records.sleep` 是否存在。
3. 看 `confidence`、`warnings`、`issues` 是否提示低置信、无日期或 schema 错误。
4. 看 `archivedDate` 是否为空；如果为空，优先检查截图里是否有醒来日期或完整日期范围。
5. 看 `dateSources` 是否包含 `sleep_bedtime`，确认是否按醒来日期减一天归档。
6. 查 `core.sleep` 是否有对应 `archived_date`。
7. 查 `core.training_day` 的睡眠汇总字段是否更新。
8. 看 GitHub Actions summary 的 `taskStatus`、`persistenceStatus`、`failureDisposition` 和 failed message ids，确认是已入库、自动重试还是需要重新发送。
9. 如果数据库写入失败，看 `runtime/telegram-sync-pending.ndjson` 是否等待重放。
10. 如果数据库有数据但页面不显示，运行 `npm run build:data`，检查 `训练数据解析.md` 和 `source/_data/dashboardView.json`。

如果页面睡眠卡片显示“待比较”，但 Telegram Sync action 已显示 `persistenceStatus=stored`，优先确认 `source/_data/dashboardView.json` 或构建产物中的睡眠分钟数是否来自 `core.sleep`。如果看到总睡眠等于“总睡眠 + 夜间睡眠”的异常值，说明读模型或 prompt 口径发生回退，需要检查 `readTrainingSnapshotFromDatabaseClient` 的睡眠来源选择和 `prompts/_source/recognition-rules.json` 的 sleep 规则。

## 8. 相关文件

- `prompts/_source/recognition-rules.json`
- `prompts/_source/app-profiles.json`
- `prompts/telegram-training-image-recognition.md`
- `tools/telegram-recognition-schema.mjs`
- `tools/telegram-sync-lib.mjs`
- `tools/telegram-sync-dates.mjs`
- `tools/telegram-sync-markdown.mjs`
- `tools/telegram-sync-status.mjs`
- `src/ai/recognition-service.mjs`
- `src/db/training/write.mjs`
- `src/db/training/read.mjs`
- `src/db/training/archive.mjs`
- `sql/pgsql17.sql`
- `sql/training_records/sleep_health_metrics.sql`
- `docs/训练系统/Telegram图片日期归档.md`

## 9. 推荐验证命令

只改 prompt 或识别口径：

```bash
node tools/prompt-generator.mjs
node --test test/prompt-generator.test.mjs test/telegram-sync.test.mjs test/telegram-sync-runner.test.mjs
```

涉及数据库写入、读取或回填：

```bash
node --test test/training-db-core.test.mjs test/training-db-archive.test.mjs test/training-snapshot.test.mjs
```

阶段性收尾：

```bash
npm test
npm run build
```
