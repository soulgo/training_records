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
10. `Action日志与失败补偿.md`
11. `数据库模型.md`

## 源码事实入口

| 领域 | 源码入口 |
| --- | --- |
| Telegram 同步 | `src/app/use-cases/telegram-sync.use-case.mjs` |
| 飞书同步 | `src/app/use-cases/feishu-sync.use-case.mjs` |
| 消息分组和命令解析 | `src/adapters/telegram/sync-batch-logic.adapter.mjs`、`src/adapters/feishu/sync-batch-logic.adapter.mjs` |
| AI 图片识别 | `src/app/use-cases/image-recognition.use-case.mjs`、`src/core/ai/telegram-recognition-schema.mjs` |
| Prompt | `prompts/telegram-training-image-recognition.md`、`prompts/training-analysis.md` |
| PostgreSQL 写入 | `src/db/training/write.mjs`、`src/adapters/postgres/*` |
| 数据读取和快照 | `src/domain/training/training-snapshot.mjs`、`src/db/training/read*.mjs` |
| GitHub Action 监控 | `tools/report-github-action-status.mjs`、`tools/github-action-monitor-server.mjs`、`src/app/use-cases/github-action-monitor.use-case.mjs`、`src/adapters/postgres/github-action-monitor-repository.pg.mjs` |
| 系统参数有效期监控 | `config/parameter-validity/<env>.json`、`tools/check-parameter-validity.mjs`、`src/app/use-cases/parameter-validity-monitor.use-case.mjs`、`src/adapters/postgres/parameter-validity-monitor-repository.pg.mjs` |
| 站点生成 | `tools/generate-training-data.mjs`、`src/site/dashboard-view.mjs`、`themes/cactus/*` |
| Worker 入口 | `cloudflare/sync-dispatch-worker.mjs`、`cloudflare/*dispatch-worker.mjs`、`cloudflare/sync-dispatch-queue.mjs` |
| SQL schema | `sql/pgsql17.sql` |

## 不变量

- PostgreSQL `core.*` 是训练、饮食、体脂、睡眠、随想和展示读取的业务事实源。
- `ingest.*` 保存消息、识别、AI 调用日志和 pending 批次。
- `monitor.*` 保存 GitHub Actions run/job/step/failure 和系统参数有效期监控事实，只存结构化安全摘要，不存业务 payload、日志正文、Secret 明文或参数值。
- `archive.*` 保存历史 Markdown 解析和归档。
- Telegram 和飞书共享同一套应用层同步逻辑；飞书先转换为 Telegram 形态的中间消息。
- 图片只有通过 schema、置信度、日期和业务校验后才会写入 `core.*`。
- `/分析` 只读取快照并回发，不写入训练事实。
