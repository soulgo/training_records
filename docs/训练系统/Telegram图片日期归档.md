# Telegram 图片日期归档流程

这份文档专门说明 `tools/telegram-sync-lib.mjs` 当前如何给 Telegram 图片批次确定 `archivedDate`，以及单张、多张、图片内有日期、图片内没日期时分别会发生什么。

适用对象：

- 维护 Telegram 同步逻辑的人
- 调整图片识别 prompt 的人
- 排查“为什么这张图被跳过/为什么归到这一天”的人

## 1. 先看三个概念

- `detectedDate`
  AI 从截图画面内识别出的可靠日期，只允许来自图片里看得见的内容。

- `filename date`
  程序从 Telegram 原始文件名中提取出的日期，只在 Bot API 真的拿到了 `file_name` 时才存在。

- `archivedDate`
  最终用于入库和归档到某一天的日期。

当前普通图片逻辑里，`archivedDate` 的优先级是：

1. 图片内可靠日期
2. Telegram 原始文件名日期
3. 都没有则跳过

睡眠截图是例外：睡眠图会优先按 `wakeTime` 或截图日期代表的醒来日期减一天归档，详见本文第 7 节。

对外兼容入口仍在 `tools/telegram-sync-lib.mjs`，日期解析实现主要在 `tools/telegram-sync-dates.mjs`。

## 2. 图片内日期的来源边界

`detectedDate` 只能来自截图画面里可见的内容，不能来自 Telegram caption/text，也不能直接来自程序读取到的文件名。

但有一个容易混淆、现在已经明确支持的例外：

- 如果截图本身就是系统相册详情页、文件详情页或分享预览页
- 并且画面里直接显示了文件名、标题或路径
- 那么这些“显示在图片里的文字”仍然算图片内可见日期，可以用于 `detectedDate`

另外两类日期也属于当前支持范围：

- 活动总览这类页面顶部的大号日期，如果可靠，属于截图画面内可见日期。
- 如果截图画面里只出现 `5月22日` 这类月日，可以用 Telegram 消息年份补全；Telegram 消息时间只用于补全年份，不能单独当作图片日期。

这些规则写在 `prompts/telegram-training-image-recognition.md`，事实源是 `prompts/_source/recognition-rules.json`。

## 3. Telegram `photo` 和 `document` 的差异

这是排查日期问题时最重要的一点。

- `document/文件` 发送
  Telegram Bot API 通常会保留原始 `file_name`，程序可以做文件名日期回退。

- `photo/照片` 发送
  Telegram Bot API 通常不会保留原始 `file_name`，程序往往拿不到文件名日期。

所以：

- 如果图片本身没有日期，又想依赖文件名日期回退，优先用 `document/文件` 发送。
- 如果只能用 `photo/照片` 发送，就要尽量保证图片画面里自己能看到日期，或者能看到相册详情页里的文件名日期。

当前程序在“看起来是 `photo` 发送且没有拿到文件名”时，会额外给出 warning，见 `tools/telegram-sync-lib.mjs` 和 `tools/telegram-sync-dates.mjs`。

## 4. 单张图片的处理流程

### 4.1 单张图片，图片内有可靠日期

结果：

- 直接使用图片内日期作为 `archivedDate`
- 即使文件名里还有别的日期，也以图片日期为准
- 如果文件名日期和图片日期不同，会记录 warning，但不会覆盖图片日期

例子：

- 截图顶部显示 `2026-05-14`
- 文件名是 `2026-05-13 饮食记录.jpg`
- 最终归档到 `2026-05-14`

活动总览页同理：如果顶部大号日期显示 `2026年5月22日星期五`，可以作为 `detectedDate=2026-05-22`。

### 4.2 单张图片，图片内没日期，但 Telegram 原始文件名有日期

结果：

- 使用文件名日期作为 `archivedDate`
- 会记录 `Using filename date ... for Telegram batch without image dates.`

支持的常见文件名格式：

- `2026-05-12`
- `2026-5-12`
- `20260512`
- `5月12日`

其中 `5月12日` 会结合 Telegram 消息年份补全年份。

### 4.3 单张图片，图片内没日期，原始文件名也没有日期

结果：

- 跳过这个批次
- `reason` 为 `no reliable image or filename date`

如果同时看起来是 `photo` 发送，warning 里还会提示：

- 这类消息很可能因为 Telegram `photo` 不保留原始文件名，所以无法做文件名日期回退

### 4.4 单张图片，图片里显示的是相册详情页，画面可见文件名日期

结果：

- 现在允许 AI 直接把画面里可见的文件名日期识别成 `detectedDate`
- 即使 Telegram 这条消息本身是 `photo`，仍有机会成功归档

例子：

- 画面里显示 `2026-4-03饮食记录.jpg`
- 最终可以归档到 `2026-04-03`

## 5. 多张图片的处理流程

这里的“多张图片”指同一个 Telegram 相册，也就是同一个 batch。

### 5.1 多张图片里只有一个可靠图片日期，其余图片无日期

结果：

- 用这个唯一的图片日期作为整个 batch 的 `archivedDate`
- 其余无日期图片跟着归到同一天

适合场景：

- 一张运动截图清楚写着日期
- 另一张饮食截图没有日期
- 两张是同一次相册一起发出的

### 5.2 多张图片里每张都没有图片日期，但文件名日期一致

结果：

- 用这个唯一的文件名日期作为整个 batch 的 `archivedDate`

适合场景：

