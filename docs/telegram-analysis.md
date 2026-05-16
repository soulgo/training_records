# Telegram 训练分析指令

这份文档说明 Telegram `/analysis` / `/分析` 指令的当前实现口径。它用于临时问答式训练建议，不写 `docs/`，不写数据库，也不提交仓库内容。

## 1. 指令入口

支持两种命令：

```text
/analysis 今天怎么练
/分析 最近饮食怎么样
```

如果命令后没有问题，系统会使用默认问题：

```text
请根据最近训练、体脂、饮食数据给出今天/明天的训练建议
```

普通文本不会触发分析；只有 `TELEGRAM_ALLOWED_CHAT_IDS` 白名单内的 chat 会被处理。

## 2. 数据来源

分析基于现有 `TrainingSnapshot`：

- `TRAINING_SNAPSHOT_SOURCE=markdown` 时读取 `训练记录.md`
- `TRAINING_SNAPSHOT_SOURCE=database` 时读取 PostgreSQL `core.*`
- database 不可用时，是否回退取决于现有 snapshot 构建逻辑

分析模块会汇总最近 7 天和 30 天的：

- 训练频率、训练消耗、锻炼时长
- 骑行里程和活动类型
- 摄入热量
- 体重、体脂率、骨骼肌量趋势
- 最近 5 天概要

## 3. 输出规则

系统会调用 AI 生成适合 Telegram 阅读的短回复，并通过 `sendMessage` 回发到原 chat，优先回复到原始指令消息。

回复约束由 `prompts/training-analysis.md` 控制：

- 纯文本
- 控制在 Telegram 友好的长度
- 固定包含：数据结论、恢复风险、饮食观察、下一步行动
- 不编造缺失数据
- 不做医疗诊断

如果回复超过 Telegram 单条消息安全长度，系统会自动拆分为多条发送。

## 4. 与截图同步和 `/thought` 的区别

`/analysis` 批次：

- 不走图片识别
- 不写 `训练记录.md`
- 不写 `source/_posts`
- 不写 PostgreSQL
- 不进入 pending replay 队列
- 只生成一次 Telegram 回复

截图批次和 `/thought` 批次仍保持原有行为。

## 5. 相关实现文件

- `prompts/training-analysis.md`
- `tools/training-analysis.mjs`
- `tools/telegram-sync-lib.mjs`
- `tools/telegram-sync.mjs`
- `test/telegram-sync.test.mjs`
- `test/telegram-sync-runner.test.mjs`

## 6. 环境变量

当前入口沿用 `npm run sync:telegram` 的统一环境变量校验，至少需要：

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_CHAT_IDS`
- `AI_API_KEY`
- `AI_BASE_URL`
- `AI_MODEL`
- `TRAINING_DB_ENABLED`
- `TRAINING_DB_URL`

如果 `TRAINING_SNAPSHOT_SOURCE=database`，还需要确保 PostgreSQL 可访问并包含 `core.*` 数据。

## 7. 验证方法

```bash
node --test test/telegram-sync.test.mjs test/telegram-sync-runner.test.mjs
```

线上验证：

1. 给 Bot 发送 `/analysis 今天怎么练`
2. 在 GitHub Actions 确认 `Telegram Sync` 被触发
3. 确认 Telegram 收到分析回复
4. 确认本次不会产生 `训练记录.md`、`source/_posts` 或 `docs/` 同步提交
