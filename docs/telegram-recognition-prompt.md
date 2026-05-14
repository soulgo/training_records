# Telegram 图片识别 Prompt 维护说明

Telegram 图片识别的运行时 prompt 在：

- `prompts/telegram-training-image-recognition.md`

这份文件会被 `tools/telegram-sync.mjs` 在调用 AI 识别图片时读取。也就是说，修改它会影响后续 Telegram 图片解析入库结果。

## 维护原则

- 先改 prompt，再用测试验证，不要只在代码里临时补一句。
- 日期、单位、空值和餐次口径要写成明确规则，避免让模型自由猜。
- schema 字段名不要在 prompt 里改名；字段结构由 `buildRecognitionSchema()` 约束。
- 新增识别字段时，需要同步修改 schema、`analyzeTelegramBatch()`、数据库/Markdown 写入逻辑和测试。
- 不确定日期时宁可让 `detectedDate` 为 `null`，交给现有跳过/回退逻辑处理。

## 本地验证

修改 prompt 后至少运行：

```bash
npm test -- test/telegram-sync-runner.test.mjs test/telegram-sync.test.mjs
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

实验稳定后，再把有效规则合并回 `prompts/telegram-training-image-recognition.md`。
