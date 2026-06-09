# 数据统一与六边形架构重构 v13

本方案集是系统从"模块化分层"进化到"PostgreSQL 单一事实源 + 六边形架构"的完整路线图。不为兼容性妥协，不为重构成本退缩——目标是最干净的架构终态。

## 阅读顺序

1. [Phase A：数据层清理与验证](./Phase_A_数据层统一方案.md)（建议 1 周）
2. [Phase B：六边形架构重构](./Phase_B_六边形架构重构方案.md)（建议 6–8 周）
3. [Phase C：架构决策与延伸](./Phase_C_架构决策与延伸方案.md)（持续演进）
4. [实施 Checklist](./实施checklist.md)（编码时逐项勾选）

## 前置依赖

本方案集承接以下历史版本：

- **v10**（数据库唯一事实源与 Markdown 备份）：确立了 PostgreSQL 为唯一事实源的原则
- **v12**（MCP 删除与数据库结构对齐）：完成了架构减法，删除 MCP 层，明确了 `sql/training_records/` 为结构基准

v13 是在 v10 和 v12 基础上的全面升级——从"做减法"进入"建新架构"。

## 当前代码现状（v13 起点）

**数据层状态**：PostgreSQL 已经是唯一事实源。`src/db/training/` 已经具备结构化的 Repository 层雏形（`read.mjs` / `write.mjs` / `archive.mjs`），所有写入路径已收敛到数据库。`db.json` 已退化为空文件，`runtime/` 目录仅剩 `telegram-sync-pending.ndjson`。SQLite 文件在项目中已不存在。

**领域层状态**：`src/domain/training/` 包含领域逻辑（`training-domain.mjs`、`training-parser.mjs`），但 `src/db/training/write.mjs`（1600+ 行）中仍然混杂了 SQL 生成、事务管理、领域逻辑（如 `mergeBatchIntoDay`、`buildTrainingDay`），这是 Phase B 的核心拆分目标。

**适配层状态**：`src/ai/` 已具备 Provider 适配器雏形（`provider.mjs` / `openai-compatible-provider.mjs`），`src/telegram/` 已具备 Telegram 命令处理层。但各模块之间依赖关系混乱，尚未形成清晰的 Port 接口边界。

## V13 核心目标

**Phase A 终态**：清理残留的数据层碎片（空 `db.json`、遗留 `runtime/` 文件），验证 PostgreSQL 数据一致性，确认无 SQLite/JSON 写入路径残留。

**Phase B 终态**：系统呈现清晰的四层结构——核心域（零外部依赖）、应用层（Use Cases）、适配器层（PostgreSQL / Telegram / AI / Hexo）、基础设施层（DI 容器 / 配置）。每一层只能通过 Port 接口依赖下一层。特别地，`write.mjs` 中的事务管理、SQL 生成、领域逻辑被拆分到各自层级。

## 格局声明

本方案拒绝以下"看似稳妥"的折中：

- 保留运行时 JSON/NDJSON 作为临时状态 → `runtime/` 中所有 JSON/NDJSON 文件必须迁移到 PostgreSQL 表或清理
- `write.mjs` 1600+ 行继续膨胀 → 必须拆分为 Repository 接口 + Adapter 实现 + 领域服务
- 保持现有模块边界 → 现有模块必须重组为 Core / Adapters / App / Infra 四层
- 因为"能用"就不重构 → 当前 `write.mjs` 的耦合（SQL + 事务 + 领域逻辑 + Telegram 批处理）会在数据量增长后集中爆发

目标架构的判断标准：如果今天从零搭建这个系统，会直接选择 PostgreSQL 单一事实源 + 六边形分层。v13 就是把系统推到那个终态。
