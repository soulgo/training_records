# 锻炼随想模块维护说明

这份文档专门说明当前“锻炼随想”页面和 Telegram `/thought` / `/随想` 同步链路的实现口径，方便后续维护、排查和交接。

## 1. 模块范围

当前“锻炼随想”模块包含两部分：

- 随想列表页：`/thoughts/`
- Telegram 命令 `/thought 正文` 和 `/随想 正文` 的自动归档，支持图片 caption

相关实现文件：

- `source/thoughts/index.md`
- `themes/cactus/layout/thoughts.ejs`
- `themes/cactus/source/css/thoughts.styl`
- `themes/cactus/layout/_partial/post/title.ejs`
- `tools/telegram-sync-lib.mjs`
- `tools/telegram-sync.mjs`

## 2. 页面展示规则

### 2.1 列表页 `/thoughts/`

当前列表页行为是：

- 保留页面标题“锻炼随想”
- 保留页面简介文案
- 删除顶部额外操作说明，不再展示“手工在 `source/_posts/` 新增 Markdown / Telegram 发送 `/thought`”那段文案
- 每条随想卡片展示：
  - 时间
  - 标签
  - 正文
  - 图片预览
- 当前不展示：
  - 卡片标题
  - 标题链接
  - “阅读全文”

正文当前直接使用 `post.content`，因为随想默认按短内容设计，不再依赖 excerpt。

### 2.2 单篇详情页

- 普通有标题文章仍按现状显示 H1
- 无标题 Telegram 随想详情页不会渲染空 H1
- 详情页正文、时间、标签等其余结构保持主题默认行为

## 3. Telegram `/thought` / `/随想` 的输入与输出

### 3.1 输入规则

- 识别 Telegram 文本消息的 `text`
- 识别图片/相册消息的 `caption`
- 命令格式必须是：

```text
/thought 正文
/随想 正文
```

- 只支持 `/thought` 和 `/随想`，不支持 `/thoughts`
- 命令后必须有正文；只有命令本身或只有空白会被跳过
- 推荐带图随想发送方式：发送图片或相册，并在 caption 写 `/随想 正文` 或 `/thought 正文`
- 图片 caption 被识别为随想后，不会进入训练/饮食/体脂截图 AI 识别
- 如果后续直接编辑原 Telegram 随想消息，`edited_message` 会按同一个 `telegram_message_id` 覆盖对应 Markdown 正文
- 如果是回复到已存在随想的修订消息，且正文仍以 `/thought` 或 `/随想` 开头，也会按回复目标覆盖原 Markdown，而不是新建一条
- 如果要删除，支持两种命令：

```text
/随想删
/随想删 126
```

- 第一种需要回复原随想消息发送；第二种里的 `126` 是原随想的 Telegram message id

### 3.2 生成的 Markdown 文件

当前 Telegram 随想会写到：

```text
source/_posts/YYYY-MM-DD-telegram-thought-<messageId>.md
```

文件名中的日期来自消息时间，时区按 `Asia/Shanghai` 处理。

当前 front matter 结构：

```yaml
---
date: 2026-05-14 10:30:00
tags:
  - 训练
  - 随想
  - Telegram
telegram_message_id: 501
telegram_chat_id: 42
photos:
  - /images/thoughts/2026/05/2026-05-14-telegram-thought-501-1.jpg
---
```

正文直接写命令后面的文本内容。没有图片时不会生成 `photos`。

### 3.3 图片保存规则

- Telegram `photo` 会取最大尺寸
- image document 会按文件形式保存
- 图片写到：

```text
source/images/thoughts/YYYY/MM/YYYY-MM-DD-telegram-thought-<messageId>-<index>.<ext>
```

### 3.4 当前不会生成 `title`

这是当前实现里最容易被误判的点：

- Telegram `/thought` / `/随想` 生成的 Markdown 当前不写 `title`
- `analyzeTelegramBatch()` 返回的 `thought` 结构当前也没有 `title`
- 列表页不展示标题
- 详情页对无标题内容做了兼容，不会显示空标题

