# Telegram 图片识别 Prompt 维护说明

## 源文件与生成流程

图片识别 prompt 的**单一事实来源**是结构化源文件：

- `prompts/_source/shared-rules.json` — 共享规则（空值约定、置信度、日期共享规则）
- `prompts/_source/recognition-rules.json` — 识别特有规则（输出类型、日期、体脂秤、运动、饮食、睡眠）

运行时 prompt `prompts/telegram-training-image-recognition.md` 由生成器从结构化源编译产出：

```bash
node tools/prompt-generator.mjs
```

**维护规则：以后改规则只改 `prompts/_source/` 下的 JSON 源文件，不直接手写 `prompts/telegram-training-image-recognition.md`。** 改完后运行生成器重新编译，并验证测试通过。

`tools/telegram-sync.mjs` 在调用 AI 识别图片时读取编译后的 prompt 文件；`TELEGRAM_RECOGNITION_PROMPT_PATH` 环境变量仍可用于临时实验覆盖。

如果你这次维护涉及”单张/多张图片怎么定归档日期、图片没日期时怎么回退、`photo` 和 `document` 有什么差别”，请先一起阅读：

- [Telegram 图片日期归档](Telegram图片日期归档.md)

## 维护原则

- **先改结构化源，再运行生成器，最后用测试验证。不要直接手写成品 prompt。**
- 日期、单位、空值和餐次口径要写成明确规则，避免让模型自由猜。
- schema 字段名不要在 prompt 里改名；字段结构由 `buildRecognitionSchema()` 约束。
- 新增识别字段时，需要同步修改 schema、`analyzeTelegramBatch()`、数据库/Markdown 写入逻辑和测试。
- 如果新增的是睡眠识别字段，还要同步更新 `core.sleep`、`archive.training_sleep` 和 `archive.training_day` 的睡眠汇总列。
- 睡眠截图的时间语义要和程序侧一致：AI 负责提取真实入睡/起床时间，程序负责把醒来时间前一天作为睡眠归档日。
- 不确定日期时宁可让 `detectedDate` 为 `null`，交给现有跳过/回退逻辑处理。

当前 `imageType` 稳定口径：

| `imageType` | 适用截图 | 主要输出 |
| --- | --- | --- |
| `workout` | 当日活动总览、运动记录、活动明细、心率/距离/消耗截图 | `records.dailyWorkoutSummary` 或 `records.activities` |
| `measurement` | 体脂秤、体重、身体成分截图 | `records.measurement` |
| `nutrition` | 饮食、餐次、总摄入截图 | `records.meals`、`records.totalCalories`、`records.details` |
| `sleep` | 睡眠时长、入睡/起床、睡眠阶段、睡眠健康指标截图 | `records.sleep` |
| `unknown` | 非上述业务截图或无法可靠识别 | 空 records、低置信或 warning |

睡眠字段维护时要额外注意：

- `records.sleep` 必须包含 schema 中的全部睡眠字段；画面不可见的字段填 `null`，不要省略。
- `bedtime`、`wakeTime` 写截图中真实可见的时间文本，不要为了归档日改写。
- `sleepScore`、`averageHeartRateBpm`、`hrvMs`、`averageSpo2Pct`、`averageRespiratoryRate` 等健康指标只从可见区域提取。
- `analysisText` 和 `suggestionText` 只保存截图中已有的解读/建议，不让模型生成新建议。
- 如果只看得到醒来日期，程序会按醒来日期减一天归档；prompt 不需要让 AI 输出“归档日期”。

当前日期识别口径：

- `detectedDate` 只来自截图画面内可见内容。
- 系统相册、文件详情或分享预览页里可见的文件名、标题、路径日期，也算画面内日期。
- 活动总览顶部的大号日期如果可靠，可以用于 `detectedDate`。
- Telegram 消息年份只用于补全截图内可见的月日，不能单独产生 `detectedDate`。
- caption/text 和 Telegram 外部文件名不属于 `detectedDate` 来源；外部文件名只由程序后处理作为 `archivedDate` 回退。

## 本地验证

改完结构化源并重新生成 prompt 后至少运行：

```bash
node --test test/prompt-generator.test.mjs test/telegram-sync-runner.test.mjs test/telegram-sync.test.mjs
```

如果改动会影响解析结果、页面展示或数据库字段，再运行：

```bash
npm test
```

## 临时实验

可以用环境变量覆盖 prompt 路径，方便在不改默认 prompt 的情况下做实验：

```bash
TELEGRAM_RECOGNITION_PROMPT_PATH=/path/to/prompt.md npm run sync:telegram
```

实验稳定后，把有效规则合并回 `prompts/_source/` 结构化源，再重新生成 prompt。
