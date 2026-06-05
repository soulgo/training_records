# Telegram 睡眠识别与入库说明

本文档用于说明 Telegram 睡眠截图从识别、同步、归档到数据库落表的完整链路，便于后续维护和排查问题。

## 1. 适用范围

当前只面向夜间睡眠截图的主流程，重点覆盖以下信息：

- 入睡时间
- 起床时间
- 总睡眠时长
- 夜间睡眠时长
- 深睡、浅睡、REM、清醒时长
- 睡眠阶段文本与阶段明细

如果截图明显是午睡或小睡，也会被识别为 `sleep`，但默认维护口径仍以夜间睡眠为主。

## 2. 识别层口径

睡眠图片识别规则维护在：

- `prompts/_source/recognition-rules.json`
- 生成产物 `prompts/telegram-training-image-recognition.md`

关键约束：

- `imageType` 使用 `sleep`
- `records.sleep` 才是睡眠字段载体
- `sleepType` 默认写 `夜间睡眠`
- `bedtime`、`wakeTime` 只填写截图里可见的真实时间
- `sleepStageDetail` 只保留画面明确可见的信息，不要补全推断
- 睡眠截图需要提取的健康指标包括：`sleepScore`、`sleepScorePercentile`、`deepSleepRatioPct`、`lightSleepRatioPct`、`remSleepRatioPct`、`deepSleepContinuityScore`、`wakeCount`、`breathingQualityScore`、`averageHeartRateBpm`、`hrvMs`、`averageSpo2Pct`、`averageRespiratoryRate`
- `analysisText` 写截图底部的睡眠解读，`suggestionText` 写截图底部的睡眠建议
- 遇到跨天、多个日期或日期冲突时，宁可让 `detectedDate` 为 `null`
- 夜间睡眠的归档日期以醒来时间为准：程序侧会把醒来日期减一天后写入睡眠归档日期，不要求 AI 自行换算归档日
- 只要截图中能明确看出入睡日和醒来日，优先提供真实的入睡时间和醒来时间，不要为了归档日期改写它们

## 3. 同步层口径

睡眠批次在 `tools/telegram-sync-lib.mjs` 中会进入 batch 分析，并在满足归档条件后写回训练 Markdown，生成睡眠区块。

同步链路里，睡眠记录会被汇总为：

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

如果批次没有可靠日期，仍然会跳过入库，以防错归档。

## 4. 数据库落表

睡眠结果会同时写入两层表：

- 核心库 `core.sleep`
- 归档库 `archive.training_sleep`

同时，日汇总也会更新到训练日表中的睡眠字段：

- `sleep_total_minutes`
- `night_sleep_minutes`
- `nap_minutes`
- `sleep_start_time`
- `sleep_end_time`
- `deep_sleep_minutes`
- `light_sleep_minutes`
- `rem_sleep_minutes`
- `awake_minutes`

### 幂等策略

- `core.sleep` 使用 `sleep_key` 去重
- `archive.training_sleep` 使用 `sleep_hash` 去重
- 同一天重复同步时，会先清理该日期的旧睡眠记录，再写入最新结果

## 5. 维护与排查顺序

当你遇到“识别到了睡眠图，但页面没有数据”时，建议按这个顺序看：

1. 看 Telegram 批次状态是否是 `ready`
2. 看 `batchResult.sleep` 是否为空
3. 看 `archivedDate` 是否可靠
4. 看 `core.sleep` 是否有对应日期记录
5. 看 `archive.training_sleep` 是否同步成功
6. 看 `core.training_day` 的睡眠汇总字段是否更新
7. 看前端展示是否还在读取旧缓存或旧静态页

## 6. 相关文件

- `tools/telegram-recognition-schema.mjs`
- `tools/telegram-sync-lib.mjs`
- `src/db/training/write.mjs`
- `src/db/training/read.mjs`
- `sql/training_records/sleep.sql`
- `sql/training_records/sleep_validation.sql`
- `docs/训练系统/Telegram图片日期归档.md`

## 7. 推荐验证命令

```bash
node tools/prompt-generator.mjs
node --test test/prompt-generator.test.mjs test/telegram-sync.test.mjs test/telegram-sync-runner.test.mjs
```

如果还涉及数据库结构更新，再补充执行相应 SQL 校验脚本。
