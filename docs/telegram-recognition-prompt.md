# Telegram 图片识别 Prompt 维护说明

## 源文件与生成流程

图片识别 prompt 的**单一事实来源**是结构化源文件：

- `prompts/_source/shared-rules.json` — 共享规则（空值约定、置信度、日期共享规则）
- `prompts/_source/recognition-rules.json` — 识别特有规则（输出类型、日期、体脂秤、运动、饮食）

运行时 prompt `prompts/telegram-training-image-recognition.md` 由生成器从结构化源编译产出：

```bash
node tools/prompt-generator.mjs
```

**维护规则：以后改规则只改 `prompts/_source/` 下的 JSON 源文件，不直接手写 `prompts/telegram-training-image-recognition.md`。** 改完后运行生成器重新编译，并验证测试通过。

`tools/telegram-sync.mjs` 在调用 AI 识别图片时读取编译后的 prompt 文件；`TELEGRAM_RECOGNITION_PROMPT_PATH` 环境变量仍可用于临时实验覆盖。

如果你这次维护涉及”单张/多张图片怎么定归档日期、图片没日期时怎么回退、`photo` 和 `document` 有什么差别”，请先一起阅读：

- [docs/telegram-date-resolution.md](/Users/soulgo/Desktop/training_records/docs/telegram-date-resolution.md)

## 维护原则

- **先改结构化源，再运行生成器，最后用测试验证。不要直接手写成品 prompt。**
- 日期、单位、空值和餐次口径要写成明确规则，避免让模型自由猜。
- schema 字段名不要在 prompt 里改名；字段结构由 `buildRecognitionSchema()` 约束。
- 新增识别字段时，需要同步修改 schema、`analyzeTelegramBatch()`、数据库/Markdown 写入逻辑和测试。
- 不确定日期时宁可让 `detectedDate` 为 `null`，交给现有跳过/回退逻辑处理。

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
