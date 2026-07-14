# 系统核心逻辑

本目录描述当前系统业务逻辑。所有流程均来自源码、SQL、workflow 和配置文件，不描述未实现规划。

## 阅读顺序

1. `系统总览.md`
2. `Telegram流程.md`
3. `飞书流程.md`
4. `图片识别逻辑.md`
5. `时间归档逻辑.md`
6. `数据入库流程.md`
7. `随想流程.md`
8. `查询展示逻辑.md`
9. `训练监控逻辑.md`
10. `训练分析逻辑.md`
11. `Action日志与失败补偿.md`
12. `数据库模型.md`

## 源码事实入口

| 领域 | 源码入口 |
| --- | --- |
| Telegram 同步 | `src/app/use-cases/telegram-sync.use-case.mjs`（CLI 装配入口）、`src/app/use-cases/message-sync.use-case.mjs`（渠道无关共享编排 `runMessageSync`） |
| 飞书同步 | `src/app/use-cases/feishu-sync.use-case.mjs`（复用 `message-sync.use-case.mjs` 共享编排） |
| 消息分组和命令解析 | `src/adapters/telegram/sync-batch-logic.adapter.mjs`、`src/adapters/feishu/sync-batch-logic.adapter.mjs` |
| AI 图片识别 | `src/app/use-cases/image-recognition.use-case.mjs`、`src/adapters/image/sharp-image-processor.mjs`、`src/adapters/ocr/openai-compatible-ocr.adapter.mjs`、`src/core/ai/normalized-recognition.mjs` |
| Prompt | `prompts/telegram-training-image-recognition.md`、`prompts/training-analysis.md` |
| PostgreSQL 写入 | `src/db/training/write.mjs`、`src/adapters/postgres/*` |
| 数据读取和快照 | `src/domain/training/training-snapshot.mjs`、`src/db/training/read*.mjs` |
| `/分析` 上下文 | `src/adapters/postgres/training-analysis-repository.pg.mjs`、`src/app/use-cases/training-analysis.impl.mjs` |
| GitHub Action 监控 | `tools/report-github-action-status.mjs`、`tools/github-action-monitor-server.mjs`、`src/app/use-cases/github-action-monitor.use-case.mjs`、`src/adapters/postgres/github-action-monitor-repository.pg.mjs` |
| 站点生成 | `src/app/use-cases/generate-training-data.use-case.mjs`、`src/site/dashboard-view.mjs`、`themes/cactus/*` |
| Worker 入口 | `cloudflare/sync-dispatch-worker.mjs`、`cloudflare/*dispatch-worker.mjs`、`cloudflare/sync-dispatch-queue.mjs` |
| SQL schema | `sql/dev-sql/`、`sql/main-sql/` |

## 不变量

- PostgreSQL `core.*` 是训练、饮食、体脂、睡眠、随想和展示读取的业务事实源。
- `ingest.*` 保存消息、识别、AI 调用日志和 pending 批次。
- `monitor.*` 保存 GitHub Actions run/job/step/failure 事实，只存结构化安全摘要，不存业务 payload、日志正文或 Secret 明文。
- `archive.*` 保存历史 Markdown 解析和归档。
- Telegram 和飞书共享同一套应用层同步逻辑；两个来源都直接生成来源无关消息，不再互相伪装平台事件。
- 图片只有通过 schema、置信度、日期和业务校验后才会写入 `core.*`。
- `/分析` 使用只读连接一次查询近 28 天训练上下文和当前训练者画像，只回发分析结果，不写入训练事实。
