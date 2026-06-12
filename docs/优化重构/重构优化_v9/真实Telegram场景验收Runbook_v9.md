# V9 真实 Telegram 场景验收 Runbook

本文用于执行 `checklist.md` 中 `V9-3 手工核对真实 Telegram 场景`。本地单测已经覆盖日期归档、增量入库、fallback、pending replay 和通知语义；本 runbook 只补齐真实 dev Bot / dev workflow 链路的人工验收步骤和证据口径。

## 验收边界

必须保持以下业务口径不变：

- 普通训练、体脂秤、饮食图片只使用图片内可靠日期或 Telegram 原始文件名日期；不能用 caption、发送时间或运行时间猜日期。
- 睡眠图片按醒来日期减一天归档；只有纯时间且没有可靠日期时应跳过。
- 数据库失败时仍写 fallback Markdown，并进入 pending 队列。
- `ready + stored` 图片批次成功后不默认全量覆盖 `训练记录.md`，只对目标日期做增量合并。

## 准备工作

1. 在 dev Bot 上执行，避免影响生产数据。
2. 确认 dev workflow 为 `Telegram Sync (Dev)`，repository dispatch 类型为 `telegram_update_dev`。
3. 准备四组样例图片：
   - 单张睡眠截图：截图内能看出醒来日期和入睡/醒来时间。
   - 1-4 张训练相册：至少包含运动总览或训练明细，日期规则清晰。
   - partial failure 相册：一张有效训练/饮食图，加一张会触发 AI 解析失败或无效识别的图片。
   - 数据库 fallback 场景：需要临时使用不可用的 `DEV_TRAINING_DB_URL` 或其它 dev-only 数据库失败开关触发，执行后恢复。
4. 记录执行前的最新 dev workflow run id、dev 分支 commit、目标归档日期当前页面/数据库状态。

## 通用证据

每个场景都需要保留以下证据：

- Telegram 回执文本：是否显示已入库、部分解析失败、加入重试队列或数据库待补偿。
- GitHub Actions summary：`batchId`、`taskStatus`、`persistenceStatus`、`archivedDate`、图片计数、pending 状态、`failureDisposition`、失败 messageIds。
- `runtime/telegram-sync-result.json` 或 workflow 日志中的同字段报告。
- dev 分支文件变化：`训练记录.md`、`source/_posts`、`source/images` 是否符合该场景预期。
- 数据库或页面证据：目标日期的 `core.*` / dashboard 显示是否符合预期。

## 场景 1：单张睡眠截图

操作：

1. 发送一张睡眠截图到 dev Bot。
2. 截图内应包含醒来日期，例如 `6/4 06:19`，并能识别夜间睡眠阶段。

预期：

- `archivedDate` 为醒来日期减一天，例如醒来 `2026-06-04` 时归档到 `2026-06-03`。
- `taskStatus` 为 `stored`，`persistenceStatus` 为 `stored`。
- `sourceImageCount/recognizedImageCount/failedImageCount` 为 `1/1/0`。
- `core.sleep` 有目标日期记录，`core.training_day` 睡眠汇总更新。
- 同日已有 measurement/activity/meal 不被删除。
- `训练记录.md` 目标日期出现 `睡眠截图记录`，并包含总睡眠、深睡/浅睡/REM、评分、健康指标、解读和建议。

失败判定：

- 如果归档到醒来当天，说明睡眠日期规则回归失败。
- 如果只有 Telegram 回执成功但 `core.sleep` 或页面无数据，需要检查 sleep backfill / core 写入。
- 如果同日饮食或训练被删除，说明增量写入隔离失败。

## 场景 2：1-4 张相册正常入库

操作：

1. 发送 1-4 张同日训练/饮食/体脂秤截图相册。
2. 至少一张图片有可靠图片日期，或以 document 形式发送并带唯一文件名日期。

预期：

