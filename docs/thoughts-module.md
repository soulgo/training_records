# 锻炼随想模块维护说明

这份文档专门说明当前“锻炼随想”页面和 Telegram `/thought` / `/随想` 同步链路的实现口径，方便后续维护、排查和交接。

## 1. 模块范围

当前“锻炼随想”模块包含两部分：

- 随想列表页：`/thoughts/`
- Telegram 命令 `/thought 正文` 和 `/随想 正文` 的自动归档，支持图片 caption
- PostgreSQL 正文镜像：`core.thought` 保存正文、Telegram 元数据、Markdown 路径和有序图片引用；图片文件仍在本地目录

相关实现文件：

- `source/thoughts/index.md`
- `themes/cactus/layout/thoughts.ejs`
- `themes/cactus/source/css/thoughts.styl`
- `themes/cactus/layout/_partial/post/title.ejs`
- `tools/telegram-sync-lib.mjs`
- `tools/telegram-sync.mjs`
- `tools/training-db-core.mjs`
- `sql/pgsql17.sql`

## 2. 页面展示规则

### 2.1 列表页 `/thoughts/`

当前列表页行为是：

- 保留页面标题“锻炼随想”
- 保留页面简介文案
- 删除顶部额外操作说明，不再展示“手工在 `source/_posts/` 新增 Markdown / Telegram 发送 `/thought`”那段文案
- 每条随想卡片展示：
  - 时间
  - 标签
  - Telegram message id（形如 `#126`，用于编辑或删除时精确定位）
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

### 3.2 页面上的 ID 怎么用

随想列表页每条 Telegram 随想会在标签右侧展示一个 `#id`，例如 `#126`。这个数字就是 Markdown front matter 里的 `telegram_message_id`，也是 Telegram 原消息的 `message_id`。

它的用途是：

- 删除某条随想时，可以直接发送 `/随想删 126`
- 编辑某条随想时，可以直接发送 `/随想编 126 新正文`
- 排查或手工维护时，可以快速定位 `source/_posts/*-telegram-thought-126.md`
- 回复式编辑时，可以确认你回复的是哪条随想

### 3.3 编辑随想

当前支持三种编辑方式。

第一种是直接编辑原 Telegram 消息：

```text
把原来的 `/随想 今天骑行 40 公里` 这条 Telegram 消息直接编辑成新的正文
```

同步器收到 Telegram 的 `edited_message` 后，会用同一个 `telegram_message_id` 找到对应 Markdown，只替换正文，不新建随想文件。

第二种是回复原随想消息发送修订版：

```text
/随想 今天骑行 40 公里，温地公园是一个散步的好地方。
```

这种方式必须回复一条已经归档过的随想消息。同步器会读取 `reply_to_message.message_id`，把它作为目标 ID，并覆盖对应 Markdown 正文。回复消息自己的 `message_id` 只用于本次同步批次，不会生成新的 `telegram-thought-<回复消息id>.md`。

注意：

- 回复式编辑的正文仍然必须以 `/thought` 或 `/随想` 开头
- 如果没有回复到已归档随想，系统会把它当成一条新的随想
- 编辑只更新 Markdown 正文；原有日期、标签、`telegram_message_id`、图片 front matter 会保留

第三种是通过页面上的 ID 显式编辑：

```text
/随想编 126 今天骑行 40 公里，温地公园是一个散步的好地方。
```

这里的 `126` 就是页面上显示的 `#126`。同步器会直接找到 `telegram_message_id: 126` 的随想并替换正文。

如果 `/随想编` 这条消息带图片或相册 caption，系统会把该随想原有图片替换成这次发送的新图片：

- 旧 Markdown 的 `photos` 会改成新图片路径
- 旧图片文件会从 `source/images/thoughts/` 删除
- 新图片仍沿用被编辑随想的原始日期和原始 ID 命名，例如 `2026-05-17-telegram-thought-126-1.jpg`

`/随想编` 的正文格式必须是：

```text
/随想编 <id> <编辑后的完整正文>
```

目前也兼容 `/thought-edit`、`/thoughtedit`、`/edit-thought`、`/编随想` 这些英文或倒序别名，但产品使用上推荐统一用 `/随想编`。

### 3.4 删除随想

删除支持两种命令：

```text
/随想删
/随想删 126
```

- `/随想删`：需要回复原随想消息发送，系统用被回复消息的 `message_id` 定位要删的随想
- `/随想删 126`：不需要回复，系统直接用页面上看到的 `#126` 定位要删的随想
- 删除命令会删除对应 Markdown 文件；如果 front matter 里有 `photos`，会一起删除对应图片文件
- 删除命令只识别普通文字消息的 `text`，不识别图片 caption
- 如果目标 ID 找不到对应随想，本次同步会记录为 `not_found`，不会删除其他内容

### 3.5 生成的 Markdown 文件

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

### 3.6 图片保存规则

- Telegram `photo` 会取最大尺寸
- image document 会按文件形式保存
- 图片写到：

```text
source/images/thoughts/YYYY/MM/YYYY-MM-DD-telegram-thought-<messageId>-<index>.<ext>
```

- PostgreSQL 只保存图片引用，例如 `/images/thoughts/YYYY/MM/...jpg`；不保存图片二进制
- 后续迁移到腾讯云 OSS 时，正文 schema 不需要变化，只需要把图片写入后端和引用生成逻辑换成对象键或 URL

### 3.7 当前不会生成 `title`

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
  - 写 `source/_posts` 作为当前 Markdown 兼容层
  - 若带图，同时写 `source/images/thoughts`
  - 然后尝试把随想正文、Telegram 元数据、Markdown 路径和图片引用镜像到 PostgreSQL `core.thought`
  - 如果 PostgreSQL 失败，保留已写出的 Markdown，并写入 `runtime/telegram-sync-pending.ndjson` 等待重放
  - 编辑原消息时会更新已有 Markdown 正文，并同步更新 `core.thought.body`
  - 回复已有随想并发送 `/thought` / `/随想` 修订版时，也会更新已有 Markdown 正文和 DB 正文
  - 发送 `/随想编 <id> <正文>` 会按 ID 更新已有 Markdown；如果带图，会替换原图片并更新 DB 图片引用
  - 删除命令会删除对应 Markdown；若 front matter 里有 `photos`，会一起删除对应图片文件；DB 中对应行标记为 `deleted`

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
- 页面展示 Telegram message id，便于精确编辑和删除
- Telegram `/thought` / `/随想` 直接生成无标题 Markdown 随想，可附带图片
- 直接编辑原 Telegram 消息、回复已有随想发送 `/thought` / `/随想` 修订版，或发送 `/随想编 <id> <正文>`，都会覆盖原随想正文
- `/随想编 <id> <正文>` 如果带图，会替换该随想原有图片
- `/随想删` 或 `/随想删 <id>` 可删除对应随想和图片
- 无标题随想详情页不显示空 H1
- 数据库失败时保留随想文件，并通过 pending queue 补偿入库
