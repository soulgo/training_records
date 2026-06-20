# 08 实施 Checklist：可执行验收清单

## 使用规则

每一项都必须满足：

- 有明确文件。
- 有明确改动。
- 有明确测试或人工核对条件。
- 不依赖未实现 Skills、pipeline 或新 DB 字段。

## Phase 0：基线

- [ ] 生成当前 Prompt。
  - 文件：`tools/prompt-generator.mjs`、`prompts/telegram-training-image-recognition.md`
  - 命令：`node tools/prompt-generator.mjs`
  - 验收：命令退出码为 0。

- [ ] 跑图片识别相关基线测试。
  - 命令：`node --test test/prompt-generator.test.mjs test/ai-schema-validator.test.mjs test/ai-recognition-service.test.mjs test/telegram-sync.test.mjs test/feishu-sync.test.mjs`
  - 验收：记录通过/失败状态；失败项需注明是否本轮相关。

## Phase 1：P0 合同修复

- [ ] `records.sleep` 加入 schema required。
  - 文件：`src/core/ai/telegram-recognition-schema.mjs`
  - 改动：`records.required` 包含 `sleep`。
  - 测试：`test/ai-schema-validator.test.mjs`
  - 验收：缺 `records.sleep` 的 sleep payload schema 失败。

- [ ] meals recommended 范围允许 null。
  - 文件：`src/core/ai/telegram-recognition-schema.mjs`
  - 改动：`recommendedMin`、`recommendedMax` 类型为 `['number', 'null']`。
  - 测试：`test/ai-schema-validator.test.mjs`
  - 验收：`recommendedMin: null`、`recommendedMax: null` 可通过 schema。

- [ ] fallback Prompt 覆盖 sleep。
  - 文件：`src/app/use-cases/telegram-sync/image-processing.mjs`
  - 改动：`fallbackRecognitionSystemPrompt` 包含 `sleep` 和 `records.sleep` 最小说明。
  - 测试：`test/telegram-sync-runner.test.mjs`
  - 验收：设置不存在的 `TELEGRAM_RECOGNITION_PROMPT_PATH` 时，`loadRecognitionSystemPrompt()` 返回文本包含 `sleep`。

- [ ] P0 修复测试通过。
  - 命令：`node --test test/ai-schema-validator.test.mjs test/ai-recognition-service.test.mjs test/telegram-sync-runner.test.mjs test/telegram-sync.test.mjs`
  - 验收：命令退出码为 0。

## Phase 2：Prompt source 收敛

- [ ] workout detail 规则贴合现有正则。
  - 文件：`prompts/_source/recognition-rules.json`
  - 改动：`workout.rules` 要求 detail 使用“时长/消耗/距离/均速/平均心率”的稳定中文格式。
  - 测试：`test/prompt-generator.test.mjs`、`test/telegram-sync.test.mjs`
  - 验收：生成 Prompt 包含该格式要求；batch 测试能解析 calories/distance/duration。

- [ ] nutrition 规则不输出未实现字段。
  - 文件：`prompts/_source/recognition-rules.json`
  - 改动：明确 macros/foods 等未入 schema 字段只能进入 `records.details[]` 文本，不作为额外 JSON 字段。
  - 测试：`test/prompt-generator.test.mjs`
  - 验收：生成 Prompt 包含 recommended null 规则，不出现要求输出 `foods[]` 的规则。

- [ ] measurement OCR 与单位规则明确。
  - 文件：`prompts/_source/recognition-rules.json`
  - 改动：补充数字来自标签附近、百分比只输出数字、斤换算 kg、不确定填 null/warning。
  - 测试：`test/prompt-generator.test.mjs`
  - 验收：生成 Prompt 包含上述关键文本。

- [ ] sleep 规则保留程序归档边界。
  - 文件：`prompts/_source/recognition-rules.json`
  - 改动：明确 AI 只提取真实入睡/醒来时间，不输出归档日期；total/night 不相加。
  - 测试：`test/prompt-generator.test.mjs`
  - 验收：生成 Prompt 包含“不要把 totalSleepMinutes 和 nightSleepMinutes 相加”和“程序侧归档”。

- [ ] app profile 关键 alias 有生成结果测试。
  - 文件：`prompts/_source/app-profiles.json`、`test/prompt-generator.test.mjs`
  - 改动：断言华为健康和 Apple Health 的关键 alias 出现在生成 Prompt。
  - 验收：新增 alias 不会被生成器截断后静默丢失。

- [ ] 重新生成 Prompt。
  - 命令：`node tools/prompt-generator.mjs`
  - 验收：`prompts/telegram-training-image-recognition.md` 更新且 metadata 合理。

## Phase 3：caption/text 边界

- [ ] 增加 caption/text 截断。
  - 文件：`src/app/use-cases/image-recognition.use-case.mjs`
  - 改动：新增或内联 `sanitizeRecognitionContextText()`，限制 caption/text 长度。
  - 测试：`test/ai-recognition-service.test.mjs`
  - 验收：超长 caption/text 不完整进入 AI user message。

