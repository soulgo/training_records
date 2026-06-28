# 02 Prompt 问题清单：仅保留代码可验证问题

## 分级原则

- P0：当前 Prompt/schema/fallback/DB 合同不一致，可能导致正确输出失败或运行时能力倒退。
- P1：当前代码可验证的维护性或准确率风险，需要测试和小改造收敛。
- P2：当前可改进但不阻断的测试覆盖或命名问题。
- 删除项：未在当前代码中实现的 Skills、pipeline、未来字段体系，不列为当前问题。

## P0-1：`records.sleep` Prompt 强要求，但 schema 未纳入 `records.required`

### 代码依据

- `prompts/_source/recognition-rules.json` 的 sleep 规则要求：睡眠截图必须输出 `records.sleep` schema 中全部字段。
- `src/core/ai/telegram-recognition-schema.mjs` 的 `records.required` 当前为：

```text
measurement, activities, meals, totalCalories, details, dailyWorkoutSummary
```

其中没有 `sleep`。

- `src/adapters/telegram/sync-batch-logic.adapter.mjs` 已有后置跳过：

```text
sleep image missing records.sleep for message ...
```

### 影响

- `imageType=sleep` 且缺少 `records.sleep` 的结果可能先通过 schema 结构归一化，再在 batch 层被跳过。
- 失败位置后移，错误归因不清晰。
- 测试只能覆盖 batch 跳过，不能保证 schema 合同。

### 最小修正

1. 在 `src/core/ai/telegram-recognition-schema.mjs` 的 `records.required` 加入 `sleep`。
2. 在 `test/ai-schema-validator.test.mjs` 增加断言：`imageType=sleep` 且 records 缺 `sleep` 时 schema 失败。
3. 确认 `normalizeRecognitionPayload()` 仍能把非 sleep 图片的 `records.sleep` 补为 `null`。

### 验收

```bash
node --test test/ai-schema-validator.test.mjs test/ai-recognition-service.test.mjs test/telegram-sync.test.mjs
```

## P0-2：nutrition recommended 范围 Prompt 允许 `null`，schema 只允许 number

### 代码依据

- `prompts/_source/recognition-rules.json` 的 nutrition 规则写明 `recommendedMin`、`recommendedMax` 没有可靠范围时填 `null`。
- `src/core/ai/telegram-recognition-schema.mjs` 中 meals item 当前为：

```text
recommendedMin: { type: 'number' }
recommendedMax: { type: 'number' }
```

- `sql/training_records/core.sql` 中 `core.meal.recommended_min`、`recommended_max` 是 nullable `int4`。
- `src/adapters/telegram/sync-batch-logic.adapter.mjs` 的 `normalizeNutrition()` 已把非有限数字转为 `null`。
- `src/adapters/postgres/core-row-writer.pg.mjs` 对 null 可写入 `core.meal`。

### 影响

- AI 按 Prompt 输出 `null` 会被 schema 拒绝。
- AI 可能为了满足 schema 编造推荐范围。
- DB 和 normalizer 本来支持 null，schema 是当前不一致点。

### 最小修正

1. 将 `recommendedMin`、`recommendedMax` 的 schema 类型改为 `['number', 'null']`。
2. 在 `test/ai-schema-validator.test.mjs` 增加 meals recommended null 可通过的测试。
3. 保持 `core.meal` 写入逻辑不变。

### 验收

```bash
node --test test/ai-schema-validator.test.mjs test/ai-recognition-service.test.mjs test/telegram-sync.test.mjs test/training-db-core.test.mjs
```

## P0-3：硬编码 fallback Prompt 漏掉 `sleep`

### 代码依据

`src/app/use-cases/telegram-sync/image-processing.mjs` 的 `fallbackRecognitionSystemPrompt` 当前只允许：

```text
measurement、workout、nutrition、unknown
```

但 schema v2、source Prompt、生成 Prompt 都支持：

```text
measurement、workout、nutrition、sleep、unknown
```

### 影响

- 当 `prompts/telegram-training-image-recognition.md` 读取失败或被空文件覆盖时，sleep 识别退回旧能力。
- fallback 路径与 `RECOGNITION_SCHEMA_VERSION = 'v2'` 不匹配。
- 当前测试 `loadRecognitionSystemPrompt reads the versioned Telegram image prompt` 不覆盖 fallback 内容。

### 最小修正

1. 更新 `fallbackRecognitionSystemPrompt`，加入 `sleep` 和最小 sleep 输出约束。
2. 在 `test/telegram-sync-runner.test.mjs` 或独立测试中增加无效 `TELEGRAM_RECOGNITION_PROMPT_PATH` 时 fallback 包含 `sleep` 的断言。
3. 保持默认路径读取生成 Prompt 的逻辑不变。

### 验收

```bash
node --test test/telegram-sync-runner.test.mjs
```

## P1-1：Prompt、schema、代码归一化存在重复字段合同

### 代码依据

- Prompt 字段在 `prompts/_source/recognition-rules.json` 手写。
- schema 字段在 `src/core/ai/telegram-recognition-schema.mjs` 手写。
- sleep 缺字段由 `normalizeRecognitionSleep()` 补齐。
- batch 层再用 `normalizeSleepRecord()` 判断是否有真实值。
- DB 写入字段在 `src/adapters/postgres/core-row-writer.pg.mjs` 手写。

### 影响

- 字段增删容易只改一处。
- 已经出现 sleep required、recommended nullable 两个合同不一致。

### 最小修正

