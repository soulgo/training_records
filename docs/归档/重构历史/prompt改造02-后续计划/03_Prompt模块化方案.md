# 03 Prompt 模块化方案：仅保留当前代码可实现拆分

## 结论

当前可落地的模块化只有一种：拆 `prompts/_source/` 规则源和调整 `tools/prompt-generator.mjs` 编排，运行时仍生成并加载一份 `prompts/telegram-training-image-recognition.md`。

本轮不做：

- NOT IMPLEMENTED IN CODE：分类 Prompt + 专项 Prompt 多次 AI 调用。
- NOT IMPLEMENTED IN CODE：Skills 编排。
- NOT IMPLEMENTED IN CODE：按 app 动态拼装运行时 Prompt。
- NOT IMPLEMENTED IN CODE：新增 workout/nutrition DB 字段体系。

## 当前生成器事实

`tools/prompt-generator.mjs` 的 `generateRecognitionPrompt()` 当前拼装顺序：

1. metadata header。
2. `recognition.role`。
3. `recognition.batchRules`。
4. `recognition.screenshotTypeRules`。
5. `recognition.adaptiveExtraction`。
6. `renderAppProfilesMemory(appProfiles)`。
7. `recognition.outputType`。
8. `recognition.dateRules`。
9. `shared.sharedDateRules`。
10. `recognition.measurement`。
11. `recognition.workout`。
12. `recognition.nutrition`。
13. `recognition.sleep`。
14. `shared.confidenceAndWarnings`。
15. `shared.nullConventions`。

因此模块化必须先保证生成后文本仍包含上述关键合同。

## 第一阶段目标目录

建议只拆图片识别 source，不动 analysis source：

```text
prompts/_source/
  shared-rules.json
  analysis-rules.json
  app-profiles.json
  recognition/
    metadata.json
    role.json
    batch-rules.json
    screenshot-type-rules.json
    adaptive-extraction.json
    output-type.json
    date-rules.json
    measurement.json
    workout.json
    nutrition.json
    sleep.json
```

说明：

- `shared-rules.json` 先保留，避免同时影响 `training-analysis.md`。
- `app-profiles.json` 第一阶段可保留原文件；如果要拆 app profile，先补生成结果测试。
- 不新增 DSL，只把现有 JSON sections 拆小。

## 模块边界

| 模块 | 允许包含 | 禁止包含 | 验收点 |
|---|---|---|---|
| `metadata.json` | version、schemaName、schemaVersion | 业务规则 | metadata 与现有 header 等价 |
| `role.json` | 系统角色和只输出 JSON | 字段规则 | 生成 Prompt 仍有“只能输出符合 schema 的 JSON” |
| `batch-rules.json` | 单图识别、批次数量不由 AI 推断 | 日期归档逻辑 | 相册数量规则仍存在 |
| `screenshot-type-rules.json` | 总览/明细/饮食/体脂秤职责 | sleep 字段全集 | 总览不拆活动规则仍存在 |
| `adaptive-extraction.json` | 可见事实、detectedApp、现有 schema 映射 | 新 core 字段设计 | `detectedApp` 和“不新增 core 字段”仍存在 |
| `output-type.json` | 五类 `imageType` 枚举说明 | 各类型字段细节 | 包含 `measurement/workout/nutrition/sleep/unknown` |
| `date-rules.json` | AI 可见日期边界 | 程序 filename fallback 作为 detectedDate | caption/text 禁止、visible filename 允许 |
| `measurement.json` | measurement 字段和单位 | 入库 key 规则 | 字段与 schema measurement 对齐 |
| `workout.json` | activities 和 dailyWorkoutSummary | sets/reps/weight 未实现字段 | `detail` 格式利于现有正则 |
| `nutrition.json` | meals、totalCalories、details | foods/macros 未实现字段 | recommended null 与 schema 修复一致 |
| `sleep.json` | records.sleep 全字段、跨天边界 | AI 自行输出归档日期 | sleep 字段全集与 schema 一致 |

## 生成器改造步骤

### Step 1：兼容加载新旧 source

修改 `tools/prompt-generator.mjs`：