- `饮食记录 2026-05-12.jpg`
- `20260512 运动记录.png`
- 两张图都没有在画面里显示日期

### 5.3 多张图片里有多个不同的图片日期

结果：

- 整个 batch 跳过
- `reason` 为 `conflicting detected dates: ...`

这样做是为了防止把不同天的图误合并到同一天。

### 5.4 多张图片里没有图片日期，但文件名日期互相冲突

结果：

- 整个 batch 跳过
- `reason` 为 `conflicting filename dates: ...`

### 5.5 多张图片里图片日期和文件名日期冲突

结果：

- 仍然优先图片日期
- 文件名日期只作为 warning 记录，不会覆盖

## 6. 体脂秤截图的特殊点

体脂秤除了 `archivedDate`，还有一个 `records.measurement.measuredAt`。

两者不要混为一谈：

- `archivedDate`
  这条记录最终归到哪一天

- `measuredAt`
  截图真实测量时间

如果体脂秤截图只识别到时间，比如 `06:23`，系统会尽量把它和归档日期拼成完整时间；如果整批没有任何可靠日期，仍然不能仅凭一个时间直接归档到某一天。

## 7. 睡眠截图的特殊点

睡眠截图除了 `archivedDate`，还会输出 `records.sleep.bedtime` 和 `records.sleep.wakeTime`。归档日期不要和醒来日期混为一谈。

当前程序对 `imageType=sleep` 使用 `resolveSleepArchiveDate()`：

- 优先从 `records.sleep.wakeTime` 提取醒来日期。
- 如果 `wakeTime` 只有 `M/D`，会结合 Telegram 消息年份补全年份。
- 如果 `wakeTime` 没有日期，再使用 `detectedDate`。
- 得到醒来日期后减一天，作为 `archivedDate`。
- 如果只有 `06:40` 这类纯时间，且截图没有可靠日期，批次会跳过。

例子：

- 睡眠截图显示 `2026-06-05 06:40` 醒来，最终归档到 `2026-06-04`。
- 睡眠截图只显示 `6/5 06:40`，Telegram 消息年份为 2026，最终归档到 `2026-06-04`。
- 睡眠截图只有 `06:40`，没有日期或日期范围，不能仅凭消息发送时间归档。

`dateSources.source=sleep_bedtime` 表示这条日期来自睡眠时间语义换算；名称保留了早期实现命名，维护时按“睡眠醒来日期减一天”理解即可。

## 8. 维护时最容易误判的地方

### 8.1 “文件名里明明有日期，为什么没用上”

先看消息是 `document` 还是 `photo`：

- `document` 才通常有原始 `file_name`
- `photo` 常常没有原始 `file_name`

所以“用户手机里文件名有日期”不等于“Bot API 一定拿到了文件名”。

### 8.2 “prompt 明明禁止用文件名，为什么最后还是按文件名归档了”

因为这里分两层：

- AI 不允许直接用 Telegram 外部文件名猜 `detectedDate`
- 但程序后处理允许在图片无日期时，用 Telegram 原始文件名做 `archivedDate` 回退

这两层是故意分开的。

### 8.3 “截图里看到了文件名，算不算图片日期”

算，但前提是：

- 文件名文字真的出现在截图画面里
- 属于相册详情页、文件详情页、分享预览页这类可见界面

这种情况本质上仍然是 OCR 识别图片内容，不是读取 Telegram 外部元数据。

### 8.4 “睡眠图明明是 6 月 5 日，为什么归到 6 月 4 日”

这是预期行为。夜间睡眠跨午夜，系统把醒来日期减一天后作为睡眠归档日，便于把这段睡眠和前一晚的恢复状态关联起来。

如果这不是夜间睡眠，而是午睡或小睡，需要确认截图是否明确显示午睡/小睡，以及 `records.sleep.sleepType` 是否被识别正确。

## 9. 排查顺序建议

遇到日期错误或跳过时，建议按这个顺序看：

1. 看 `batch.status` 是 `ready` 还是 `skipped`
2. 看 `reason` 是 `conflicting detected dates`、`conflicting filename dates`，还是 `no reliable image or filename date`
3. 看 `warnings` 里有没有“图片内未见可靠日期”或“以 photo 形式发送”
4. 看这条消息在 Telegram 里是按 `photo` 还是 `document` 发的
5. 看图片里是否真的出现了可见日期，或者是否出现了相册详情页里的文件名日期
6. 如果只出现月日，看 Telegram 消息年份是否能补全为合法日期
7. 看同一相册里的多张图是不是混入了不同日期

## 10. 改逻辑时要同步改哪些地方

如果将来调整日期归档规则，至少要一起检查：

- `prompts/telegram-training-image-recognition.md`
- `tools/telegram-sync-lib.mjs`
- `tools/telegram-sync-dates.mjs`
- `tools/telegram-sync.mjs`
- `test/telegram-sync.test.mjs`
- `test/telegram-sync-runner.test.mjs`
- `docs/训练系统/Telegram睡眠识别与入库说明.md`

最低验证命令：

```bash
npm test -- test/telegram-sync.test.mjs test/telegram-sync-runner.test.mjs
```

## 11. 一句话结论

当前系统的日期判定口径可以概括为：

- 先信图片里真实可见的日期
- 图片里没有，再尝试 Telegram 原始文件名日期
- `photo` 往往拿不到原始文件名，`document` 更适合依赖文件名回退
- 同一批次只要出现多种冲突日期，就宁可跳过，也不冒险错归档
- 睡眠图按醒来日期减一天归档，不能直接套用普通图片日期
