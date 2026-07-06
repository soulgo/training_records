# Training Records 文档

本目录是当前系统维护入口。当前事实只以代码、SQL、workflow、prompt source 和本目录的一线文档为准；历史重构记录只用于追溯背景。

## 快速导航

| 文档 | 作用 |
| --- | --- |
| [系统配置](01_系统配置/README.md) | dev/main 配置差异、GitHub Actions、Wrangler、Secret/Variable 读取位置。 |
| [系统核心逻辑](02_系统核心逻辑/README.md) | 架构、消息链路、AI 识别、数据入库、展示读取、Action 日志与失败补偿。 |
| [问题与排查](04_问题与排查/README.md) | PostgreSQL、OSS、Telegram、飞书、AI、Action 日志、部署和资源问题。 |
| [日常规则](05_日常规则/README.md) | dev/main 合并、后续规划落地和文档同步规则。 |
| [历史重构记录](03_历史重构记录/README.md) | 旧文档入口和历史方案归档，不作为当前操作入口。 |

## 推荐阅读路径

1. 先读 [系统总览](02_系统核心逻辑/系统总览.md)，理解 Telegram/飞书 -> Worker -> Queue -> Action -> AI -> DB -> Pages 的消息链路。
2. 配置或排查环境时读 [系统配置](01_系统配置/README.md)、[dev 配置](01_系统配置/dev.md) 和 [main 配置](01_系统配置/main.md)。
3. 排查同步结果时读 [Action 日志与失败补偿](02_系统核心逻辑/Action日志与失败补偿.md) 和 [Action 日志排查](04_问题与排查/Action日志.md)。
4. 查看 GitHub Actions 长期运行记录时打开站点 `/action-monitor/`，实现和排查入口见 [Action 日志与失败补偿](02_系统核心逻辑/Action日志与失败补偿.md)。
5. 做日常维护命令时使用 `npm run maintenance:inspect`、`npm run sync:db`、`npm run import:markdown`、`npm run export:markdown`、`npm run reconcile:markdown`、`npm run backfill:core` 和 `npm run backfill:thoughts`。

## 当前事实规则

- PostgreSQL `core.*` 是训练、饮食、体脂、睡眠、随想和展示读取的业务事实源。
- `ingest.*` 保存消息批次、识别结果、AI 调用日志和 pending 队列。
- `monitor.*` 保存 GitHub Actions run/job/step/failure 监控事实，驱动 `/action-monitor/`。
- `archive.*` 保存历史 Markdown 解析和归档。
- Markdown 是数据库派生备份，不是图片同步的主写入路径。
- 历史目录中的旧入口、旧配置和旧核心文档只能用于追溯，不得作为当前维护入口。

## 维护命令

| 命令 | 用途 |
| --- | --- |
| `npm run maintenance:inspect` | 只读巡检 pending 队列、AI monitoring、归档失败和单批次恢复目标。 |
| `npm run maintenance:inspect -- --batch-id <batchId>` | 只读审计单个批次的识别 JSON、core 目标和 `recoveryTargetDays`。 |
| `npm run sync:db` | 安全数据库修复入口。 |
| `npm run import:markdown` | 显式 Markdown 导入数据库。 |
| `npm run export:markdown` | 数据库导出 Markdown 备份。 |
| `npm run reconcile:markdown` | 显式 Markdown 与数据库对账。 |
| `npm run backfill:core` | 重放 archive 到 core。 |
| `npm run backfill:thoughts` | 随想 Markdown 回填 core。 |
