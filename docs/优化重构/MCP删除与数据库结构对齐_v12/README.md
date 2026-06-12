# MCP 删除与数据库结构对齐 v12

本文档集用于评估下一轮“做减法”改造。当前范围包含两件事：删除系统 MCP 功能及其直接绑定的 Telegram `/ai` / `/智能助手` 入口；把 `sql/pgsql17.sql` 与 `sql/training_records/` 下的各 schema 表结构对齐，并以 `sql/training_records/` 为准。

## 阅读顺序

1. [架构减法审计与格局判断](./架构减法审计与格局判断_v12.md)
2. [删除与收敛清单](./删除与收敛清单_v12.md)

## V12 结论摘要

V12 的核心判断是：系统已经从“Markdown 训练记录 + 多入口兼容”进入“PostgreSQL core.* 事实源 + Telegram 图片入库 / `/analysis` / 站点构建三条主链路”的稳定期。`/ai` / `/智能助手` 是独立 Agent 入口，不参与 Telegram 图片发送入库，也不是 `/analysis` 的必要路径；它当前依赖 MCP，因此应随 MCP 一起删除。

推荐优先级：

1. 删除 MCP stdio server、MCP tool catalog、MCP 配置项、MCP 使用文档和 MCP 测试。
2. 删除 Telegram `/ai` / `/智能助手` 命令入口、`tools/telegram-ai-agent.mjs`、`ai_agent` 分支、help text 和相关测试；确认不影响 Telegram 图片发送入库与 `/analysis`。
3. 更新 README、长期 docs、help text 和排障文档，把 MCP 与 `/ai` Agent 从当前系统能力中移除。
4. 以 `sql/training_records/` 为当前数据库结构基准，检查并修正 `sql/pgsql17.sql`，确保总初始化脚本与 `core.sql`、`ingest.sql`、`archive.sql`、`core_sleep.sql`、`sleep_health_metrics.sql` 的最终结构一致。
5. 在审计确认后，再考虑 pending 队列、`tools/` re-export、Markdown 回灌、archive 回填等其它减法项；这些不是本轮两个澄清要求的 P0。

## 不在本轮建议删除的复杂度

- `core.*` 事实源和增量 upsert。
- `ingest.*` 审计层、识别缓存和 AI 失败重试。
- Cloudflare Worker + GitHub Actions 的 Telegram dispatch 链路。
- DB -> Markdown 备份。
- `/analysis` 训练分析入口。
- Telegram 图片发送、相册处理、AI 图片识别、随想入库和 `/analysis` 不属于 `/ai` Agent 链路，不应被误删。
- `sql/training_records/` 不是历史资料，本轮把它定义为当前数据库结构基准。