注意：

- 手工写的历史随想仍然可以保留 `title`
- 站点 permalink 当前不需要因为这件事改动；现有 URL 仍可稳定生成

## 4. `/thought` / `/随想`、`/analysis` 与图片同步的区别

当前 Telegram 同步里，图片批次、thought 批次和 analysis 批次是三套路径：

- 图片批次：
  - 需要 AI 识别
  - 可能回退写 `训练记录.md`
  - 参与训练/饮食/体脂归档

- `/thought` / `/随想` 批次：
  - 不走 AI 图片识别
  - 不写 `训练记录.md`
  - 直接写 `source/_posts`
  - 若带图，同时写 `source/images/thoughts`
  - 然后尝试写 PostgreSQL
  - 如果 PostgreSQL 失败，保留已写出的 Markdown，并写入 `runtime/telegram-sync-pending.ndjson` 等待重放
  - 编辑原消息时会更新已有 Markdown 正文
  - 删除命令会删除对应 Markdown；若 front matter 里有 `photos`，会一起删除对应图片文件

- `/analysis` / `/分析` 批次：
  - 不走 AI 图片识别
  - 不写 `训练记录.md`
  - 不写 `source/_posts`
  - 不写 PostgreSQL
  - 基于现有 `TrainingSnapshot` 调用 AI 生成短建议
  - 只通过 Telegram `sendMessage` 回发结果

`/analysis` 的完整维护说明见 `docs/telegram-analysis.md`。

## 5. 环境变量注意事项

虽然 `/thought` / `/随想` 本身不需要图片识别、`/analysis` 本身也不写数据库，但当前 `npm run sync:telegram` 入口仍会统一校验以下环境变量：

- `TELEGRAM_BOT_TOKEN`
- `AI_API_KEY`
- `AI_BASE_URL`
- `AI_MODEL`
- `TELEGRAM_ALLOWED_CHAT_IDS`
- `TRAINING_DB_ENABLED`
- `TRAINING_DB_URL`

也就是说，即使这次只想处理文字随想，当前 workflow / 本地环境里仍不能缺这些变量。

## 6. 历史数据维护口径

如果要批量清理历史 Telegram 随想的 `title`，当前建议只处理可明确识别的文件：

- 文件名匹配 `*-telegram-thought-*.md`
- 并且 front matter 含 `telegram_message_id` 或 `telegram_chat_id`

不要自动清理：

- 手工维护的随想
- 非 Telegram 来源的普通文章
- 无法明确识别来源的历史内容

## 7. 修改这个模块时要同步改哪些地方

如果后续调整“锻炼随想”展示或 `/thought` / `/随想` 写入格式，至少要一起检查：

- `source/thoughts/index.md`
- `source/images/thoughts/`
- `themes/cactus/layout/thoughts.ejs`
- `themes/cactus/source/css/thoughts.styl`
- `themes/cactus/layout/_partial/post/title.ejs`
- `tools/telegram-sync-lib.mjs`
- `tools/telegram-sync.mjs`
- `test/thoughts-page.test.mjs`
- `test/telegram-sync.test.mjs`
- `test/telegram-sync-runner.test.mjs`

## 8. 最低验证命令

```bash
node --test test/telegram-sync.test.mjs test/telegram-sync-runner.test.mjs test/thoughts-page.test.mjs test/github-workflows.test.mjs
npm run build
```

## 9. 一句话总结

当前“锻炼随想”模块的核心规则可以概括为：

- 列表页按“短内容直出”展示
- Telegram `/thought` / `/随想` 直接生成无标题 Markdown 随想，可附带图片
- 编辑原 Telegram 随想消息会覆盖页面正文，`/随想删` 可删除对应随想和图片
- 无标题随想详情页不显示空 H1
- 数据库失败时保留随想文件，并通过 pending queue 补偿入库