- [ ] user message 标明 caption/text 不能覆盖系统规则。
  - 文件：`src/app/use-cases/image-recognition.use-case.mjs`
  - 改动：`buildRecognitionMessages()` 的 text part 增加边界说明。
  - 测试：`test/ai-recognition-service.test.mjs`
  - 验收：测试读取 request messages，确认边界说明存在。

- [ ] 飞书路径仍能识别 inline 图片。
  - 文件：`test/feishu-sync.test.mjs`
  - 命令：`node --test test/feishu-sync.test.mjs`
  - 验收：Feishu inline image test 通过。

## Phase 4：最小 fixtures

- [ ] measurement fixture。
  - 文件：`test/fixtures/telegram-recognition/huawei-measurement-visible-core-fields.json`
  - 验收：`recognizeTelegramImageMessage()` 保留 measurement 核心字段。

- [ ] workout fixture。
  - 文件：`test/fixtures/telegram-recognition/huawei-workout-detail-parseable.json`
  - 验收：batch 后可得到 calories、durationSeconds、distanceKm、avgSpeedKmh、heartRate。

- [ ] nutrition fixture。
  - 文件：`test/fixtures/telegram-recognition/nutrition-recommended-null.json`
  - 验收：recommended null 通过 schema，DB writer 可写 null。

- [ ] sleep fixture。
  - 文件：`test/fixtures/telegram-recognition/huawei-sleep-cross-day.json`
  - 验收：`wakeTime` 或 `detectedDate` 可归档到醒来前一天。

- [ ] fixture 测试通过。
  - 命令：`node --test test/ai-recognition-service.test.mjs test/telegram-sync.test.mjs`
  - 验收：命令退出码为 0。

## Phase 5：Prompt source 模块化

- [ ] 生成器兼容拆分 source。
  - 文件：`tools/prompt-generator.mjs`
  - 改动：优先读取 `prompts/_source/recognition/*.json`，保留旧 `recognition-rules.json` fallback。
  - 测试：`test/prompt-generator.test.mjs`
  - 验收：新旧 source 均可生成 Prompt。

- [ ] 拆分 recognition source。
  - 文件：`prompts/_source/recognition/*.json`
  - 改动：按 `03_Prompt模块化方案.md` 的目录拆分。
  - 验收：生成 Prompt 关键章节不丢。

- [ ] 保持运行时路径不变。
  - 文件：`src/app/use-cases/telegram-sync/image-processing.mjs`
  - 验收：默认仍读取 `prompts/telegram-training-image-recognition.md`。

- [ ] 更新维护文档。
  - 文件：`docs/训练系统/Telegram图片识别Prompt维护.md`
  - 验收：维护入口指向新 source 目录或说明旧文件 deprecated。

- [ ] 模块化测试通过。
  - 命令：`node tools/prompt-generator.mjs && node --test test/prompt-generator.test.mjs test/telegram-sync-runner.test.mjs`
  - 验收：命令退出码为 0。

## Phase 6：DB 映射验证

- [ ] measurement 写入 core。
  - 文件：`test/training-db-core.test.mjs`
  - 验收：`core.measurement` 参数包含 weight/bmi/bodyFat 等字段。

- [ ] workout 写入 core。
  - 文件：`test/training-db-core.test.mjs`
  - 验收：`core.activity` 参数包含 calories/heart_rate/distance/duration。

- [ ] nutrition 写入 core。
  - 文件：`test/training-db-core.test.mjs`
  - 验收：`core.meal.recommended_min/max` 可为 null；`training_day.nutrition_details_json` 保留 details。

- [ ] sleep 写入 core。
  - 文件：`test/training-db-core.test.mjs`
  - 验收：`core.sleep` 包含 sleepScore/HRV/SpO2；`sleep_stage_detail` 按 text 写入。

- [ ] training_day 睡眠汇总不虚增字段。
  - 文件：`test/training-db-core.test.mjs`
  - 验收：只断言 SQL 已有睡眠汇总列，不断言 sleepScore/HRV/SpO2 写入 training_day。

- [ ] 飞书 sourceChannel 保持。
  - 文件：`test/feishu-sync.test.mjs`、`test/training-db-core.test.mjs`
  - 验收：`source_channel = 'feishu'` 能进入 batch/core 写入。

## 发布前最小验收

- [ ] `node tools/prompt-generator.mjs`
- [ ] `node --test test/prompt-generator.test.mjs`
- [ ] `node --test test/ai-schema-validator.test.mjs`
- [ ] `node --test test/ai-recognition-service.test.mjs`
- [ ] `node --test test/telegram-sync.test.mjs`
- [ ] `node --test test/telegram-sync-runner.test.mjs`
- [ ] `node --test test/feishu-sync.test.mjs`
- [ ] `node --test test/training-db-core.test.mjs`

## 禁止项核对

- [ ] 未引入 Skills 主路径。
- [ ] 未引入多次 AI 调用。
- [ ] 未新增未设计的 DB 字段。
- [ ] 未让 AI 输出归档日期。
- [ ] 未把 archive 表字段当成图片识别直接写入目标。