本轮不引入新 schema 生成系统。只做可执行的对照测试：

1. 增加测试检查 Prompt 中提到的关键 required/null 规则与 schema 一致。
2. 将 `records.sleep`、meals nullable、fallback imageType 列为固定合同测试。
3. 文档中明确字段 owner：Prompt、schema、normalizer、DB writer。

## P1-2：workout 结构化能力低于 DB 字段能力

### 代码依据

- schema 中 activity 只有 `time/type/detail`。
- `core.activity` 具备 `calories`、`heart_rate`、`distance_km`、`avg_speed_kmh`、`duration_text`、`duration_seconds`。
- `src/core/entities/training-record.mjs` 的 `normalizeBatchActivity()` 从 `detail` 中用正则解析这些字段：

```text
消耗 N 千卡
N 次/分钟
N 公里
均速 N 公里/小时
N分N秒 或 HH:MM:SS
```

### 影响

- Prompt 输出同义格式时可能漏解析。
- DB 字段存在不代表 AI 已结构化输出。
- 当前不支持动作组数、次数、重量的 schema 或 DB 字段。

### 最小修正

1. 短期只改 Prompt：要求 `detail` 使用现有正则可识别格式。
2. 在 `test/telegram-sync.test.mjs` 或 entity 测试中加入 `detail` 格式回归样例。
3. 不在本轮新增 sets/reps/weight 字段。

## P1-3：caption/text 直接进入 user message，缺少长度和注入边界

### 代码依据

`src/app/use-cases/image-recognition.use-case.mjs` 的 `buildRecognitionMessages()` 直接拼接：

```text
caption: ...
text: ...
将图片识别为训练系统可写回的结构化结果。
Return only valid json.
```

### 影响

- 用户 caption/text 可能干扰模型服从系统 Prompt。
- 超长文本会增加请求体和成本。
- 飞书同样受影响，因为飞书消息会映射为共享 `text/caption`。

### 最小修正

1. 为 caption/text 增加截断函数。
2. 在 user text 中明确 caption/text 是外部上下文，不能覆盖系统规则。
3. 增加测试：超长 caption 被截断，包含“忽略上文”时仍只是上下文文本。

## P1-4：App Profile source 会被生成器静默截断

### 代码依据

`tools/prompt-generator.mjs` 的 `renderAppProfilesMemory()` 当前限制：

- app aliases 最多 4 个。
- page cues 每类最多 3 个。
- field aliases 总计最多 12 个。
- unit conversions 最多 4 个。
- time priority 最多 4 个。

### 影响

- 新增 alias 后，source JSON 里存在不等于生成 Prompt 中存在。
- app profile 维护者可能误以为所有字段都已进入运行时 Prompt。

### 最小修正

1. 在 `test/prompt-generator.test.mjs` 固定断言关键 alias 出现在生成 Prompt 中。
2. 新增 profile 时必须同时新增“生成结果包含关键 alias”的测试。
3. 不在本轮改成动态 profile 拼装。

## P1-5：日期规则分层正确，但缺少单一可执行合同表

### 代码依据

- Prompt：`recognition-rules.dateRules` 和 `shared-rules.sharedDateRules`。
- 代码：`src/adapters/telegram/sync-dates.adapter.mjs`。
- 文档：`docs/训练系统/Telegram图片日期归档.md`。
- batch：`analyzeTelegramBatch()` 决定图片日期、filename date、sleep archive date、冲突跳过。

### 影响

- 维护者容易把程序归档逻辑写进 Prompt。
- sleep “醒来日期减一天”容易被误写成 AI 自行换算归档日期。

### 最小修正

1. 在本目录文档中保留 AI/程序日期职责表。
2. 改日期规则时必须同步 `test/telegram-sync.test.mjs` 与 `docs/训练系统/Telegram图片日期归档.md`。

## P2-1：Prompt 测试偏结构存在性，缺少合同断言

### 代码依据

`test/prompt-generator.test.mjs` 已覆盖生成 Prompt 的章节、metadata、sleep 关键文本和 app profile 基本存在性。

缺口：

- 不检查 fallback Prompt。
- 不检查 schema 与 Prompt 的 required/nullable 合同。
- 不检查 app profile 截断后的关键 alias 完整性。

### 最小修正

新增上述合同测试。不要把“真实图片准确率评估”写成已存在能力；如果要做，应作为新增 test fixture/tooling 任务。

## P2-2：命名仍带 Telegram 历史语义

### 代码依据

- schema name：`telegram_training_image`。
- cache key 前缀：`telegram:file_unique_id`。
- ingest 表：`ingest.telegram_*`。
- 飞书通过 `sourceChannel: 'feishu'` 复用这套链路。

### 影响

- 命名容易让新维护者误解为只支持 Telegram。
- 但当前这不是阻断问题，重命名会牵涉缓存、DB、测试和文档。

### 最小修正

本轮不改名。新增文档统一说明：“Telegram 命名是历史兼容层，飞书通过 adapter 复用同一识别语义”。

## 已删除的假设性问题

以下不列为当前问题：

- NOT IMPLEMENTED IN CODE：Skills 分类错误问题。
- NOT IMPLEMENTED IN CODE：多 Prompt 多调用成本问题。
- NOT IMPLEMENTED IN CODE：workout v3 结构字段缺失作为当前 bug。
- NOT IMPLEMENTED IN CODE：nutrition foods/macros 表缺失作为当前 bug。
- NOT IMPLEMENTED IN CODE：统一 RecognitionTask 未实现作为当前 bug。