- 先尝试读取 `prompts/_source/recognition/*.json`。
- 如果目录不存在或读取失败，继续读取现有 `recognition-rules.json`。
- 保持 `loadStructuredSource('recognition-rules')` 对测试和其他调用方可用，直到迁移完成。

验收：

```bash
node --test test/prompt-generator.test.mjs
```

### Step 2：迁移现有 recognition sections

把 `prompts/_source/recognition-rules.json` 中对应 section 原样移动到新文件。

迁移要求：

- 不改字段名。
- 不改规则文本含义。
- 不 bump schemaVersion，除非同时改 schema。
- 运行 `node tools/prompt-generator.mjs` 后生成 Prompt 的关键合同不丢失。

验收：

```bash
node tools/prompt-generator.mjs
node --test test/prompt-generator.test.mjs
```

### Step 3：补合同测试

在 `test/prompt-generator.test.mjs` 增加：

- 生成 Prompt 包含五类 `imageType`。
- 生成 Prompt 包含 sleep 全字段关键锚点。
- 生成 Prompt 包含 nutrition recommended null 规则。
- 生成 Prompt 包含当前 app profile 关键 alias。
- 生成 Prompt 包含 caption/text 不可作为 `detectedDate` 的规则。

### Step 4：删除旧 source 或保留转发

完成迁移后有两种可选处理：

| 选项 | 动作 | 建议 |
|---|---|---|
| 保留旧 `recognition-rules.json` | 写 `_deprecated` 说明，生成器不再使用 | 更稳，便于回滚 |
| 删除旧文件 | 只保留拆分目录 | 需要同步所有文档和测试 |

推荐第一轮保留旧文件并标记 deprecated，确认稳定后再删除。

## App Profile 处理

当前 `app-profiles.json` 可暂不拆。更重要的是补测试，因为生成器会截断 profile 内容。

必须测试的 alias：

- 华为健康：`活动热量 -> records.dailyWorkoutSummary.activityCaloriesKcal`
- 华为健康：`夜间睡眠 -> records.sleep.nightSleepMinutes`
- Apple Health：`Active Energy -> records.dailyWorkoutSummary.activityCaloriesKcal`
- Apple Health：`REM Sleep -> records.sleep.remSleepMinutes`
- Apple Health：`Wake Up -> records.sleep.wakeTime`

如果新增 app profile，必须至少新增：

1. source JSON profile。
2. 生成 Prompt 中关键 alias 存在性断言。
3. 一条 `test/fixtures/telegram-recognition/*.json` 或识别服务 fixture。

## 不改运行时加载路径

本阶段必须保持：

- 默认运行时文件：`prompts/telegram-training-image-recognition.md`。
- 读取函数：`loadRecognitionSystemPrompt()`。
- 临时覆盖变量：`TELEGRAM_RECOGNITION_PROMPT_PATH`。
- 单次 AI 调用：`recognizeTelegramImageMessage()`。
- 识别缓存 key：仍使用 prompt metadata 中的 version/schemaVersion。

## 对 schema 的约束

模块化本身不改变 schema。以下 schema 修复属于 02 文档中的 P0，应先完成或与模块化同 PR 完成：

- `records.required` 增加 `sleep`。
- meals `recommendedMin/recommendedMax` 允许 null。

禁止在模块化 PR 中顺手新增：

- workout `sets/reps/weight` 字段。
- nutrition `foods/macros` 字段。
- app profile 专属 DB 字段。

## 回滚方式

1. 保留旧 `prompts/_source/recognition-rules.json`。
2. 如果拆分生成器出问题，切回读取旧 source。
3. 重新运行：

```bash
node tools/prompt-generator.mjs
node --test test/prompt-generator.test.mjs test/telegram-sync-runner.test.mjs
```

4. 若已发布新 Prompt，运行时可临时用 `TELEGRAM_RECOGNITION_PROMPT_PATH` 指向旧 Prompt 文件。

## 完成定义

- `node tools/prompt-generator.mjs` 成功。
- `test/prompt-generator.test.mjs` 覆盖新拆分 source。
- 生成 Prompt 的 metadata、五类 imageType、日期规则、四类专项规则、app profile、空值和置信规则均存在。
- 没有新增运行时多调用、Skills 或新 DB 字段。