- 只有一个可靠日期时，无日期图片继承该日期。
- `taskStatus` 为 `stored`，`persistenceStatus` 为 `stored`。
- 图片计数符合实际张数，例如 `3/3/0`。
- `core.measurement`、`core.activity`、`core.meal` 只 upsert 本批次数据，不删除同日其它模块。
- `core.training_day` 只刷新目标日期汇总。
- 成功批次不触发整份 `训练记录.md` 全量覆盖；目标日期只出现本批次增量合并。

失败判定：

- 如果 caption 或发送时间影响归档日期，说明普通图片日期规则回归失败。
- 如果同日 sleep 或 nutrition details 被清空，说明单日汇总刷新或增量 upsert 规则失败。
- 如果 Actions summary 没有图片计数或 pending/failure 字段，说明 workflow 可观测性回归。

## 场景 3：partial failure 与 pending replay

操作：

1. 发送一个相册，其中至少一张图片可以成功识别，另一张触发 AI 解析失败、空响应或无效 JSON。
2. 等待第一次 dev workflow 完成。
3. 再触发一次 dev sync，或等待 pending replay 条件满足后重放。

第一次预期：

- 成功图片先入库。
- `partialFailure` 为 true。
- `taskStatus` 为 `partialFailure` 或报告中明确部分失败。
- `recognizedImageCount < sourceImageCount`，`failedImageCount > 0`。
- `recognitionPendingStatus` 为 `queued`。
- `failureDisposition` 为 `auto_retry`。
- Telegram 回执包含“部分解析失败”和失败 messageIds。

重放预期：

- pending replay 成功后 `recognitionPendingStatus` 为 `resolved`。
- `retryState` 为 `resolved`，`pendingReplay` 为 true。
- 成功后不重复写已存在数据，相同 key 保持幂等。

失败判定：

- 如果部分失败被回成“解析成功”，说明通知语义回归。
- 如果失败图片没有进入 pending，说明 retry 队列回归。
- 如果 replay 后重复生成同一条 meal/activity/sleep，说明 key 幂等回归。

## 场景 4：数据库失败 fallback

操作：

1. 仅在 dev 环境临时触发数据库不可用，例如临时设置无效的 `DEV_TRAINING_DB_URL`。
2. 发送一张可识别的训练或饮食图片。
3. workflow 完成后立即恢复 dev 数据库配置。
4. 再触发一次 dev sync 验证 pending replay。

第一次预期：

- Telegram 回执说明已记录、数据库待补偿。
- `persistenceStatus` 为 `pending_replay`。
- `failureDisposition` 为 `auto_retry`。
- `训练记录.md` 不写入本批次内容，等待 DB -> Markdown 备份导出。
- pending 队列包含该 batch。

恢复后预期：

- pending batch 入库成功。
- pending 队列被清空或对应 batch 标记 resolved。
- 数据库中目标日期数据与 Markdown 保持一致。

失败判定：

- 如果数据库失败导致 workflow 直接丢弃训练数据，fallback 回归失败。
- 如果 fallback 写 Markdown 但没有 pending，补偿链路回归失败。
- 如果恢复后无法 replay，检查 `batchId`、`payload_hash` 和 pending store 状态。

## 验收记录模板

```text
执行人：
执行时间：
dev workflow run：
dev commit：

场景 1 单张 sleep：
- Telegram messageIds：
- archivedDate：
- summary taskStatus/persistenceStatus/images：
- DB/page evidence：
- 结论：

场景 2 1-4 张相册：
- Telegram messageIds：
- archivedDate：
- summary taskStatus/persistenceStatus/images：
- DB/page evidence：
- 结论：

场景 3 partial failure + replay：
- 第一次 run：
- replay run：
- failed messageIds：
- pending/resolved evidence：
- 结论：

场景 4 DB fallback：
- 故障注入方式：
- fallback run：
- replay run：
- pending evidence：
- 结论：
```

四个场景均符合预期后，才能将 `checklist.md` 的 `V9-3` 改为 `[x]`。
