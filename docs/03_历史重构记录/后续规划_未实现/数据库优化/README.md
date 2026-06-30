# 数据库优化后续规划

> 审核日期：2026-06-30  
> 范围：PostgreSQL 连接、读写、数据安全、Markdown 存储迁移  
> 目标：把后续数据库优化拆成高 / 中 / 低三个可执行优先级，方便程序员按文档实现、审计和验收。

## 当前事实源

本目录所有结论都必须以当前代码、配置文档和 SQL DDL 为准。后续实现前先复核这些来源：

| 来源 | 重点 |
| --- | --- |
| `docs/01_系统配置/` | main/dev 的 `TRAINING_DB_*`、`DEV_TRAINING_DB_URL`、`TRAINING_SNAPSHOT_SOURCE`、Markdown Backup 变量和 Worker/GitHub Secret 规则。 |
| `docs/02_系统核心逻辑/` | 数据库模型、数据入库、查询展示、Action 日志与失败补偿、维护命令边界。 |
| `sql/training_records/` | 当前拆分后的 `archive`、`ingest`、`core` schema 表结构、主键、索引和外键。 |
| `sql/pgsql17.sql` | 完整初始化脚本、拆分后的数据库角色、grant、索引和 schema 基准。 |
| `src/db/training/`、`src/adapters/postgres/`、`tools/` | 真实连接、读取、写入、schema preflight、导入导出和维护入口。 |

## 优先级索引

| 优先级 | 文档 | 为什么排在这里 |
| --- | --- | --- |
| 高 | [01_高优先级_权限收敛与运行时DDL下线.md](01_高优先级_权限收敛与运行时DDL下线.md) | 直接影响数据库安全边界。运行时 DDL 默认下线、显式 migration 和初始化脚本角色拆分已落地；真实 dev/main 账号切换与权限验证仍需执行。 |
| 中 | [02_中优先级_连接池与读取性能优化.md](02_中优先级_连接池与读取性能优化.md) | 影响同步和构建稳定性。当前读取快照会固定创建 6/5 个 `pg.Client`，主快照 SQL 仍是全量读取。 |
| 低 | [03_低优先级_Markdown迁移与备份治理.md](03_低优先级_Markdown迁移与备份治理.md) | PostgreSQL 唯一事实源是目标方向，但当前构建、备份和人工恢复仍依赖 Markdown 兼容层，需要在安全和性能收敛后推进。 |

## 总体路线

1. 先做高优先级：拆分 DB 角色，迁出运行时 DDL，确认业务账号最小权限后仍能同步、构建、导出和回放 pending。
2. 再做中优先级：统一连接 factory/pool，下推日期范围查询，为读取链路补慢查询观测，降低连接峰值和全量读取放大。
3. 最后做低优先级：让站点构建直接消费 PostgreSQL，Markdown 只保留为导出备份和显式人工恢复入口。

## 总体验收门槛

- [x] main/dev 配置仍与 `docs/01_系统配置/` 一致，Secret 不写入文档和日志。
- [x] `npm run maintenance:inspect` 能只读查看 pending、AI monitoring、单批次审计、数据库可用性和账号权限摘要。
- [x] `npm run sync:db -- --dry-run`、`npm run maintenance:migrate -- --dry-run` 能输出可审计计划。
- [ ] `npm run check:data-consistency` 作为每阶段数据库变更后的固定验收命令；命令已优先使用 `TRAINING_DB_READONLY_URL`，真实 dev/main 仍需执行通过。
- [x] Action summary 中 DB 字段仍只包含安全摘要，不出现 DB URL、SQL 参数、用户文本或 token。
